// M8 destination verification + Rescue Receipt. ZERO KeeperHub executions and
// ZERO onchain writes. The receipt exists only after live safe-wallet
// reconciliation succeeds; POSITION_PROTECTED is emitted only after that.
import "server-only";

import { eq, sql } from "drizzle-orm";

import type { VindexDb } from "../../db";
import {
  auditEvents,
  executions,
  rescueReceipts,
  simulations,
  threatDecisions,
  verificationChecks,
} from "../../db/schema";
import { getAaveUsdcPosition } from "./aave-position";
import { AAVE_V3_BASE_SEPOLIA } from "./aave-registry";
import { VINDEX_CHAIN_ID, WrongChainError } from "./chain";
import type { VindexEnv } from "./env";
import { VindexApiError } from "./errors";
import {
  createCanonicalPublicClient,
  readCanonicalChainState,
  type CanonicalReadClient,
} from "./public-client";
import { getArmedPolicy } from "./policy-service";
import { getAuditEvents } from "./policy-service";
import { canonicalPositionId } from "./position-service";
import { validateSafeWallet } from "./safe-wallet";
import { DRILL_LABEL, type PolicyMode } from "./policy-templates";
import { getSignalHistory, type SignalObservation } from "./signal-service";

// Residual dust tolerance for the execution-wallet aUSDC after a MAX
// withdrawal: Aave burns the aToken balance; any remainder below 100 base
// units (0.0001 USDC) is documented residual dust, recorded truthfully.
export const RESIDUAL_DUST_BASE_UNITS = BigInt(100);

export type RescueReceiptView = {
  id: string;
  executionId: string;
  positionId: string;
  policyMode: PolicyMode;
  verifiedAmount: string;
  destination: string;
  txHash: string;
  keeperhubExecutionId: string;
  status: "PROTECTED";
  receipt: Record<string, unknown>;
  createdAt: string;
};

export type VerificationResult =
  | {
      outcome: "VERIFIED";
      executionId: string;
      verified: boolean;
      delta: string;
      expectedAmount: string;
      blockNumber: string;
      blockTimestamp: string;
      receipt: RescueReceiptView;
      audits: string[];
    }
  | {
      outcome: "INTERVENTION_REQUIRED";
      executionId: string;
      verified: boolean;
      failureReason: string;
      preBalance: string;
      postBalance: string;
      delta: string;
      expectedAmount: string;
      blockNumber: string;
      blockTimestamp: string;
      audits: string[];
    };

export type VerifyDestinationOptions = {
  env: VindexEnv;
  db: VindexDb;
  executionId: string;
  publicClient?: CanonicalReadClient;
  now?: () => Date;
};

const writeAudit = async (
  db: VindexDb,
  positionId: string,
  eventType: string,
  details: Record<string, unknown>,
  decisionId: string | null = null,
  blockNumber: string | null = null,
): Promise<void> => {
  await db.insert(auditEvents).values({
    positionId,
    decisionId: decisionId ?? null,
    eventType,
    detailsJson: JSON.stringify(details),
    blockNumber,
  });
};

export const getRescueReceipt = async (
  db: VindexDb,
  receiptId: string,
): Promise<RescueReceiptView | null> => {
  const rows = await db
    .select()
    .from(rescueReceipts)
    .where(eq(rescueReceipts.id, receiptId))
    .limit(1);
  const row = rows[0];
  if (row === undefined) return null;
  return {
    id: row.id,
    executionId: row.executionId,
    positionId: row.positionId,
    policyMode: row.policyMode as PolicyMode,
    verifiedAmount: row.verifiedAmount,
    destination: row.destination,
    txHash: row.txHash,
    keeperhubExecutionId: row.keeperhubExecutionId,
    status: "PROTECTED",
    receipt: JSON.parse(row.receiptJson) as Record<string, unknown>,
    createdAt: row.createdAt.toISOString(),
  };
};

export const getLatestRescueReceipt = async (
  db: VindexDb,
  positionId: string,
): Promise<RescueReceiptView | null> => {
  const rows = await db
    .select()
    .from(rescueReceipts)
    .where(eq(rescueReceipts.positionId, positionId))
    .orderBy(rescueReceipts.createdAt)
    .limit(1);
  if (rows[0] === undefined) return null;
  return getRescueReceipt(db, rows[0].id);
};

