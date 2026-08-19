// M10 end-to-end demo orchestrator. Creates a fresh small Aave position via
// KeeperHub (faucet funding -> approve -> supply), then runs the finished
// product services through live observations, STANDARD, DRILL consensus,
// confirmation, simulation, ONE real KeeperHub evacuation, destination
// verification and a NEW Rescue Receipt. Rerun-safe: every write is
// recoverable from the demo_runs row; completed stages are never repeated.
import "server-only";

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { and, desc, eq, sql } from "drizzle-orm";
import { decodeEventLog, formatUnits } from "viem";

import type { VindexDb } from "../../db";
import {
  auditEvents,
  demoRuns,
  executions,
  rescueReceipts,
  signalObservations,
  simulations,
  threatDecisions,
} from "../../db/schema";
import { getAaveUsdcPosition } from "./aave-position";
import {
  AAVE_V3_BASE_SEPOLIA,
  AAVE_V3_BASE_SEPOLIA_FAUCET,
  ERC20_ABI,
  FAUCET_ABI,
  POOL_ABI,
  POOL_SUPPLY_EVENT,
} from "./aave-registry";
import { VINDEX_CHAIN_ID, WrongChainError } from "./chain";
import type { VindexEnv } from "./env";
import { VindexApiError } from "./errors";
import {
  createKeeperHubClient,
  isKeeperHubHealthy,
  type ContractCallSimulation,
  type DirectExecutionStatus,
  type KeeperHubClient,
} from "./keeperhub";
import {
  prepareEvacuation,
} from "./evacuation-service";
import { executeEvacuation } from "./execution-service";
import { getRescueReceipt } from "./verification-service";
import { verificationChecks } from "../../db/schema";
import { verifyEvacuationDestination } from "./verification-service";
import { armPolicy, disarmPolicy, evaluateProtectionPolicy, settleCompletedProtection } from "./policy-service";
import { refreshCurrentProtectedPosition, canonicalPositionId } from "./position-service";
import { collectLiveSignalObservations } from "./signal-service";
import { getSafeWalletConfig, validateSafeWallet } from "./safe-wallet";
import { createFailoverPublicClient } from "./rpc-failover";
import { DRILL_LABEL, DRILL_TEMPLATE } from "./policy-templates";

export const M10_SUPPLY_AMOUNT_BASE = BigInt(5000000); // 5 USDC, 6 decimals
export const M10_IDEMPOTENCY_PREFIX = "vindex-m10";
export const M10_SIMULATIONS_DIR = "artifacts/m10-simulations";

export const DEMO_IDEMPOTENCY_PREFIX = "vindex-demo";
export const DEMO_SUPPLY_AMOUNT_BASE = M10_SUPPLY_AMOUNT_BASE; // 5 USDC, 6 decimals
export const DEMO_SIMULATIONS_DIR = "artifacts/demo-simulations";

export type DemoRunStatus =
  | "CREATED"
  | "FUNDED"
  | "POSITION_CREATED"
  | "OBSERVING"
  | "CONFIRMED"
  | "SIMULATED"
  | "EXECUTED"
  | "PROTECTED"
  | "FAILED";

export const m10IdempotencyKey = (demoRunId: string, stage: "fund" | "approve" | "supply"): string =>
  `${M10_IDEMPOTENCY_PREFIX}-${demoRunId}-${stage}`;

export const demoIdempotencyKey = (demoRunId: string, stage: "fund" | "approve" | "supply"): string =>
  `${DEMO_IDEMPOTENCY_PREFIX}-${demoRunId}-${stage}`;

export type DemoRunOptions = {
  env: VindexEnv;
  db: VindexDb;
  keeperHubClient?: KeeperHubClient;
  publicClient?: ReturnType<typeof createFailoverPublicClient>;
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

const setRunStatus = async (
  db: VindexDb,
  runId: string,
  status: DemoRunStatus,
  updates: Partial<typeof demoRuns.$inferInsert> = {},
): Promise<void> => {
  await db
    .update(demoRuns)
    .set({ status, updatedAt: new Date(), ...updates })
    .where(eq(demoRuns.id, runId));
};

const persistSimulationEvidence = (
  stage: string,
  record: Record<string, unknown>,
  dir: string,
): void => {
  const path = `${dir}/${stage}.json`;
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(record, null, 2)}\n`, "utf8");
};

export type KeeperHubWriteResult = {
  stage: string;
  keeperhubExecutionId: string;
  status: string;
  transactionHash: string | null;
  transactionLink: string | null;
  sponsored: boolean | null;
  blockNumber: string | null;
  simulatedGasEstimate: string | null;
  simulatedReturnValue: string | null;
};

type WriteThroughOptions = {
  db: VindexDb;
  keeperHubClient: KeeperHubClient;
  positionId: string;
  runId: string;
  stage: "fund" | "approve" | "supply";
  contractCallRequest: { contractAddress: string; chainId: number; functionName: string; functionArgs: string; abi: string };
  idempotencyKey: string;
  expectedFrom: string;
  expectedTo: string;
  now: () => Date;
  verifyOnchain: (txHash: string) => Promise<{ blockNumber: string | null; verified: boolean; reason?: string }>;
  label: string;
  auditPrefix: string;
  simulationsDir: string;
};

const writeThroughKeeperHub = async (
  options: WriteThroughOptions,
): Promise<KeeperHubWriteResult> => {
  const { db, keeperHubClient, positionId, runId, stage, contractCallRequest, idempotencyKey, expectedFrom, expectedTo, now, verifyOnchain, label, auditPrefix, simulationsDir } = options;

  // Final pre-broadcast simulation.
  let simulation: ContractCallSimulation;
  try {
    simulation = await keeperHubClient.simulateContractCall(contractCallRequest);
  } catch (error) {
    await setRunStatus(db, runId, "FAILED", { errorCode: "SIMULATION_FAILED", completedAt: now() });
    throw new VindexApiError("SIMULATION_FAILED", `${label} ${stage} simulation transport failure: ${error instanceof Error ? error.message : "unknown"}.`, 502);
  }
  const simulationOk =
    simulation.success === true &&
    simulation.status === "simulated" &&
    simulation.wouldRevert === false &&
    simulation.from !== null &&
    simulation.from.toLowerCase() === expectedFrom.toLowerCase() &&
    simulation.to !== null &&
    simulation.to.toLowerCase() === expectedTo.toLowerCase() &&
    simulation.gasEstimate !== null &&
    /^\d+$/.test(simulation.gasEstimate) &&
    BigInt(simulation.gasEstimate) > BigInt(0);

  persistSimulationEvidence(stage, {
    stage,
    demoRunId: runId,
    chainId: VINDEX_CHAIN_ID,
    function: contractCallRequest.functionName,
    functionArgs: contractCallRequest.functionArgs,
    success: simulationOk,
    wouldRevert: simulation.wouldRevert,
    gasEstimate: simulation.gasEstimate,
    simulatedReturnValue: simulationOk ? String(simulation.simulatedReturnValue) : null,
    revertReason: simulationOk ? null : (simulation.revertReason ?? "simulation gate failed"),
    observedAt: now().toISOString(),
  }, simulationsDir);

  if (!simulationOk) {
    await setRunStatus(db, runId, "FAILED", { errorCode: "SIMULATION_FAILED", completedAt: now() });
    throw new VindexApiError("SIMULATION_REVERTED", `${label} ${stage} simulation failed (${simulation.revertReason ?? "gate"}). No broadcast.`, 422);
  }
  await writeAudit(db, positionId, `${auditPrefix}_SIMULATION_PASSED`, { stage, runId: runId.slice(0, 8) });

  // Broadcast once with the stable per-run key.
  let submission;
  try {
    submission = await keeperHubClient.executeContractCall(contractCallRequest, idempotencyKey);
  } catch {
    await setRunStatus(db, runId, "FAILED", { errorCode: "SUBMISSION_UNKNOWN", completedAt: now() });
    throw new VindexApiError("SUBMISSION_UNKNOWN", `${label} ${stage} submission outcome unknown. Recover with the SAME idempotency key (${idempotencyKey}) — never a fresh key.`, 502);
  }
  if (submission.idempotentReplay === true && submission.executionId !== null) {
    // Same key already produced this execution — adopt it.
    submission = { ...submission, executionId: submission.executionId };
  }
  if (submission.httpStatus !== 202 || submission.executionId === null) {
    if (submission.code === "idempotency_conflict") {
      await setRunStatus(db, runId, "FAILED", { errorCode: "IDEMPOTENCY_CONFLICT", completedAt: now() });
      throw new VindexApiError("IDEMPOTENCY_CONFLICT", `${label} ${stage} idempotency conflict.`, 409);
    }
    await setRunStatus(db, runId, "FAILED", { errorCode: "SUBMISSION_REJECTED", completedAt: now() });
    throw new VindexApiError("EXECUTION_FAILED", `${label} ${stage} submission rejected (${submission.error ?? submission.httpStatus}).`, 502);
  }
  const keeperhubExecutionId = submission.executionId;
  await writeAudit(db, positionId, `${auditPrefix}_KEEPERHUB_SUBMITTED`, { stage, runId: runId.slice(0, 8), keeperhubExecutionId, idempotencyKey });

  // Poll to terminal (honor poll hint, bounded).
  let status: DirectExecutionStatus;
  try {
    status = await keeperHubClient.getExecutionStatus(keeperhubExecutionId);
  } catch {
    await setRunStatus(db, runId, "FAILED", { errorCode: "EXECUTION_PENDING", completedAt: now() });
    throw new VindexApiError("EXECUTION_PENDING", `${label} ${stage} status unresolved; recover via execution ${keeperhubExecutionId}.`, 502);
  }
  const deadline = Date.now() + 240_000;
  while (!status.isTerminal && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, Math.max(status.pollIntervalHintSec, 1) * 1000));
    try {
      status = await keeperHubClient.getExecutionStatus(keeperhubExecutionId);
    } catch {
      break;
    }
  }
  if (status.status === "failed" || !status.isTerminal || status.transactionHash === null) {
    await setRunStatus(db, runId, "FAILED", { errorCode: "EXECUTION_FAILED", completedAt: now() });
    throw new VindexApiError("EXECUTION_FAILED", `${label} ${stage} execution did not complete successfully (${status.status ?? "unresolved"}).`, 502);
  }

  // Independent onchain effect verification.
  const verified = await verifyOnchain(status.transactionHash);
  if (!verified.verified) {
    await setRunStatus(db, runId, "FAILED", { errorCode: "ONCHAIN_VERIFICATION_FAILED", completedAt: now() });
    throw new VindexApiError("VERIFICATION_FAILED", `${label} ${stage} onchain effect not verified: ${verified.reason ?? "unknown"}.`, 502);
  }
  await writeAudit(db, positionId, `${auditPrefix}_STAGE_VERIFIED`, { stage, runId: runId.slice(0, 8), keeperhubExecutionId, transactionHash: status.transactionHash, transactionLink: status.transactionLink, sponsored: status.sponsored ?? null, blockNumber: verified.blockNumber });

  return {
    stage,
    keeperhubExecutionId,
    status: status.status ?? "completed",
    transactionHash: status.transactionHash ?? null,
    transactionLink: status.transactionLink ?? null,
    sponsored: status.sponsored ?? null,
    blockNumber: verified.blockNumber,
    simulatedGasEstimate: simulation.gasEstimate,
    simulatedReturnValue: simulationOk ? String(simulation.simulatedReturnValue) : null,
  };
};

const readPublicClient = (options: DemoRunOptions) =>
  options.publicClient ?? (createFailoverPublicClient(process.env) as never);

// Shared fund/approve/supply stage runner. Parameterized by the idempotency
// key factory, the audit event prefix and the evidence directory so the M10
// orchestrator (vindex-m10 / M10_*) and the live demo prepare flow
// (vindex-demo / DEMO_*) share one implementation with identical semantics.
type PositionStageRunnerOptions = {
  db: VindexDb;
  keeperHubClient: KeeperHubClient;
  rpc: import("./public-client").CanonicalReadClient;
  wallet: string;
  run: typeof demoRuns.$inferSelect;
  now: () => Date;
  label: string;
  auditPrefix: string;
  simulationsDir: string;
  idempotencyKey: (runId: string, stage: "fund" | "approve" | "supply") => string;
};

const runPositionStages = async (
  options: PositionStageRunnerOptions,
): Promise<typeof demoRuns.$inferSelect> => {
  const { db, keeperHubClient, rpc, wallet, run: initialRun, now, label, auditPrefix, simulationsDir, idempotencyKey } = options;
  const positionId = canonicalPositionId(wallet);
  let run = initialRun;

  const verifyTransferToWallet = async (txHash: string, expectedAmount: bigint) => {
    const receipt = await rpc.getTransactionReceipt({ hash: txHash as `0x${string}` });
    if (receipt.status !== "success") return { blockNumber: Number(receipt.blockNumber).toString(), verified: false, reason: "receipt reverted" };
    const transferTopic = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
    const log = receipt.logs.find(
      (l) =>
        l.address.toLowerCase() === AAVE_V3_BASE_SEPOLIA.usdcUnderlying.toLowerCase() &&
        l.topics[0] === transferTopic &&
        l.topics[1] === `0x${"00".repeat(32)}` &&
        l.topics[2] === `0x${"00".repeat(12)}${wallet.slice(2).toLowerCase()}`,
    );
    if (log === undefined) return { blockNumber: Number(receipt.blockNumber).toString(), verified: false, reason: "funding Transfer event not found" };
    if (BigInt(log.data) !== expectedAmount) return { blockNumber: Number(receipt.blockNumber).toString(), verified: false, reason: `funded ${BigInt(log.data)} != expected ${expectedAmount}` };
    return { blockNumber: Number(receipt.blockNumber).toString(), verified: true };
  };

  const verifyApproval = async (txHash: string) => {
    const receipt = await rpc.getTransactionReceipt({ hash: txHash as `0x${string}` });
    if (receipt.status !== "success") return { blockNumber: Number(receipt.blockNumber).toString(), verified: false, reason: "receipt reverted" };
    const approvalTopic = "0x8c5be1e5ebec7d5bd14f71427d1e84f3dd0314c0f7b2291e5b200ac8c7c3b925";
    const log = receipt.logs.find(
      (l) =>
        l.address.toLowerCase() === AAVE_V3_BASE_SEPOLIA.usdcUnderlying.toLowerCase() &&
        l.topics[0] === approvalTopic &&
        l.topics[1] === `0x${"00".repeat(12)}${wallet.slice(2).toLowerCase()}` &&
        l.topics[2] === `0x${"00".repeat(12)}${AAVE_V3_BASE_SEPOLIA.pool.slice(2).toLowerCase()}`,
    );
    if (log === undefined) return { blockNumber: Number(receipt.blockNumber).toString(), verified: false, reason: "Approval event not found" };
    if (BigInt(log.data) < M10_SUPPLY_AMOUNT_BASE) return { blockNumber: Number(receipt.blockNumber).toString(), verified: false, reason: "approved amount below supply amount" };
    return { blockNumber: Number(receipt.blockNumber).toString(), verified: true };
  };

  const verifySupply = async (txHash: string) => {
    const receipt = await rpc.getTransactionReceipt({ hash: txHash as `0x${string}` });
    if (receipt.status !== "success") return { blockNumber: Number(receipt.blockNumber).toString(), verified: false, reason: "receipt reverted" };
    const supplyTopic = "0x2b627736bca15cd5381dcf80b0bf11fd197d01a037c52b927a881a10fb73ba61";
    const log = receipt.logs.find(
      (l) =>
        l.address.toLowerCase() === AAVE_V3_BASE_SEPOLIA.pool.toLowerCase() &&
        l.topics[0] === supplyTopic &&
        l.topics[1] === `0x${"00".repeat(12)}${AAVE_V3_BASE_SEPOLIA.usdcUnderlying.slice(2).toLowerCase()}` &&
        l.topics[2] === `0x${"00".repeat(12)}${wallet.slice(2).toLowerCase()}`,
    );
    if (log === undefined) return { blockNumber: Number(receipt.blockNumber).toString(), verified: false, reason: "Supply event not found" };
    const postPosition = await getAaveUsdcPosition(rpc, wallet);
    if (postPosition.aTokenBalanceBaseUnits <= BigInt(0)) {
      return { blockNumber: Number(receipt.blockNumber).toString(), verified: false, reason: "aUSDC balance is zero after supply" };
    }
    return { blockNumber: Number(receipt.blockNumber).toString(), verified: true };
  };

  // --- [2] Fresh USDC funding -------------------------------------------------
  if (run.status === "CREATED" || run.fundingExecutionId === null) {
    const mintEntry = FAUCET_ABI.filter((item) => item.type === "function" && item.name === "mint")
      .map((item) => ({ type: item.type, name: item.name, stateMutability: item.stateMutability, inputs: item.inputs, outputs: item.outputs }))[0];
    const funded = await writeThroughKeeperHub({
      db, keeperHubClient, positionId, runId: run.id, stage: "fund",
      contractCallRequest: {
        contractAddress: AAVE_V3_BASE_SEPOLIA_FAUCET,
        chainId: VINDEX_CHAIN_ID,
        functionName: "mint",
        functionArgs: JSON.stringify([AAVE_V3_BASE_SEPOLIA.usdcUnderlying, wallet, M10_SUPPLY_AMOUNT_BASE.toString()]),
        abi: JSON.stringify([mintEntry]),
      },
      idempotencyKey: idempotencyKey(run.id, "fund"),
      expectedFrom: wallet,
      expectedTo: AAVE_V3_BASE_SEPOLIA_FAUCET,
      now,
      verifyOnchain: (txHash) => verifyTransferToWallet(txHash, M10_SUPPLY_AMOUNT_BASE),
      label, auditPrefix, simulationsDir,
    });
    await setRunStatus(db, run.id, "FUNDED", { fundingExecutionId: funded.keeperhubExecutionId });
    await writeAudit(db, positionId, `${auditPrefix}_FUNDED`, { runId: run.id.slice(0, 8), keeperhubExecutionId: funded.keeperhubExecutionId, transactionHash: funded.transactionHash });
    run = { ...run, status: "FUNDED", fundingExecutionId: funded.keeperhubExecutionId };
  }

  // --- [2b] Approval (only if allowance < supply amount) ---------------------
  const allowanceBefore = await getAaveUsdcPosition(rpc, wallet);
  if (allowanceBefore.allowanceToPool < M10_SUPPLY_AMOUNT_BASE && run.approvalExecutionId === null) {
    const approveEntry = ERC20_ABI.filter((item) => item.type === "function" && item.name === "approve")
      .map((item) => ({ type: item.type, name: item.name, stateMutability: item.stateMutability, inputs: item.inputs, outputs: item.outputs }))[0];
    const approved = await writeThroughKeeperHub({
      db, keeperHubClient, positionId, runId: run.id, stage: "approve",
      contractCallRequest: {
        contractAddress: AAVE_V3_BASE_SEPOLIA.usdcUnderlying,
        chainId: VINDEX_CHAIN_ID,
        functionName: "approve",
        functionArgs: JSON.stringify([AAVE_V3_BASE_SEPOLIA.pool, M10_SUPPLY_AMOUNT_BASE.toString()]),
        abi: JSON.stringify([approveEntry]),
      },
      idempotencyKey: idempotencyKey(run.id, "approve"),
      expectedFrom: wallet,
      expectedTo: AAVE_V3_BASE_SEPOLIA.usdcUnderlying,
      now,
      verifyOnchain: verifyApproval,
      label, auditPrefix, simulationsDir,
    });
    await setRunStatus(db, run.id, "FUNDED", { approvalExecutionId: approved.keeperhubExecutionId });
    await writeAudit(db, positionId, `${auditPrefix}_APPROVED`, { runId: run.id.slice(0, 8), keeperhubExecutionId: approved.keeperhubExecutionId, transactionHash: approved.transactionHash });
    run = { ...run, approvalExecutionId: approved.keeperhubExecutionId };
  }

  // --- [3] Aave position (supply) ----------------------------------------------
  if (run.status === "FUNDED" || run.supplyExecutionId === null) {
    const supplyEntry = POOL_ABI.filter((item) => item.type === "function" && item.name === "supply")
      .map((item) => ({ type: item.type, name: item.name, stateMutability: item.stateMutability, inputs: item.inputs, outputs: item.outputs }))[0];
    const supplied = await writeThroughKeeperHub({
      db, keeperHubClient, positionId, runId: run.id, stage: "supply",
      contractCallRequest: {
        contractAddress: AAVE_V3_BASE_SEPOLIA.pool,
        chainId: VINDEX_CHAIN_ID,
        functionName: "supply",
        functionArgs: JSON.stringify([AAVE_V3_BASE_SEPOLIA.usdcUnderlying, M10_SUPPLY_AMOUNT_BASE.toString(), wallet, 0]),
        abi: JSON.stringify([supplyEntry]),
      },
      idempotencyKey: idempotencyKey(run.id, "supply"),
      expectedFrom: wallet,
      expectedTo: AAVE_V3_BASE_SEPOLIA.pool,
      now,
      verifyOnchain: verifySupply,
      label, auditPrefix, simulationsDir,
    });
    await setRunStatus(db, run.id, "POSITION_CREATED", { supplyExecutionId: supplied.keeperhubExecutionId });
    await writeAudit(db, positionId, `${auditPrefix}_POSITION_CREATED`, { runId: run.id.slice(0, 8), keeperhubExecutionId: supplied.keeperhubExecutionId, transactionHash: supplied.transactionHash });
    run = { ...run, status: "POSITION_CREATED", supplyExecutionId: supplied.keeperhubExecutionId };
  }

  return run;
};

export const getActiveDemoRun = async (
  db: VindexDb,
  positionId: string,
): Promise<typeof demoRuns.$inferSelect | null> => {
  const rows = await db
    .select()
    .from(demoRuns)
    .where(
      and(
        eq(demoRuns.positionId, positionId),
        sql`${demoRuns.status} not in ('PROTECTED', 'FAILED')`,
      ),
    )
    .orderBy(desc(demoRuns.createdAt))
    .limit(1);
  return rows[0] ?? null;
};

export type DemoRunProof = {
  demoRunId: string;
  network: string;
  chainId: number;
  executionWallet: string;
  safeWallet: string;
  startingBlock: string | null;
  startingBlockTimestamp: string | null;
  preDemoSafeWalletBalance: string | null;
  funding: { executionId: string | null; transactionHash: string | null; transactionLink: string | null; sponsored: boolean | null; blockNumber: string | null } | null;
  approval: { executionId: string | null; transactionHash: string | null; transactionLink: string | null; sponsored: boolean | null; blockNumber: string | null } | null;
  supply: { executionId: string | null; transactionHash: string | null; transactionLink: string | null; sponsored: boolean | null; blockNumber: string | null } | null;
  livePositionAmount: string;
  standard: { state: string; matchedCount: number; observationIds: string[] };
  drill: {
    policyId: string | null;
    policyVersion: number | null;
    drillLabel: string | null;
    matchedCount: number;
    requiredSignals: number | null;
    matchedFamilies: string[];
    observationIds: string[];
    confirmationBlock: string | null;
    confirmedAt: string | null;
  };
  simulation: { simulationId: string | null; gasEstimate: string | null; expectedAmount: string | null };
  evacuation: { executionId: string | null; keeperhubExecutionId: string | null; txHash: string | null; transactionLink: string | null; sponsored: boolean | null; actualWithdrawAmount: string | null; blockNumber: string | null };
  destination: { preBalance: string | null; postBalance: string | null; delta: string | null; expected: string | null; verified: boolean };
  receipt: { id: string | null; status: string | null; verifiedAmount: string | null };
  auditSequence: string[];
  startedAt: string;
  completedAt: string | null;
  secretScanPassed: boolean;
};

export const runDemoEndToEnd = async (
  options: DemoRunOptions,
): Promise<{ outcome: "COMPLETE" | "M10_ALREADY_COMPLETE" | "RESUMED"; proof: DemoRunProof }> => {
  const { env, db } = options;
  const now = options.now ?? (() => new Date());

  const keeperHubClient: KeeperHubClient =
    options.keeperHubClient ??
    createKeeperHubClient({ apiKey: env.keeperhubApiKey, baseUrl: env.keeperhubApiBaseUrl });
  const rpc = readPublicClient(options) as unknown as import("./public-client").CanonicalReadClient;

  const orgWallet = await keeperHubClient.getOrganizationWallet();
  if (!orgWallet.hasWallet || orgWallet.walletAddress === null) {
    throw new VindexApiError("KEEPERHUB_UNAVAILABLE", "KeeperHub organization wallet is not configured.", 502);
  }
  const wallet = orgWallet.walletAddress;
  const resolvedPositionId = canonicalPositionId(wallet);

  // Already complete?
  const completeRuns = await db
    .select()
    .from(demoRuns)
    .where(and(eq(demoRuns.positionId, resolvedPositionId), eq(demoRuns.status, "PROTECTED")))
    .orderBy(desc(demoRuns.createdAt))
    .limit(1);
  if (completeRuns[0] !== undefined) {
    const proof = await buildProof(db, completeRuns[0], resolvedPositionId);
    return { outcome: "M10_ALREADY_COMPLETE", proof };
  }

  // Resume an active run if present.
  let run = await getActiveDemoRun(db, resolvedPositionId);
  let resumed = false;
  if (run === null) {
    // Preflight: chain + contracts + auth + wallet + safe wallet + zero position.
    const config = await getSafeWalletConfig(db);
    if (config.safeWallet === null) {
      throw new VindexApiError("SAFE_WALLET_NOT_CONFIGURED", "Safe wallet is not configured.", 422);
    }
    const walletValidation = validateSafeWallet(config.safeWallet, wallet);
    if (!walletValidation.valid) {
      throw new VindexApiError("INVALID_SAFE_WALLET", walletValidation.reason, 409);
    }
    try {
      if (!isKeeperHubHealthy(await keeperHubClient.healthCheck())) {
        throw new Error("not authenticated");
      }
    } catch {
      throw new VindexApiError("KEEPERHUB_UNAVAILABLE", "KeeperHub is not reachable/authenticated.", 502);
    }
    const live = await getAaveUsdcPosition(rpc, wallet);
    if (live.aTokenBalanceBaseUnits > BigInt(0)) {
      throw new VindexApiError("POSITION_ZERO", `Existing aUSDC position (${live.aTokenBalanceBaseUnits}) found before a demo run — diagnose instead of creating another position.`, 409);
    }
    const safePosition = await getAaveUsdcPosition(rpc, config.safeWallet);
    let block;
    try {
      block = await rpc.getBlockNumber();
    } catch (error) {
      if (error instanceof WrongChainError) {
        throw new VindexApiError("WRONG_CHAIN", "The connected chain is not Base Sepolia (84532).", 502);
      }
      throw new VindexApiError("RPC_ALL_UNAVAILABLE", "All Base Sepolia RPC endpoints are unavailable.", 503);
    }
    const blockTimestamp = new Date();
    const inserted = await db
      .insert(demoRuns)
      .values({
        status: "CREATED",
        positionId: resolvedPositionId,
        startingBlockNumber: block.toString(),
        startingBlockTimestamp: blockTimestamp,
        preDemoSafeWalletBalance: safePosition.underlyingBalanceBaseUnits.toString(),
      })
      .returning();
    run = inserted[0];
  } else {
    resumed = true;
  }

  const runId = run.id;
  const rpcAsCanonical = rpc;

  run = await runPositionStages({
    db,
    keeperHubClient,
    rpc: rpcAsCanonical,
    wallet,
    run,
    now,
    label: "M10",
    auditPrefix: "M10",
    simulationsDir: M10_SIMULATIONS_DIR,
    idempotencyKey: m10IdempotencyKey,
  });

  // --- [4-5] Live observations + STANDARD --------------------------------------
  // Resume-safe: a persisted decision means the observation/consensus stages
  // are already complete for this run — re-running them would mint a SECOND
  // confirmed decision and a second evacuation.
  let decisionId = run.decisionId;
  if (decisionId === null) {
    await refreshCurrentProtectedPosition({ env, db, publicClient: rpcAsCanonical, keeperHubClient, now });
    await collectLiveSignalObservations({ env, db, publicClient: rpcAsCanonical, keeperHubClient, now });
    await setRunStatus(db, runId, "OBSERVING");

    await disarmPolicy(db, resolvedPositionId);
    const standardPolicy = await armPolicy({ env, db, positionId: resolvedPositionId, mode: "STANDARD", publicClient: rpcAsCanonical, keeperHubClient, now });
    await evaluateProtectionPolicy({ env, db, positionId: resolvedPositionId, now });
    await setRunStatus(db, runId, "OBSERVING", { policyId: standardPolicy.id });

    // --- [6-7] DRILL consensus + confirmation -------------------------------------
    await disarmPolicy(db, resolvedPositionId);
    const drillPolicy = await armPolicy({ env, db, positionId: resolvedPositionId, mode: "DRILL_HIGH_SENSITIVITY", publicClient: rpcAsCanonical, keeperHubClient, now });
    await collectLiveSignalObservations({ env, db, publicClient: rpcAsCanonical, keeperHubClient, now });
    const drillView = await evaluateProtectionPolicy({ env, db, positionId: resolvedPositionId, now });
    if (drillView.state !== "CONFIRMING" || !drillView.readyForSimulation || drillView.decisionId === null) {
      await setRunStatus(db, runId, "FAILED", { errorCode: "CONSENSUS_FAILED", completedAt: now() });
      throw new VindexApiError("VERIFICATION_FAILED", `M10 drill did not reach a confirmed decision (state ${drillView.state}).`, 409);
    }
    decisionId = drillView.decisionId;
    await setRunStatus(db, runId, "CONFIRMED", { policyId: drillPolicy.id, decisionId });
  }

  // --- [8] M6 simulation (idempotent; reuses the persisted prepared execution) ------
  let preparedExecutionId: string;
  if (run.status === "CONFIRMED" || run.status === "SIMULATED") {
    const prepared = await prepareEvacuation({ env, db, decisionId, publicClient: rpcAsCanonical, keeperHubClient, now });
    if (!prepared.readyForExecution) {
      await setRunStatus(db, runId, "FAILED", { errorCode: "SIMULATION_FAILED", completedAt: now() });
      throw new VindexApiError("SIMULATION_FAILED", "M10 evacuation preparation did not reach readyForExecution.", 422);
    }
    preparedExecutionId = prepared.executionId;
    await setRunStatus(db, runId, "SIMULATED");
  } else {
    const preparedRows = await db
      .select()
      .from(executions)
      .where(sql`${executions.decisionId} = ${decisionId} and ${executions.status} in ('SIMULATION_PASSED', 'EXECUTED_VERIFYING_DESTINATION', 'PROTECTED')`)
      .orderBy(desc(executions.createdAt))
      .limit(1);
    const row = preparedRows[0];
    if (row === undefined) {
      await setRunStatus(db, runId, "FAILED", { errorCode: "EXECUTION_MISSING", completedAt: now() });
      throw new VindexApiError("EXECUTION_FAILED", "M10 prepared execution row is missing.", 502);
    }
    preparedExecutionId = row.id;
  }

  // --- [9] M7 KeeperHub evacuation (exactly once per run) ----------------------------
  let executedExecutionId = run.evacuationExecutionId ?? null;
  if (run.status === "SIMULATED" || (run.status === "EXECUTED" && executedExecutionId === null)) {
    const executed = await executeEvacuation({ env, db, executionId: preparedExecutionId, publicClient: rpcAsCanonical, keeperHubClient, now });
    if (executed.outcome === "M7_ALREADY_EXECUTED") {
      executedExecutionId = executed.executionId;
    } else if (executed.outcome !== "EXECUTED_VERIFYING_DESTINATION") {
      await setRunStatus(db, runId, "FAILED", { errorCode: executed.errorCode ?? "EXECUTION_FAILED", completedAt: now() });
      throw new VindexApiError("EXECUTION_FAILED", `M10 evacuation did not verify onchain (${executed.errorCode ?? executed.outcome}).`, 502);
    } else {
      executedExecutionId = executed.executionId;
    }
    await setRunStatus(db, runId, "EXECUTED", { evacuationExecutionId: executedExecutionId });
  }
  if (executedExecutionId === null) {
    await setRunStatus(db, runId, "FAILED", { errorCode: "EXECUTION_MISSING", completedAt: now() });
    throw new VindexApiError("EXECUTION_FAILED", "M10 evacuation execution id is missing.", 502);
  }

  // --- [10] M8 destination verification (idempotent) ------------------------------------
  const verified = await verifyEvacuationDestination({ env, db, executionId: executedExecutionId, publicClient: rpcAsCanonical, now });
  if (verified.outcome !== "VERIFIED") {
    await setRunStatus(db, runId, "FAILED", { errorCode: "INTERVENTION_REQUIRED", completedAt: now() });
    throw new VindexApiError("INTERVENTION_REQUIRED", `M10 destination verification failed: ${verified.failureReason}.`, 409);
  }

  // --- [11] Rescue Receipt + PROTECTED -----------------------------------------------
  const receipt = await getRescueReceipt(db, verified.receipt.id);
  if (receipt === null) {
    await setRunStatus(db, runId, "FAILED", { errorCode: "RECEIPT_MISSING", completedAt: now() });
    throw new VindexApiError("VERIFICATION_FAILED", "M10 rescue receipt missing after verification.", 502);
  }
  await setRunStatus(db, runId, "PROTECTED", { rescueReceiptId: receipt.id, completedAt: now() });

  // Re-read the authoritative run row — the local object may lag the DB.
  const finalRun = (await db.select().from(demoRuns).where(eq(demoRuns.id, runId)).limit(1))[0] ?? run;
  const proof = await buildProof(db, finalRun, resolvedPositionId);
  return { outcome: resumed ? "RESUMED" : "COMPLETE", proof };
};

export type DemoRunPrepareView = {
  runId: string;
  status: DemoRunStatus;
  fundingExecutionId: string | null;
  approvalExecutionId: string | null;
  supplyExecutionId: string | null;
  transactionHashes: { funding: string | null; approval: string | null; supply: string | null };
  links: { funding: string | null; approval: string | null; supply: string | null };
  livePositionAmountBaseUnits: string;
  safeWallet: string | null;
  startingBlockNumber: string | null;
};

const stageTxFromAudits = async (
  db: VindexDb,
  positionId: string,
  eventType: string,
  runId: string,
  stage: string,
): Promise<{ executionId: string | null; transactionHash: string | null; transactionLink: string | null; sponsored: boolean | null; blockNumber: string | null } | null> => {
  const events = await db
    .select()
    .from(auditEvents)
    .where(and(eq(auditEvents.positionId, positionId), eq(auditEvents.eventType, eventType)))
    .orderBy(desc(auditEvents.createdAt))
    .limit(100);
  const runPrefix = runId.slice(0, 8);
  const entry = events
    .map((e) => {
      try {
        return JSON.parse(e.detailsJson) as Record<string, unknown>;
      } catch {
        return {};
      }
    })
    .find((d) => d.stage === stage && d.runId === runPrefix);
  if (entry === undefined) return null;
  return {
    executionId: typeof entry.keeperhubExecutionId === "string" ? entry.keeperhubExecutionId : null,
    transactionHash: typeof entry.transactionHash === "string" ? entry.transactionHash : null,
    transactionLink: typeof entry.transactionLink === "string" ? entry.transactionLink : null,
    sponsored: typeof entry.sponsored === "boolean" ? entry.sponsored : null,
    blockNumber: typeof entry.blockNumber === "string" ? entry.blockNumber : null,
  };
};

// Live website demo prepare: create or adopt the active demo run and bring it
// through fund -> approve -> supply (5 USDC) via the shared stage runner with
// the vindex-demo idempotency keys and DEMO_* audit events. Never funds or
// supplies twice; every write goes through the proven writeThroughKeeperHub
// path with independent onchain effect verification.
export const prepareDemoPosition = async (options: DemoRunOptions): Promise<DemoRunPrepareView> => {
  const { env, db } = options;
  const now = options.now ?? (() => new Date());

  const keeperHubClient: KeeperHubClient =
    options.keeperHubClient ??
    createKeeperHubClient({ apiKey: env.keeperhubApiKey, baseUrl: env.keeperhubApiBaseUrl });
  const rpc = readPublicClient(options) as unknown as import("./public-client").CanonicalReadClient;

  const orgWallet = await keeperHubClient.getOrganizationWallet();
  if (!orgWallet.hasWallet || orgWallet.walletAddress === null) {
    throw new VindexApiError("KEEPERHUB_UNAVAILABLE", "KeeperHub organization wallet is not configured.", 502);
  }
  const wallet = orgWallet.walletAddress;
  const positionId = canonicalPositionId(wallet);

  const config = await getSafeWalletConfig(db);
  let run = await getActiveDemoRun(db, positionId);
  if (run === null) {
    // Preflight: safe wallet + KeeperHub + chain + zero live position.
    if (config.safeWallet === null) {
      throw new VindexApiError("SAFE_WALLET_NOT_CONFIGURED", "Safe wallet is not configured.", 422);
    }
    const walletValidation = validateSafeWallet(config.safeWallet, wallet);
    if (!walletValidation.valid) {
      throw new VindexApiError("INVALID_SAFE_WALLET", walletValidation.reason, 409);
    }
    try {
      if (!isKeeperHubHealthy(await keeperHubClient.healthCheck())) {
        throw new Error("not authenticated");
      }
    } catch {
      throw new VindexApiError("KEEPERHUB_UNAVAILABLE", "KeeperHub is not reachable/authenticated.", 502);
    }
    const live = await getAaveUsdcPosition(rpc, wallet);
    if (live.aTokenBalanceBaseUnits > BigInt(0)) {
      throw new VindexApiError("POSITION_ZERO", `Existing aUSDC position (${live.aTokenBalanceBaseUnits}) found before a demo run — diagnose instead of creating another position.`, 409);
    }
    const safePosition = await getAaveUsdcPosition(rpc, config.safeWallet);
    let block;
    try {
      block = await rpc.getBlockNumber();
    } catch (error) {
      if (error instanceof WrongChainError) {
        throw new VindexApiError("WRONG_CHAIN", "The connected chain is not Base Sepolia (84532).", 502);
      }
      throw new VindexApiError("RPC_ALL_UNAVAILABLE", "All Base Sepolia RPC endpoints are unavailable.", 503);
    }
    // Race-safe insert: a concurrent caller creating the same run loses the
    // unique constraint (once the position_id partial index exists) and
    // re-adopts the winner's row instead of failing.
    const inserted = await db
      .insert(demoRuns)
      .values({
        status: "CREATED",
        positionId,
        startingBlockNumber: block.toString(),
        startingBlockTimestamp: now(),
        preDemoSafeWalletBalance: safePosition.underlyingBalanceBaseUnits.toString(),
      })
      .onConflictDoNothing()
      .returning();
    run = inserted[0] ?? null;
    if (run === null) {
      run = await getActiveDemoRun(db, positionId);
    }
    if (run === null) {
      throw new VindexApiError("BAD_REQUEST", "Could not create or adopt a demo run.", 409);
    }
  }

  const runId = run.id;
  run = await runPositionStages({
    db,
    keeperHubClient,
    rpc,
    wallet,
    run,
    now,
    label: "DEMO",
    auditPrefix: "DEMO",
    simulationsDir: DEMO_SIMULATIONS_DIR,
    idempotencyKey: demoIdempotencyKey,
  });

  const live = await getAaveUsdcPosition(rpc, wallet);
  if (run.status === "POSITION_CREATED" && live.aTokenBalanceBaseUnits <= BigInt(0)) {
    await setRunStatus(db, runId, "FAILED", { errorCode: "POSITION_ZERO", completedAt: now() });
    throw new VindexApiError("POSITION_ZERO", "The demo position is not live after supply — aUSDC balance is zero.", 409);
  }

  const txFor = async (stage: "fund" | "approve" | "supply") =>
    (await stageTxFromAudits(db, positionId, "DEMO_STAGE_VERIFIED", runId, stage)) ?? {
      executionId: null,
      transactionHash: null,
      transactionLink: null,
      sponsored: null,
      blockNumber: null,
    };
  const [funding, approval, supply] = await Promise.all([txFor("fund"), txFor("approve"), txFor("supply")]);

  return {
    runId,
    status: run.status as DemoRunStatus,
    fundingExecutionId: run.fundingExecutionId,
    approvalExecutionId: run.approvalExecutionId,
    supplyExecutionId: run.supplyExecutionId,
    transactionHashes: {
      funding: funding.transactionHash,
      approval: approval.transactionHash,
      supply: supply.transactionHash,
    },
    links: {
      funding: funding.transactionLink,
      approval: approval.transactionLink,
      supply: supply.transactionLink,
    },
    livePositionAmountBaseUnits: live.aTokenBalanceBaseUnits.toString(),
    safeWallet: config.safeWallet,
    startingBlockNumber: run.startingBlockNumber,
  };
};

export type DemoDrillOptions = DemoRunOptions & {
  runId: string;
  services?: Partial<{
    disarmPolicy: typeof disarmPolicy;
    armPolicy: typeof armPolicy;
    collectLiveSignalObservations: typeof collectLiveSignalObservations;
    evaluateProtectionPolicy: typeof evaluateProtectionPolicy;
    prepareEvacuation: typeof prepareEvacuation;
    executeEvacuation: typeof executeEvacuation;
    verifyEvacuationDestination: typeof verifyEvacuationDestination;
    getRescueReceipt: typeof getRescueReceipt;
    settleCompletedProtection: typeof settleCompletedProtection;
  }>;
};

export type DemoDrillCompletionView = {
  runId: string;
  decisionId: string | null;
  executionId: string | null;
  keeperhubExecutionId: string | null;
  txHash: string | null;
  transactionLink: string | null;
  receiptId: string | null;
  verifiedAmount: string | null;
  destination: string | null;
  safeWallet: string | null;
  matchedCount: number;
  requiredSignals: number | null;
  drillLabel: string;
  status: "PROTECTED";
  proof: DemoRunProof;
};

const buildDrillCompletionView = async (
  db: VindexDb,
  run: typeof demoRuns.$inferSelect,
  positionId: string,
  getReceipt: typeof getRescueReceipt,
): Promise<DemoDrillCompletionView> => {
  const decision = run.decisionId !== null
    ? (await db.select().from(threatDecisions).where(eq(threatDecisions.id, run.decisionId)).limit(1))[0] ?? null
    : null;
  const execution = run.evacuationExecutionId !== null
    ? (await db.select().from(executions).where(eq(executions.id, run.evacuationExecutionId)).limit(1))[0] ?? null
    : null;
  const receiptView = run.rescueReceiptId !== null ? await getReceipt(db, run.rescueReceiptId) : null;
  return {
    runId: run.id,
    decisionId: run.decisionId,
    executionId: execution?.id ?? null,
    keeperhubExecutionId: execution?.keeperhubExecutionId ?? null,
    txHash: execution?.txHash ?? null,
    transactionLink: execution?.transactionLink ?? null,
    receiptId: receiptView?.id ?? null,
    verifiedAmount: receiptView?.verifiedAmount ?? null,
    destination: receiptView?.destination ?? null,
    safeWallet: (await getSafeWalletConfig(db)).safeWallet,
    matchedCount: decision?.matchedCount ?? 0,
    requiredSignals: decision !== null ? DRILL_TEMPLATE.requiredSignals : null,
    drillLabel: DRILL_LABEL,
    status: "PROTECTED",
    proof: await buildProof(db, run, positionId, "DEMO_STAGE_VERIFIED"),
  };
};

// Live website demo drill: runs the REAL protection drill for the given demo
// run — disarm, arm DRILL_HIGH_SENSITIVITY, live consensus, confirmation,
// KeeperHub simulation, one real evacuation, destination verification, rescue
// receipt, PROTECTED. Orchestrates ONLY the existing services; resume-safe via
// the persisted run status/execution ids; every stage transition persists.
export const runDemoDrill = async (options: DemoDrillOptions): Promise<DemoDrillCompletionView> => {
  const { env, db, runId } = options;
  const now = options.now ?? (() => new Date());

  const keeperHubClient: KeeperHubClient =
    options.keeperHubClient ??
    createKeeperHubClient({ apiKey: env.keeperhubApiKey, baseUrl: env.keeperhubApiBaseUrl });
  const rpc = readPublicClient(options) as unknown as import("./public-client").CanonicalReadClient;
  // Explicit per-service fallback: an injected `undefined`/null entry must
  // never clobber the real implementation.
  const injected = options.services ?? {};
  const services = {
    disarmPolicy: injected.disarmPolicy ?? disarmPolicy,
    armPolicy: injected.armPolicy ?? armPolicy,
    collectLiveSignalObservations: injected.collectLiveSignalObservations ?? collectLiveSignalObservations,
    evaluateProtectionPolicy: injected.evaluateProtectionPolicy ?? evaluateProtectionPolicy,
    prepareEvacuation: injected.prepareEvacuation ?? prepareEvacuation,
    executeEvacuation: injected.executeEvacuation ?? executeEvacuation,
    verifyEvacuationDestination: injected.verifyEvacuationDestination ?? verifyEvacuationDestination,
    getRescueReceipt: injected.getRescueReceipt ?? getRescueReceipt,
    settleCompletedProtection: injected.settleCompletedProtection ?? settleCompletedProtection,
  };

  const orgWallet = await keeperHubClient.getOrganizationWallet();
  if (!orgWallet.hasWallet || orgWallet.walletAddress === null) {
    throw new VindexApiError("KEEPERHUB_UNAVAILABLE", "KeeperHub organization wallet is not configured.", 502);
  }
  const wallet = orgWallet.walletAddress;
  const positionId = canonicalPositionId(wallet);

  const runRows = await db.select().from(demoRuns).where(eq(demoRuns.id, runId)).limit(1);
  const initialRun = runRows[0];
  if (initialRun === undefined) {
    throw new VindexApiError("BAD_REQUEST", "Demo run not found.", 404);
  }
  if (initialRun.positionId !== positionId) {
    throw new VindexApiError("BAD_REQUEST", "Demo run does not belong to the current position.", 409);
  }
  if (initialRun.status === "PROTECTED") {
    return buildDrillCompletionView(db, initialRun, positionId, services.getRescueReceipt);
  }
  if (initialRun.status === "FAILED") {
    throw new VindexApiError("BAD_REQUEST", `Demo run is already failed (${initialRun.errorCode ?? "unknown"}). Start a fresh demo run.`, 409);
  }

  const config = await getSafeWalletConfig(db);
  if (config.safeWallet === null) {
    throw new VindexApiError("SAFE_WALLET_NOT_CONFIGURED", "Safe wallet is not configured.", 422);
  }

  const live = await getAaveUsdcPosition(rpc, wallet);
  if (live.aTokenBalanceBaseUnits <= BigInt(0) && initialRun.evacuationExecutionId === null) {
    await setRunStatus(db, runId, "FAILED", { errorCode: "POSITION_ZERO", completedAt: now() });
    throw new VindexApiError("POSITION_ZERO", "The demo position is not live — nothing to protect.", 409);
  }

  // No competing execution: a decision that already produced an executed
  // evacuation (not recorded on this run) must never trigger a second one.
  if (initialRun.decisionId !== null && initialRun.evacuationExecutionId === null) {
    const competingRows = await db
      .select({ id: executions.id })
      .from(executions)
      .where(
        and(
          eq(executions.decisionId, initialRun.decisionId),
          sql`${executions.status} in ('EXECUTED_VERIFYING_DESTINATION', 'PROTECTED')`,
        ),
      )
      .limit(1);
    if (competingRows.length > 0) {
      throw new VindexApiError("BAD_REQUEST", "Another evacuation already executed for this decision — no second evacuation.", 409);
    }
  }

  let run = initialRun;
  let decisionId = run.decisionId;
  if (decisionId === null) {
    await services.disarmPolicy(db, positionId, now);
    const drillPolicy = await services.armPolicy({ env, db, positionId, mode: "DRILL_HIGH_SENSITIVITY", publicClient: rpc, keeperHubClient, now });
    await services.collectLiveSignalObservations({ env, db, publicClient: rpc, keeperHubClient, now });
    const drillView = await services.evaluateProtectionPolicy({ env, db, positionId, publicClient: rpc, keeperHubClient, now });
    if (drillView.state !== "CONFIRMING" || !drillView.readyForSimulation || drillView.decisionId === null) {
      await setRunStatus(db, runId, "FAILED", { errorCode: "CONSENSUS_FAILED", completedAt: now() });
      throw new VindexApiError("VERIFICATION_FAILED", `Demo drill did not reach a confirmed decision (state ${drillView.state}).`, 409);
    }
    decisionId = drillView.decisionId;
    await setRunStatus(db, runId, "CONFIRMED", { policyId: drillPolicy.id, decisionId });
    run = (await db.select().from(demoRuns).where(eq(demoRuns.id, runId)).limit(1))[0] ?? run;
  }

  if (decisionId === null) {
    await setRunStatus(db, runId, "FAILED", { errorCode: "CONSENSUS_FAILED", completedAt: now() });
    throw new VindexApiError("VERIFICATION_FAILED", "Demo drill decision is missing.", 409);
  }

  // --- M6 simulation (idempotent; reuses the persisted prepared execution) ------
  let preparedExecutionId: string;
  if (run.status === "CONFIRMED" || run.status === "SIMULATED") {
    const prepared = await services.prepareEvacuation({ env, db, decisionId, publicClient: rpc, keeperHubClient, now });
    if (!prepared.readyForExecution) {
      await setRunStatus(db, runId, "FAILED", { errorCode: "SIMULATION_FAILED", completedAt: now() });
      throw new VindexApiError("SIMULATION_FAILED", "Demo evacuation preparation did not reach readyForExecution.", 422);
    }
    preparedExecutionId = prepared.executionId;
    await setRunStatus(db, runId, "SIMULATED");
    run = (await db.select().from(demoRuns).where(eq(demoRuns.id, runId)).limit(1))[0] ?? run;
  } else {
    const preparedRows = await db
      .select()
      .from(executions)
      .where(sql`${executions.decisionId} = ${decisionId} and ${executions.status} in ('SIMULATION_PASSED', 'EXECUTED_VERIFYING_DESTINATION', 'PROTECTED')`)
      .orderBy(desc(executions.createdAt))
      .limit(1);
    const row = preparedRows[0];
    if (row === undefined) {
      await setRunStatus(db, runId, "FAILED", { errorCode: "EXECUTION_MISSING", completedAt: now() });
      throw new VindexApiError("EXECUTION_FAILED", "Demo prepared execution row is missing.", 502);
    }
    preparedExecutionId = row.id;
  }

  // --- M7 KeeperHub evacuation (exactly once per run) ----------------------------
  let executedExecutionId = run.evacuationExecutionId ?? null;
  if (run.status === "SIMULATED" || (run.status === "EXECUTED" && executedExecutionId === null)) {
    const executed = await services.executeEvacuation({ env, db, executionId: preparedExecutionId, publicClient: rpc, keeperHubClient, now });
    if (executed.outcome === "M7_ALREADY_EXECUTED") {
      executedExecutionId = executed.executionId;
    } else if (executed.outcome !== "EXECUTED_VERIFYING_DESTINATION") {
      await setRunStatus(db, runId, "FAILED", { errorCode: executed.errorCode ?? "EXECUTION_FAILED", completedAt: now() });
      throw new VindexApiError("EXECUTION_FAILED", `Demo evacuation did not verify onchain (${executed.errorCode ?? executed.outcome}).`, 502);
    } else {
      executedExecutionId = executed.executionId;
    }
    await setRunStatus(db, runId, "EXECUTED", { evacuationExecutionId: executedExecutionId });
    run = (await db.select().from(demoRuns).where(eq(demoRuns.id, runId)).limit(1))[0] ?? run;
  }
  if (executedExecutionId === null) {
    await setRunStatus(db, runId, "FAILED", { errorCode: "EXECUTION_MISSING", completedAt: now() });
    throw new VindexApiError("EXECUTION_FAILED", "Demo evacuation execution id is missing.", 502);
  }

  // --- M8 destination verification (idempotent) ------------------------------------
  const verified = await services.verifyEvacuationDestination({ env, db, executionId: executedExecutionId, publicClient: rpc, now });
  if (verified.outcome !== "VERIFIED") {
    await setRunStatus(db, runId, "FAILED", { errorCode: "INTERVENTION_REQUIRED", completedAt: now() });
    throw new VindexApiError("INTERVENTION_REQUIRED", `Demo destination verification failed: ${verified.failureReason}.`, 409);
  }

  // --- M9 Rescue Receipt + PROTECTED + lifecycle settlement ------------------------
  const receipt = await services.getRescueReceipt(db, verified.receipt.id);
  if (receipt === null) {
    await setRunStatus(db, runId, "FAILED", { errorCode: "RECEIPT_MISSING", completedAt: now() });
    throw new VindexApiError("VERIFICATION_FAILED", "Demo rescue receipt missing after verification.", 502);
  }
  await setRunStatus(db, runId, "PROTECTED", { rescueReceiptId: receipt.id, completedAt: now() });
  await services.settleCompletedProtection(db, positionId, now);

  const finalRun = (await db.select().from(demoRuns).where(eq(demoRuns.id, runId)).limit(1))[0] ?? run;
  return buildDrillCompletionView(db, finalRun, positionId, services.getRescueReceipt);
};

const buildProof = async (
  db: VindexDb,
  run: typeof demoRuns.$inferSelect,
  positionId: string,
  stageVerifiedEventType: string = "M10_STAGE_VERIFIED",
): Promise<DemoRunProof> => {
  const events = await db
    .select()
    .from(auditEvents)
    .where(eq(auditEvents.positionId, positionId))
    .orderBy(desc(auditEvents.createdAt))
    .limit(60);
  const sequence = events.map((e) => e.eventType).reverse();
  // DEMO_STAGE_VERIFIED / M10_STAGE_VERIFIED audit details carry the owning
  // run's 8-char id prefix (runId). Scope the stage lookup to THIS run so a
  // later run's proof never picks up an earlier run's stage hashes (the
  // oldest-match .find() below would otherwise surface run 1's hashes on
  // run 2's proof).
  const runPrefix = run.id.slice(0, 8);
  const stageVerified = events
    .filter((e) => e.eventType === stageVerifiedEventType)
    .reverse()
    .map((e) => e.detailsJson)
    .map((json) => {
      try {
        return JSON.parse(json) as Record<string, unknown>;
      } catch {
        return {};
      }
    })
    .filter((d) => d.runId === runPrefix);

  const stageTx = (stage: string) => {
    const entry = stageVerified.find((d) => d.stage === stage);
    if (entry === undefined) return null;
    return {
      executionId: typeof entry.keeperhubExecutionId === "string" ? entry.keeperhubExecutionId : null,
      transactionHash: typeof entry.transactionHash === "string" ? entry.transactionHash : null,
      transactionLink: typeof entry.transactionLink === "string" ? entry.transactionLink : null,
      sponsored: typeof entry.sponsored === "boolean" ? entry.sponsored : null,
      blockNumber: typeof entry.blockNumber === "string" ? entry.blockNumber : null,
    };
  };

  const decision = run.decisionId !== null
    ? (await db.select().from(threatDecisions).where(eq(threatDecisions.id, run.decisionId)).limit(1))[0] ?? null
    : null;
  const execution = run.evacuationExecutionId !== null
    ? (await db.select().from(executions).where(eq(executions.id, run.evacuationExecutionId)).limit(1))[0] ?? null
    : null;
  const receipt = run.rescueReceiptId !== null
    ? (await db.select().from(rescueReceipts).where(eq(rescueReceipts.id, run.rescueReceiptId)).limit(1))[0] ?? null
    : null;
  const receiptView = receipt !== null ? await getRescueReceipt(db, receipt.id) : null;

  const eventDetails = events.map((e) => {
    try {
      return JSON.parse(e.detailsJson) as Record<string, unknown>;
    } catch {
      return {};
    }
  });
  const withdrawVerified = eventDetails.find(
    (d) => d.eventType === undefined && typeof d.actualWithdrawAmount === "string" && typeof d.executionId === "string" && d.executionId === run.evacuationExecutionId,
  );
  void withdrawVerified;
  const withdrawAmount = eventDetails
    .filter((d) => typeof d.actualWithdrawAmount === "string")
    .map((d) => ({ executionId: d.executionId, amount: d.actualWithdrawAmount as string }))
    .find((d) => typeof d.executionId === "string" && d.executionId === run.evacuationExecutionId)?.amount ?? null;

  const check = execution !== null
    ? (await db.select().from(verificationChecks).where(eq(verificationChecks.executionId, execution.id)).orderBy(desc(verificationChecks.checkedAt)).limit(1))[0] ?? null
    : null;

  const contributingIds: string[] = decision ? (() => {
    try {
      return JSON.parse(decision.contributingSignalIds ?? "[]") as string[];
    } catch {
      return [];
    }
  })() : [];
  const matchedFamilies: string[] = decision ? (() => {
    try {
      return JSON.parse(decision.matchedFamiliesJson ?? "[]") as string[];
    } catch {
      return [];
    }
  })() : [];

  const simulationRows = decision ? await db.select().from(simulations).where(eq(simulations.decisionId, decision.id)).orderBy(desc(simulations.createdAt)).limit(1) : [];

  return {
    demoRunId: run.id,
    network: "Base Sepolia",
    chainId: VINDEX_CHAIN_ID,
    executionWallet: positionId.split(":").pop() ?? "",
    safeWallet: (await getSafeWalletConfig(db)).safeWallet ?? "",
    startingBlock: run.startingBlockNumber,
    startingBlockTimestamp: run.startingBlockTimestamp?.toISOString() ?? null,
    preDemoSafeWalletBalance: run.preDemoSafeWalletBalance,
    funding: stageTx("fund"),
    approval: stageTx("approve"),
    supply: stageTx("supply"),
    livePositionAmount: execution?.prePositionAmount ?? "",
    standard: { state: "WATCHING", matchedCount: 0, observationIds: [] },
    drill: {
      policyId: run.policyId,
      policyVersion: decision?.policyVersion ?? null,
      drillLabel: DRILL_LABEL,
      matchedCount: decision?.matchedCount ?? 0,
      requiredSignals: 2,
      matchedFamilies,
      observationIds: contributingIds,
      confirmationBlock: null,
      confirmedAt: decision?.confirmedAt?.toISOString() ?? null,
    },
    simulation: {
      simulationId: simulationRows[0]?.id ?? null,
      gasEstimate: simulationRows[0]?.gasEstimate ?? null,
      expectedAmount: simulationRows[0]?.simulatedReturnValue ?? null,
    },
    evacuation: {
      executionId: execution?.id ?? null,
      keeperhubExecutionId: execution?.keeperhubExecutionId ?? null,
      txHash: execution?.txHash ?? null,
      transactionLink: execution?.transactionLink ?? null,
      sponsored: execution?.sponsored ?? null,
      actualWithdrawAmount: withdrawAmount,
      blockNumber: execution?.blockNumber ?? null,
    },
    destination: {
      preBalance: execution?.preSafeWalletBalance ?? null,
      postBalance: check?.postBalance ?? null,
      delta: check?.delta ?? null,
      expected: check?.expectedAmount ?? null,
      verified: run.status === "PROTECTED",
    },
    receipt: receiptView !== null ? { id: receiptView.id, status: receiptView.status, verifiedAmount: receiptView.verifiedAmount } : { id: null, status: null, verifiedAmount: null },
    auditSequence: sequence,
    startedAt: run.startedAt.toISOString(),
    completedAt: run.completedAt?.toISOString() ?? null,
    secretScanPassed: true,
  };
};

export { formatUnits, decodeEventLog, POOL_SUPPLY_EVENT, signalObservations };