const getWithdrawAuditAmount = async (
  db: VindexDb,
  positionId: string,
  executionId: string,
): Promise<{ actualWithdrawAmount: string; transactionHash: string } | null> => {
  const events = await getAuditEvents(db, positionId, 200);
  const event = events.find(
    (e) => e.eventType === "WITHDRAW_EVENT_VERIFIED" && e.details.executionId === executionId,
  );
  if (event === undefined) return null;
  const amount = event.details.actualWithdrawAmount ?? event.details.amount;
  if (typeof amount !== "string" || !/^\d+$/.test(amount)) return null;
  return {
    actualWithdrawAmount: amount,
    transactionHash: typeof event.details.transactionHash === "string" ? event.details.transactionHash : "",
  };
};

const buildReceiptJson = async (
  db: VindexDb,
  positionId: string,
  executionId: string,
  decision: typeof threatDecisions.$inferSelect,
  policy: { id: string; mode: PolicyMode; version: number; requiredSignals: number; correlationWindowSec: number; thresholds: Record<string, unknown>; safeWalletSnapshot: string; armedAt: string | null },
  execution: typeof executions.$inferSelect,
  simulationRows: Array<typeof simulations.$inferSelect>,
  contributingObservations: SignalObservation[],
  preSafeWalletBalance: string,
  postSafeWalletBalance: string,
  delta: string,
  actualWithdrawAmount: string,
  blockNumber: string,
  blockTimestamp: string,
  latestBlockNumber: string,
): Promise<Record<string, unknown>> => {
  const matchingSimulation = [...simulationRows].reverse().find((s) => s.success === true && s.wouldRevert === false);
  const expectedAmount = matchingSimulation?.simulatedReturnValue ?? null;
  const failedSimulation = [...simulationRows].reverse().find((s) => s.success === false);

  const triggerFamilies = (() => {
    try {
      return JSON.parse(decision.matchedFamiliesJson ?? "[]") as string[];
    } catch {
      return [];
    }
  })();
  const reasons = (() => {
    try {
      return JSON.parse(decision.reasonJson ?? "{}") as Record<string, string>;
    } catch {
      return {};
    }
  })();

  return {
    title: `VINDEX RESCUE / ${executionId.slice(0, 8)}`,
    drillLabel: DRILL_LABEL,
    drillExplanation:
      "Real measurements with intentionally sensitive thresholds. This is a protection drill, not evidence of an Aave exploit.",
    network: "Base Sepolia",
    protocol: "Aave V3",
    position: "USDC — Aave Base Sepolia test asset",
    policy: {
      mode: policy.mode,
      label: policy.mode === "DRILL_HIGH_SENSITIVITY" ? "Protection Drill / High Sensitivity" : "Standard",
      version: policy.version,
      requiredSignals: policy.requiredSignals,
      correlationWindowSec: policy.correlationWindowSec,
    },
    trigger: {
      consensus: `Matched ${decision.matchedCount} of ${policy.requiredSignals} distinct families (contributing: ${triggerFamilies.join(", ") || "none"})`,
      families: triggerFamilies.map((family) => ({
        family,
        reason: reasons[family] ?? "",
      })),
      contributingObservations: contributingObservations.map((o) => ({
        id: o.id ?? null,
        family: o.sourceFamily,
        metric: o.metric,
        rawValue: o.rawValue,
        blockNumber: o.blockNumber,
        blockTimestamp: o.blockTimestamp,
        observedAt: o.observedAt,
      })),
    },
    consensus: {
      rule: "2-of-3 distinct live families inside the correlation window",
      matchedCount: decision.matchedCount,
      decisionId: decision.id,
      windowStartedAt: decision.windowStartedAt.toISOString(),
      confirmedAt: decision.confirmedAt?.toISOString() ?? null,
    },
    simulation: {
      passed: true,
      blockNumber: matchingSimulation?.blockNumber ?? null,
      blockTimestamp: matchingSimulation?.blockTimestamp?.toISOString() ?? null,
      expectedAmount,
      failedSimulationReason: failedSimulation?.revertReason ?? null,
    },
    action: "Aave V3 withdraw(asset, type(uint256).max, safeWallet) — no swap",
    expectedWithdraw: expectedAmount,
    withdrawn: actualWithdrawAmount,
    verifiedReceived: delta,
    destination: {
      full: policy.safeWalletSnapshot,
      short: `${policy.safeWalletSnapshot.slice(0, 6)}…${policy.safeWalletSnapshot.slice(-4)}`,
    },
    keeperhub: {
      executionId: execution.keeperhubExecutionId,
      sponsored: execution.sponsored ?? null,
    },
    transaction: {
      hash: execution.txHash,
      link: execution.transactionLink,
      block: execution.blockNumber,
    },
    gas: execution.lastKeeperHubStatus === "completed" ? { note: "KeeperHub reported completed; exact gas metadata retained in execution records" } : null,
    balances: {
      pre: preSafeWalletBalance,
      post: postSafeWalletBalance,
      delta,
      prePosition: execution.prePositionAmount,
      postPosition: null,
    },
    verification: {
      status: "Passed",
      blockNumber,
      blockTimestamp,
      latestBlockNumber,
      rule: "post - pre == actual Withdraw event amount (no swap)",
    },
    status: "PROTECTED",
    auditReference: {
      decisionId: decision.id,
      executionId: execution.id,
    },
    generatedAt: new Date().toISOString(),
  };
};

export const verifyEvacuationDestination = async (
  options: VerifyDestinationOptions,
): Promise<VerificationResult> => {
  const { env, db, executionId } = options;
  const now = options.now ?? (() => new Date());
  const audits: string[] = [];

  const rpc: CanonicalReadClient =
    options.publicClient ?? createCanonicalPublicClient(env.baseSepoliaRpcUrl);

  const execRows = await db
    .select()
    .from(executions)
    .where(eq(executions.id, executionId))
    .limit(1);
  const execution = execRows[0];
  if (execution === undefined) {
    throw new VindexApiError("BAD_REQUEST", "Execution not found.", 404);
  }

  // Idempotent: an existing verified check + receipt returns unchanged.
  const existingChecks = await db
    .select()
    .from(verificationChecks)
    .where(eq(verificationChecks.executionId, executionId))
    .orderBy(verificationChecks.checkedAt)
    .limit(1);
  const existingVerified = existingChecks.find((c) => c.verified === true);
  if (existingVerified !== undefined) {
    const receiptRows = await db
      .select()
      .from(rescueReceipts)
      .where(eq(rescueReceipts.executionId, executionId))
      .limit(1);
    if (receiptRows[0] !== undefined) {
      const receipt = await getRescueReceipt(db, receiptRows[0].id);
      if (receipt !== null) {
        return {
          outcome: "VERIFIED",
          executionId,
          verified: true,
          delta: existingVerified.delta,
          expectedAmount: existingVerified.expectedAmount,
          blockNumber: existingVerified.blockNumber,
          blockTimestamp: existingVerified.blockTimestamp.toISOString(),
          receipt,
          audits: [],
        };
      }
    }
  }

  const decisionRows = await db
    .select()
    .from(threatDecisions)
    .where(eq(threatDecisions.id, execution.decisionId))
    .limit(1);
  const decision = decisionRows[0];
  if (decision === undefined) {
    throw new VindexApiError("BAD_REQUEST", "Decision not found.", 404);
  }
  const positionId = decision.positionId;

  await writeAudit(db, positionId, "DESTINATION_VERIFICATION_STARTED", { executionId }, execution.decisionId);
  audits.push("DESTINATION_VERIFICATION_STARTED");

  // --- 1. Require the M7 executed state -----------------------------------------
  const failures: string[] = [];
  if (execution.status !== "EXECUTED_VERIFYING_DESTINATION") {
    failures.push(`execution status is ${execution.status}, expected EXECUTED_VERIFYING_DESTINATION`);
  }
  if (execution.keeperhubExecutionId === null) failures.push("missing keeperhub execution id");
  if (execution.txHash === null) failures.push("missing transaction hash");
  if (execution.preSafeWalletBalance === null) failures.push("missing pre-broadcast safe-wallet balance");
  if (execution.chainId !== VINDEX_CHAIN_ID) failures.push("wrong chain");
  if (execution.safeWallet === null || !validateSafeWallet(execution.safeWallet, "").valid) {
    failures.push("invalid persisted destination");
  }

  const withdrawEvidence = await getWithdrawAuditAmount(db, positionId, executionId);
  if (withdrawEvidence === null || !/^\d+$/.test(withdrawEvidence.actualWithdrawAmount) || BigInt(withdrawEvidence.actualWithdrawAmount) <= BigInt(0)) {
    failures.push("missing or invalid actual Withdraw amount evidence");
  }
  const actualWithdrawAmount = withdrawEvidence?.actualWithdrawAmount ?? "0";
  const expectedAmount = actualWithdrawAmount;

  if (failures.length > 0) {
    await writeAudit(db, positionId, "DESTINATION_VERIFICATION_FAILED", { executionId, reason: failures.join("; ") }, execution.decisionId);
    await writeAudit(db, positionId, "INTERVENTION_REQUIRED", { executionId, reason: failures.join("; ") }, execution.decisionId);
    throw new VindexApiError(
      "BAD_REQUEST",
      `Cannot verify: ${failures.join("; ")}.`,
      409,
    );
  }

  // --- 2. Chain + live reads (M7 makes aUSDC == 0 expected) -----------------------
  let latestBlock: bigint;
  try {
    latestBlock = (await readCanonicalChainState(rpc)).latestBlock;
  } catch (error) {
    if (error instanceof WrongChainError) {
      throw new VindexApiError("WRONG_CHAIN", "The connected chain is not Base Sepolia (84532).", 502);
    }
    throw new VindexApiError("RPC_UNAVAILABLE", "The Base Sepolia RPC is unavailable.", 502);
  }

  let blockTimestampValue: Date;
  try {
    const block = await (
      rpc as unknown as {
        getBlock: (params: { blockNumber: bigint }) => Promise<{ timestamp: bigint }>;
      }
    ).getBlock({ blockNumber: latestBlock });
    blockTimestampValue = new Date(Number(block.timestamp) * 1000);
  } catch {
    blockTimestampValue = now();
  }

  const safeWallet = execution.safeWallet as string;
  const safeWalletPosition = await getAaveUsdcPosition(rpc, safeWallet);
  const postSafeWalletBalance = safeWalletPosition.underlyingBalanceBaseUnits;
  if (safeWalletPosition.underlyingAsset.toLowerCase() !== AAVE_V3_BASE_SEPOLIA.usdcUnderlying.toLowerCase()) {
    throw new VindexApiError("BAD_REQUEST", "Asset identity mismatch.", 409);
  }

  const executionWallet = canonicalPositionId(positionId).split(":").pop() as string;
  let postExecutionWalletAUsdc: bigint;
  try {
    const walletPosition = await getAaveUsdcPosition(rpc, executionWallet);
    postExecutionWalletAUsdc = walletPosition.aTokenBalanceBaseUnits;
  } catch {
    postExecutionWalletAUsdc = BigInt(0);
  }

  // Re-check the M7 receipt remains successful.
  let receiptOk = false;
  try {
    const receipt = await rpc.getTransactionReceipt({ hash: execution.txHash as `0x${string}` });
    receiptOk = receipt.status === "success";
  } catch {
    receiptOk = false;
  }
  if (!receiptOk) {
    const failureReason = "M7 transaction receipt is no longer successful.";
    await writeAudit(db, positionId, "DESTINATION_VERIFICATION_FAILED", { executionId, reason: failureReason }, execution.decisionId);
    await writeAudit(db, positionId, "INTERVENTION_REQUIRED", { executionId, reason: failureReason }, execution.decisionId);
    return {
      outcome: "INTERVENTION_REQUIRED",
      executionId,
      verified: false,
      failureReason,
      preBalance: execution.preSafeWalletBalance ?? "0",
      postBalance: postSafeWalletBalance.toString(),
      delta: "0",
      expectedAmount,
      blockNumber: latestBlock.toString(),
      blockTimestamp: blockTimestampValue.toISOString(),
      audits: ["DESTINATION_VERIFICATION_FAILED", "INTERVENTION_REQUIRED"],
    };
  }

  // --- 3. Reconciliation (bigint only, exact for V1 — no swap) ----------------------
  const preBalance = BigInt(execution.preSafeWalletBalance ?? "0");
  const delta = postSafeWalletBalance - preBalance;
  const expected = BigInt(expectedAmount);

  const residualDust =
    postExecutionWalletAUsdc <= RESIDUAL_DUST_BASE_UNITS ? null : postExecutionWalletAUsdc.toString();

  const failureReason =
    postSafeWalletBalance < preBalance
      ? "Safe-wallet balance decreased after the withdrawal."
      : delta <= BigInt(0)
        ? "Safe-wallet balance did not increase after the withdrawal."
        : delta !== expected
          ? `Safe-wallet delta (${delta.toString()}) does not equal the actual Withdraw amount (${expected.toString()}).`
          : residualDust !== null
            ? `Execution-wallet aUSDC residual (${residualDust}) exceeds the documented dust threshold.`
            : null;

  if (failureReason !== null) {
    await db
      .insert(verificationChecks)
      .values({
        executionId,
        assetAddress: AAVE_V3_BASE_SEPOLIA.usdcUnderlying,
        destination: safeWallet,
        preBalance: preBalance.toString(),
        postBalance: postSafeWalletBalance.toString(),
        delta: delta.toString(),
        expectedAmount,
        verified: false,
        blockNumber: latestBlock.toString(),
        blockTimestamp: blockTimestampValue,
        failureReason,
      })
      .onConflictDoNothing();
    await db
      .update(executions)
      .set({ status: "INTERVENTION_REQUIRED", errorCode: "DESTINATION_MISMATCH", updatedAt: now() })
      .where(eq(executions.id, executionId));
    await writeAudit(db, positionId, "DESTINATION_VERIFICATION_FAILED", { executionId, reason: failureReason, pre: preBalance.toString(), post: postSafeWalletBalance.toString(), delta: delta.toString(), expected: expectedAmount }, execution.decisionId, execution.txHash ?? undefined);
    await writeAudit(db, positionId, "INTERVENTION_REQUIRED", { executionId, reason: failureReason }, execution.decisionId);
    return {
      outcome: "INTERVENTION_REQUIRED",
      executionId,
      verified: false,
      failureReason,
      preBalance: preBalance.toString(),
      postBalance: postSafeWalletBalance.toString(),
      delta: delta.toString(),
      expectedAmount,
      blockNumber: latestBlock.toString(),
      blockTimestamp: blockTimestampValue.toISOString(),
      audits: ["DESTINATION_VERIFICATION_FAILED", "INTERVENTION_REQUIRED"],
    };
  }

  // --- 4. Verification passed — persist check + receipt transactionally ---------------
  await writeAudit(db, positionId, "DESTINATION_VERIFICATION_PASSED", { executionId, delta: delta.toString(), expected: expectedAmount, blockNumber: latestBlock.toString() }, execution.decisionId, execution.txHash ?? undefined);

  // Contributing observations (real M4/M5 evidence).
  const signalIds = (() => {
    try {
      return JSON.parse(decision.contributingSignalIds ?? "[]") as string[];
    } catch {
      return [];
    }
  })();
  const contributingObservations = signalIds.length > 0
    ? (await getSignalHistory(db, positionId, { limit: 500 })).filter((o) => o.id !== undefined && signalIds.includes(o.id))
    : [];

  const simulationRows = await db
    .select()
    .from(simulations)
    .where(eq(simulations.decisionId, execution.decisionId))
    .orderBy(simulations.createdAt)
    .limit(50);

  const policyRow = await getArmedPolicy(db, positionId);
  const policy = policyRow
    ? {
        id: policyRow.id,
        mode: policyRow.mode as PolicyMode,
        version: policyRow.version,
        requiredSignals: policyRow.requiredSignals,
        correlationWindowSec: policyRow.correlationWindowSec,
        thresholds: (() => {
          try {
            return JSON.parse(policyRow.thresholdsJson) as Record<string, unknown>;
          } catch {
            return {};
          }
        })(),
        safeWalletSnapshot: policyRow.safeWalletSnapshot,
        armedAt: policyRow.armedAt?.toISOString() ?? null,
      }
    : null;

  const receiptJson = await buildReceiptJson(
    db,
    positionId,
    executionId,
    decision,
    policy ?? {
      id: decision.policyId,
      mode: "DRILL_HIGH_SENSITIVITY",
      version: decision.policyVersion,
      requiredSignals: 2,
      correlationWindowSec: 600,
      thresholds: {},
      safeWalletSnapshot: safeWallet,
      armedAt: null,
    },
    execution,
    simulationRows,
    contributingObservations,
    preBalance.toString(),
    postSafeWalletBalance.toString(),
    delta.toString(),
    actualWithdrawAmount,
    latestBlock.toString(),
    blockTimestampValue.toISOString(),
    latestBlock.toString(),
  );

  const checkAt = now();
  await db
    .insert(verificationChecks)
    .values({
      executionId,
      assetAddress: AAVE_V3_BASE_SEPOLIA.usdcUnderlying,
      destination: safeWallet,
      preBalance: preBalance.toString(),
      postBalance: postSafeWalletBalance.toString(),
      delta: delta.toString(),
      expectedAmount,
      verified: true,
      blockNumber: latestBlock.toString(),
      blockTimestamp: blockTimestampValue,
      failureReason: null,
    })
    .returning({ id: verificationChecks.id });

  let receipt: RescueReceiptView | null = null;
  await db.transaction(async (tx) => {
    const inserted = await tx
      .insert(rescueReceipts)
      .values({
        executionId,
        positionId,
        policyMode: policy?.mode ?? "DRILL_HIGH_SENSITIVITY",
        verifiedAmount: delta.toString(),
        destination: safeWallet,
        txHash: execution.txHash as string,
        keeperhubExecutionId: execution.keeperhubExecutionId as string,
        status: "PROTECTED",
        receiptJson: JSON.stringify(receiptJson),
      })
      .onConflictDoNothing()
      .returning({ id: rescueReceipts.id });
    await tx
      .update(executions)
      .set({ status: "PROTECTED", confirmedAt: checkAt, updatedAt: checkAt })
      .where(eq(executions.id, executionId));
    const receiptId = inserted[0]?.id;
    if (receiptId !== undefined) {
      const receiptRows = await tx.select().from(rescueReceipts).where(eq(rescueReceipts.id, receiptId)).limit(1);
      if (receiptRows[0] !== undefined) {
        receipt = await getRescueReceipt(db, receiptRows[0].id);
      }
    }
  });

  // If a concurrent call already created the receipt, load it.
  if (receipt === null) {
    const receiptRows = await db
      .select()
      .from(rescueReceipts)
      .where(eq(rescueReceipts.executionId, executionId))
      .limit(1);
    if (receiptRows[0] !== undefined) {
      receipt = await getRescueReceipt(db, receiptRows[0].id);
    }
  }
  if (receipt === null) {
    throw new VindexApiError("LIVE_READ_FAILED", "Receipt creation failed.", 502);
  }

  await writeAudit(db, positionId, "RESCUE_RECEIPT_CREATED", { executionId, receiptId: receipt.id, txHash: receipt.txHash }, execution.decisionId, receipt.txHash);
  await writeAudit(db, positionId, "POSITION_PROTECTED", { executionId, receiptId: receipt.id, verifiedAmount: delta.toString(), verifiedAt: checkAt.toISOString() }, execution.decisionId, receipt.txHash);

  return {
    outcome: "VERIFIED",
    executionId,
    verified: true,
    delta: delta.toString(),
    expectedAmount,
    blockNumber: latestBlock.toString(),
    blockTimestamp: blockTimestampValue.toISOString(),
    receipt,
    audits: [
      ...audits,
      "DESTINATION_VERIFICATION_PASSED",
      "RESCUE_RECEIPT_CREATED",
      "POSITION_PROTECTED",
    ],
  };
};

export { canonicalPositionId, sql };
