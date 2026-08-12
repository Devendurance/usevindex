// M7 real KeeperHub evacuation execution. Consumes the persisted M6 prepared
// intent, revalidates everything, runs a final simulate:true, atomically claims
// the execution slot, broadcasts ONCE through KeeperHub with a stable
// idempotency key, and proves the onchain Withdraw event. Ends at
// EXECUTED_VERIFYING_DESTINATION — M8 owns destination verification + receipt.
import "server-only";

import { createHash } from "node:crypto";
import { and, desc, eq, sql } from "drizzle-orm";
import { decodeEventLog } from "viem";

import type { VindexDb } from "../../db";
import { executions, simulations, threatDecisions } from "../../db/schema";
import { getAaveUsdcPosition } from "./aave-position";
import {
  AAVE_V3_BASE_SEPOLIA,
  MAX_UINT256,
  POOL_ABI,
  POOL_WITHDRAW_EVENT,
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
  createCanonicalPublicClient,
  readCanonicalChainState,
  type CanonicalReadClient,
} from "./public-client";
import { getArmedPolicy } from "./policy-service";
import { canonicalPositionId } from "./position-service";
import { getSafeWalletConfig } from "./safe-wallet";
import { exitParametersHash } from "./evacuation-service";

export const M7_POLL_TIMEOUT_MS = 240_000;

export const M7_IDEMPOTENCY_PREFIX = "vindex-m7";

export const m7IdempotencyKey = (executionId: string, parametersHash: string): string =>
  `${M7_IDEMPOTENCY_PREFIX}-${executionId}-${parametersHash.slice(0, 8)}`;

export const broadcastRequestHash = (request: {
  contractAddress: string;
  chainId: number;
  functionName: string;
  functionArgs: string;
  abi: string;
}): string =>
  createHash("sha256")
    .update(
      [
        request.contractAddress,
        String(request.chainId),
        request.functionName,
        request.functionArgs,
        request.abi,
      ].join("|"),
    )
    .digest("hex");

export type ExecuteEvacuationOptions = {
  env: VindexEnv;
  db: VindexDb;
  executionId: string;
  keeperHubClient?: KeeperHubClient;
  publicClient?: CanonicalReadClient;
  now?: () => Date;
  pollMaxMs?: number;
};

export type ExecutionState =
  | "SIMULATION_PASSED"
  | "SUBMISSION_PENDING"
  | "SUBMISSION_UNKNOWN"
  | "EXECUTION_PENDING"
  | "EXECUTION_FAILED"
  | "EXECUTED_VERIFYING_DESTINATION";

export type ExecutionResult = {
  outcome: ExecutionState | "M7_ALREADY_EXECUTED";
  executionId: string;
  decisionId: string;
  keeperhubExecutionId: string | null;
  status: string | null;
  transactionHash: string | null;
  transactionLink: string | null;
  sponsored: boolean | null;
  actualWithdrawAmount: string | null;
  prePositionAmount: string | null;
  postPositionAmount: string | null;
  blockNumber: string | null;
  errorCode: string | null;
  readyForDestinationVerification: boolean;
  auditEvents: string[];
};

const writeAudit = async (
  db: VindexDb,
  positionId: string,
  eventType: string,
  details: Record<string, unknown>,
  decisionId: string | null = null,
  blockNumber: string | null = null,
): Promise<void> => {
  const { auditEvents } = await import("../../db/schema");
  await db.insert(auditEvents).values({
    positionId,
    decisionId: decisionId ?? null,
    eventType,
    detailsJson: JSON.stringify(details),
    blockNumber,
  });
};

const WITHDRAW_TOPIC = "0x3115d1449a7b732c986cba18244e897a450f61e1bb8d589cd2e69e6c8924f9f7";

export const executeEvacuation = async (
  options: ExecuteEvacuationOptions,
): Promise<ExecutionResult> => {
  const { env, db, executionId } = options;
  const now = options.now ?? (() => new Date());
  const pollMaxMs = options.pollMaxMs ?? M7_POLL_TIMEOUT_MS;

  const keeperHubClient: KeeperHubClient =
    options.keeperHubClient ??
    createKeeperHubClient({ apiKey: env.keeperhubApiKey, baseUrl: env.keeperhubApiBaseUrl });
  const rpc: CanonicalReadClient =
    options.publicClient ?? createCanonicalPublicClient(env.baseSepoliaRpcUrl);

  const { pool, usdcUnderlying } = AAVE_V3_BASE_SEPOLIA;

  const execRows = await db
    .select()
    .from(executions)
    .where(eq(executions.id, executionId))
    .limit(1);
  const execution = execRows[0];
  if (execution === undefined) {
    throw new VindexApiError("BAD_REQUEST", "Execution not found.", 404);
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

  const resultBase = (
    state: ExecutionState | "M7_ALREADY_EXECUTED",
    overrides: Partial<ExecutionResult> = {},
  ): ExecutionResult => ({
    outcome: state,
    executionId,
    decisionId: execution.decisionId,
    keeperhubExecutionId: execution.keeperhubExecutionId,
    status: execution.lastKeeperHubStatus,
    transactionHash: execution.txHash,
    transactionLink: execution.transactionLink,
    sponsored: execution.sponsored,
    actualWithdrawAmount: null,
    prePositionAmount: execution.prePositionAmount,
    postPositionAmount: null,
    blockNumber: execution.blockNumber,
    errorCode: execution.errorCode,
    readyForDestinationVerification: state === "EXECUTED_VERIFYING_DESTINATION",
    auditEvents: [],
    ...overrides,
  });

  // Already executed.
  if (execution.status === "EXECUTED_VERIFYING_DESTINATION" && execution.txHash !== null) {
    return { ...resultBase("M7_ALREADY_EXECUTED"), transactionHash: execution.txHash };
  }
  if (execution.status === "EXECUTION_FAILED") {
    return resultBase("EXECUTION_FAILED");
  }

  // Revalidate current authorization (never trusts historical state alone).
  const policy = await getArmedPolicy(db, positionId);
  if (policy === null) {
    throw new VindexApiError("POLICY_ARMED_RECONFIGURE_REQUIRED", "Policy is not armed.", 409);
  }
  if (decision.policyId !== policy.id || decision.policyVersion !== policy.version) {
    throw new VindexApiError("BAD_REQUEST", "Decision does not belong to the armed policy/version.", 409);
  }
  if (decision.state !== "CONFIRMING" || decision.confirmedAt === null) {
    throw new VindexApiError("BAD_REQUEST", "Decision is not confirmed.", 409);
  }
  const nowMs = now().getTime();
  if (decision.expiresAt === null || decision.expiresAt.getTime() <= nowMs) {
    await writeAudit(db, positionId, "EXECUTION_AUTHORIZATION_FAILED", { executionId, reason: "decision expired" }, execution.decisionId);
    throw new VindexApiError("BAD_REQUEST", "Decision has expired — obtain a fresh confirmation.", 409);
  }

  const config = await getSafeWalletConfig(db);
  const safeWallet = config.safeWallet;
  if (safeWallet === null || safeWallet !== policy.safeWalletSnapshot || safeWallet !== execution.safeWallet) {
    await writeAudit(db, positionId, "EXECUTION_AUTHORIZATION_FAILED", { executionId, reason: "safe wallet mismatch" }, execution.decisionId);
    throw new VindexApiError("INVALID_SAFE_WALLET", "Safe wallet no longer matches the armed snapshot.", 409);
  }

  const parametersHash = exitParametersHash({
    chainId: VINDEX_CHAIN_ID,
    pool,
    asset: usdcUnderlying,
    amount: MAX_UINT256,
    safeWallet,
    decisionId: execution.decisionId,
    policyVersion: policy.version,
  });
  if (parametersHash !== execution.parametersHash) {
    await writeAudit(db, positionId, "EXECUTION_AUTHORIZATION_FAILED", { executionId, reason: "parameters hash mismatch" }, execution.decisionId);
    throw new VindexApiError("BAD_REQUEST", "PREPARATION_CONFLICT — persisted parameters no longer match the canonical intent.", 409);
  }

  let wallet: string;
  try {
    const orgWallet = await keeperHubClient.getOrganizationWallet();
    if (!orgWallet.hasWallet || orgWallet.walletAddress === null) {
      throw new Error("no wallet");
    }
    wallet = orgWallet.walletAddress;
  } catch {
    throw new VindexApiError("KEEPERHUB_UNAVAILABLE", "KeeperHub organization wallet is unavailable.", 502);
  }
  if (canonicalPositionId(wallet) !== positionId) {
    throw new VindexApiError("BAD_REQUEST", "KeeperHub wallet does not own the position.", 409);
  }
  try {
    if (!isKeeperHubHealthy(await keeperHubClient.healthCheck())) {
      throw new Error("not healthy");
    }
  } catch {
    throw new VindexApiError("KEEPERHUB_UNAVAILABLE", "KeeperHub is not reachable/authenticated.", 502);
  }
  try {
    await readCanonicalChainState(rpc);
  } catch (error) {
    if (error instanceof WrongChainError) {
      throw new VindexApiError("WRONG_CHAIN", "The connected chain is not Base Sepolia (84532).", 502);
    }
    throw new VindexApiError("RPC_UNAVAILABLE", "The Base Sepolia RPC is unavailable.", 502);
  }

  const livePosition = await getAaveUsdcPosition(rpc, wallet);
  if (livePosition.aTokenBalanceBaseUnits <= BigInt(0)) {
    await writeAudit(db, positionId, "EXECUTION_AUTHORIZATION_FAILED", { executionId, reason: "zero position" }, execution.decisionId);
    throw new VindexApiError("POSITION_ZERO", "The protected position is zero.", 422);
  }

  const withdrawEntry = POOL_ABI.filter(
    (item) => item.type === "function" && item.name === "withdraw",
  ).map((item) => ({
    type: item.type,
    name: item.name,
    stateMutability: item.stateMutability,
    inputs: item.inputs,
    outputs: item.outputs,
  }))[0];

  const functionArgs = JSON.stringify([usdcUnderlying, MAX_UINT256, safeWallet]);
  const contractCallRequest = {
    contractAddress: pool,
    chainId: VINDEX_CHAIN_ID,
    functionName: "withdraw",
    functionArgs,
    abi: JSON.stringify([withdrawEntry]),
  };

  // --- Recovery states (SUBMISSION_PENDING / SUBMISSION_UNKNOWN / EXECUTION_PENDING) ---
  const recoveryStates = ["SUBMISSION_PENDING", "SUBMISSION_UNKNOWN", "EXECUTION_PENDING"] as const;
  if ((recoveryStates as readonly string[]).includes(execution.status)) {
    if (execution.keeperhubExecutionId !== null) {
      return pollAndVerify({
        db, rpc, keeperHubClient, positionId, executionId, decisionId: execution.decisionId,
        keeperhubExecutionId: execution.keeperhubExecutionId, safeWallet, wallet, now,
      });
    }
    // Ambiguity with no known execution id: retry the SAME idempotency key so
    // KeeperHub replay semantics return the original outcome. Never a new key.
    const idempotencyKey =
      execution.idempotencyKey ?? m7IdempotencyKey(execution.id, execution.parametersHash);
    const submitted = await submitWithKey({
      db, keeperHubClient, positionId, executionId, decisionId: execution.decisionId,
      contractCallRequest, idempotencyKey, now,
    });
    if (submitted.keeperhubExecutionId === null) {
      return resultBase(submitted.state, { keeperhubExecutionId: null, status: execution.lastKeeperHubStatus, errorCode: submitted.state });
    }
    return pollAndVerify({
      db, rpc, keeperHubClient, positionId, executionId, decisionId: execution.decisionId,
      keeperhubExecutionId: submitted.keeperhubExecutionId, safeWallet, wallet, now,
    });
  }

  // --- Fresh flow (SIMULATION_PASSED) --------------------------------------------------
  if (execution.status !== "SIMULATION_PASSED") {
    throw new VindexApiError("BAD_REQUEST", `Execution is not ready (status ${execution.status}).`, 409);
  }
  if (execution.keeperhubExecutionId !== null || execution.txHash !== null || execution.submittedAt !== null) {
    throw new VindexApiError("BAD_REQUEST", "Execution already has broadcast metadata.", 409);
  }
  let simulationOk = false;
  if (execution.simulationId !== null) {
    const simRows = await db
      .select()
      .from(simulations)
      .where(eq(simulations.id, execution.simulationId))
      .limit(1);
    const sim = simRows[0];
    simulationOk = sim !== undefined && sim.success === true && sim.wouldRevert === false;
  }
  if (!simulationOk) {
    throw new VindexApiError("BAD_REQUEST", "Referenced simulation did not succeed.", 409);
  }
  const otherRows = await db
    .select()
    .from(executions)
    .where(
      and(
        eq(executions.decisionId, execution.decisionId),
        sql`${executions.id} <> ${execution.id}`,
        sql`${executions.status} in ('SUBMISSION_PENDING','SUBMISSION_UNKNOWN','EXECUTION_PENDING','EXECUTION_FAILED','EXECUTED_VERIFYING_DESTINATION')`,
      ),
    )
    .limit(1);
  if (otherRows.length > 0) {
    throw new VindexApiError("BAD_REQUEST", "Another evacuation already represents this decision.", 409);
  }

  // Pre-broadcast snapshot + final simulation.
  const blockNumber = (await readCanonicalChainState(rpc)).latestBlock;
  const safeWalletPosition = await getAaveUsdcPosition(rpc, safeWallet);
  const blockTimestamp = now();
  await db
    .update(executions)
    .set({
      prePositionAmount: livePosition.aTokenBalanceBaseUnits.toString(),
      preSafeWalletBalance: safeWalletPosition.underlyingBalanceBaseUnits.toString(),
      preBlockNumber: blockNumber.toString(),
      preBlockTimestamp: blockTimestamp,
      updatedAt: blockTimestamp,
    })
    .where(eq(executions.id, execution.id));

  let finalSimulation: ContractCallSimulation;
  try {
    finalSimulation = await keeperHubClient.simulateContractCall(contractCallRequest);
  } catch (error) {
    await writeAudit(db, positionId, "FINAL_SIMULATION_FAILED", { executionId, reason: error instanceof Error ? error.message : "simulation call failed" }, execution.decisionId);
    throw new VindexApiError("LIVE_READ_FAILED", "Final simulation call failed.", 502);
  }

  const finalSimulationOk =
    finalSimulation.success === true &&
    finalSimulation.status === "simulated" &&
    finalSimulation.wouldRevert === false &&
    finalSimulation.from !== null &&
    finalSimulation.from.toLowerCase() === wallet.toLowerCase() &&
    finalSimulation.to !== null &&
    finalSimulation.to.toLowerCase() === pool.toLowerCase() &&
    finalSimulation.gasEstimate !== null &&
    /^\d+$/.test(finalSimulation.gasEstimate) &&
    BigInt(finalSimulation.gasEstimate) > BigInt(0) &&
    finalSimulation.simulatedReturnValue !== null &&
    finalSimulation.simulatedReturnValue !== undefined &&
    BigInt(String(finalSimulation.simulatedReturnValue)) > BigInt(0);

  await db
    .insert(simulations)
    .values({
      decisionId: execution.decisionId,
      chainId: VINDEX_CHAIN_ID,
      target: pool,
      function: "withdraw",
      parametersJson: JSON.stringify({ asset: usdcUnderlying, amount: MAX_UINT256, to: safeWallet, phase: "final-pre-broadcast" }),
      parametersHash,
      blockNumber: blockNumber.toString(),
      blockTimestamp,
      success: finalSimulationOk,
      wouldRevert: finalSimulation.wouldRevert,
      gasEstimate: finalSimulation.gasEstimate,
      simulatedReturnValue: finalSimulationOk ? String(finalSimulation.simulatedReturnValue) : null,
      revertReason: finalSimulationOk ? null : (finalSimulation.revertReason ?? "final simulation gate failed"),
    })
    .onConflictDoNothing();

  if (!finalSimulationOk) {
    const reason = finalSimulation.wouldRevert
      ? `Final simulation would revert: ${finalSimulation.revertReason ?? "unknown"}`
      : "Final simulation gate failed (sender/target/gas/return).";
    await db
      .update(executions)
      .set({ status: "EXECUTION_FAILED", errorCode: "FINAL_SIMULATION_FAILED", updatedAt: now() })
      .where(eq(executions.id, execution.id));
    await writeAudit(db, positionId, "FINAL_SIMULATION_FAILED", { executionId, reason }, execution.decisionId);
    return resultBase("EXECUTION_FAILED", { errorCode: "FINAL_SIMULATION_FAILED" });
  }
  await writeAudit(db, positionId, "FINAL_SIMULATION_PASSED", { executionId, blockNumber: blockNumber.toString() }, execution.decisionId);

  // Atomic claim: SIMULATION_PASSED -> SUBMISSION_PENDING. Only one winner.
  const idempotencyKey = m7IdempotencyKey(execution.id, parametersHash);
  const broadcastHash = broadcastRequestHash(contractCallRequest);
  const claimed = await db
    .update(executions)
    .set({
      status: "SUBMISSION_PENDING",
      idempotencyKey,
      broadcastRequestHash: broadcastHash,
      updatedAt: now(),
    })
    .where(and(eq(executions.id, execution.id), eq(executions.status, "SIMULATION_PASSED")))
    .returning({ id: executions.id });

  if (claimed.length === 0) {
    // Another caller won the claim — recover instead of broadcasting.
    const current = (await db.select().from(executions).where(eq(executions.id, execution.id)))[0];
    if (current !== undefined) {
      if (current.status === "EXECUTED_VERIFYING_DESTINATION") {
        return { ...resultBase("M7_ALREADY_EXECUTED"), transactionHash: current.txHash };
      }
      return resultBase(current.status as ExecutionState);
    }
    throw new VindexApiError("BAD_REQUEST", "Execution claim lost.", 409);
  }

  await writeAudit(db, positionId, "KEEPERHUB_SUBMISSION_REQUESTED", { executionId, idempotencyKey, parametersHash }, execution.decisionId);

  const submitted = await submitWithKey({
    db, keeperHubClient, positionId, executionId, decisionId: execution.decisionId,
    contractCallRequest, idempotencyKey, now,
  });
  if (submitted.keeperhubExecutionId === null) {
    return resultBase(submitted.state, { errorCode: submitted.state });
  }
  return pollAndVerify({
    db, rpc, keeperHubClient, positionId, executionId, decisionId: execution.decisionId,
    keeperhubExecutionId: submitted.keeperhubExecutionId, safeWallet, wallet, now, pollMaxMs,
  });
};

type SubmitContext = {
  db: VindexDb;
  keeperHubClient: KeeperHubClient;
  positionId: string;
  executionId: string;
  decisionId: string;
  contractCallRequest: { contractAddress: string; chainId: number; functionName: string; functionArgs: string; abi: string };
  idempotencyKey: string;
  now: () => Date;
};

const submitWithKey = async (
  ctx: SubmitContext,
): Promise<{ state: "SUBMISSION_UNKNOWN" | "EXECUTION_PENDING"; keeperhubExecutionId: string | null }> => {
  const { db, keeperHubClient, positionId, executionId, decisionId, contractCallRequest, idempotencyKey, now } = ctx;

  let submission;
  try {
    submission = await keeperHubClient.executeContractCall(contractCallRequest, idempotencyKey);
  } catch {
    await db
      .update(executions)
      .set({ status: "SUBMISSION_UNKNOWN", submissionError: "Broadcast result unknown (timeout/network)", updatedAt: now() })
      .where(eq(executions.id, executionId));
    await writeAudit(db, positionId, "SUBMISSION_UNKNOWN", { executionId, idempotencyKey }, decisionId);
    return { state: "SUBMISSION_UNKNOWN", keeperhubExecutionId: null };
  }

  if (submission.httpStatus === 409 && submission.code === "idempotency_in_progress") {
    await db
      .update(executions)
      .set({ status: "SUBMISSION_PENDING", lastKeeperHubStatus: "idempotency_in_progress", updatedAt: now() })
      .where(eq(executions.id, executionId));
    if (submission.originalExecutionId !== null) {
      await db
        .update(executions)
        .set({ keeperhubExecutionId: submission.originalExecutionId, updatedAt: now() })
        .where(eq(executions.id, executionId));
    }
    await writeAudit(db, positionId, "KEEPERHUB_EXECUTION_ACCEPTED", { executionId, keeperhubExecutionId: submission.originalExecutionId, note: "idempotency_in_progress" }, decisionId);
    return { state: "EXECUTION_PENDING", keeperhubExecutionId: submission.originalExecutionId };
  }
  if (submission.idempotentReplay === true && submission.executionId !== null) {
    await db
      .update(executions)
      .set({ keeperhubExecutionId: submission.executionId, lastKeeperHubStatus: submission.status ?? null, updatedAt: now() })
      .where(eq(executions.id, executionId));
    await writeAudit(db, positionId, "KEEPERHUB_EXECUTION_ACCEPTED", { executionId, keeperhubExecutionId: submission.executionId, note: "idempotent replay adopted" }, decisionId);
    return { state: "EXECUTION_PENDING", keeperhubExecutionId: submission.executionId };
  }
  if (submission.httpStatus === 409 && submission.code === "idempotency_conflict") {
    await db
      .update(executions)
      .set({ status: "EXECUTION_FAILED", errorCode: "IDEMPOTENCY_CONFLICT", submissionError: submission.error ?? "idempotency conflict", updatedAt: now() })
      .where(eq(executions.id, executionId));
    await writeAudit(db, positionId, "EXECUTION_FAILED", { executionId, reason: "idempotency conflict" }, decisionId);
    return { state: "EXECUTION_PENDING", keeperhubExecutionId: null };
  }
  if (submission.httpStatus !== 202 || submission.executionId === null) {
    await db
      .update(executions)
      .set({ status: "EXECUTION_FAILED", errorCode: "SUBMISSION_REJECTED", submissionError: submission.error ?? `HTTP ${submission.httpStatus}`, updatedAt: now() })
      .where(eq(executions.id, executionId));
    await writeAudit(db, positionId, "EXECUTION_FAILED", { executionId, reason: submission.error ?? `HTTP ${submission.httpStatus}` }, decisionId);
    return { state: "EXECUTION_PENDING", keeperhubExecutionId: null };
  }

  const submittedAt = now();
  await db
    .update(executions)
    .set({ keeperhubExecutionId: submission.executionId, lastKeeperHubStatus: submission.status ?? "accepted", submittedAt, updatedAt: submittedAt })
    .where(eq(executions.id, executionId));
  await writeAudit(db, positionId, "KEEPERHUB_EXECUTION_ACCEPTED", { executionId, keeperhubExecutionId: submission.executionId }, decisionId);
  return { state: "EXECUTION_PENDING", keeperhubExecutionId: submission.executionId };
};

type VerifyContext = {
  db: VindexDb;
  rpc: CanonicalReadClient;
  keeperHubClient: KeeperHubClient;
  positionId: string;
  executionId: string;
  decisionId: string;
  keeperhubExecutionId: string;
  safeWallet: string;
  wallet: string;
  now: () => Date;
  pollMaxMs?: number;
};

const pollAndVerify = async (ctx: VerifyContext): Promise<ExecutionResult> => {
  const { db, rpc, positionId, executionId, decisionId, keeperhubExecutionId, safeWallet, wallet, now } = ctx;
  const pollMaxMs = ctx.pollMaxMs ?? M7_POLL_TIMEOUT_MS;

  const { pool, usdcUnderlying } = AAVE_V3_BASE_SEPOLIA;
  const readRow = () => db.select().from(executions).where(eq(executions.id, executionId)).limit(1).then((rows) => rows[0]);

  let status: DirectExecutionStatus;
  try {
    status = await ctx.keeperHubClient.getExecutionStatus(keeperhubExecutionId);
  } catch {
    await db
      .update(executions)
      .set({ status: "EXECUTION_PENDING", lastKeeperHubStatus: "unresolved", updatedAt: now() })
      .where(eq(executions.id, executionId));
    return {
      outcome: "EXECUTION_PENDING",
      executionId,
      decisionId,
      keeperhubExecutionId,
      status: "unresolved",
      transactionHash: null,
      transactionLink: null,
      sponsored: null,
      actualWithdrawAmount: null,
      prePositionAmount: null,
      postPositionAmount: null,
      blockNumber: null,
      errorCode: "EXECUTION_PENDING",
      readyForDestinationVerification: false,
      auditEvents: [],
    };
  }

  const deadline = Date.now() + pollMaxMs;
  while (!status.isTerminal && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, Math.max(status.pollIntervalHintSec, 1) * 1000));
    try {
      status = await ctx.keeperHubClient.getExecutionStatus(keeperhubExecutionId);
    } catch {
      break;
    }
  }

  await db
    .update(executions)
    .set({ lastKeeperHubStatus: status.status ?? null, updatedAt: now() })
    .where(eq(executions.id, executionId));

  const fail = async (errorCode: string, reason: string): Promise<ExecutionResult> => {
    await db
      .update(executions)
      .set({ status: "EXECUTION_FAILED", errorCode, submissionError: reason.slice(0, 500), updatedAt: now() })
      .where(eq(executions.id, executionId));
    await writeAudit(db, positionId, "EXECUTION_FAILED", { executionId, keeperhubExecutionId, reason }, decisionId);
    return {
      outcome: "EXECUTION_FAILED",
      executionId,
      decisionId,
      keeperhubExecutionId,
      status: status.status ?? null,
      transactionHash: null,
      transactionLink: null,
      sponsored: null,
      actualWithdrawAmount: null,
      prePositionAmount: null,
      postPositionAmount: null,
      blockNumber: null,
      errorCode,
      readyForDestinationVerification: false,
      auditEvents: [],
    };
  };

  if (status.status === "failed") {
    return fail("KEEPERHUB_EXECUTION_FAILED", status.error ?? "execution failed");
  }
  if (!status.isTerminal) {
    await db
      .update(executions)
      .set({ status: "EXECUTION_PENDING", updatedAt: now() })
      .where(eq(executions.id, executionId));
    return {
      outcome: "EXECUTION_PENDING",
      executionId,
      decisionId,
      keeperhubExecutionId,
      status: status.status ?? "pending",
      transactionHash: null,
      transactionLink: null,
      sponsored: null,
      actualWithdrawAmount: null,
      prePositionAmount: null,
      postPositionAmount: null,
      blockNumber: null,
      errorCode: "EXECUTION_PENDING",
      readyForDestinationVerification: false,
      auditEvents: [],
    };
  }
  if (status.transactionHash === null) {
    return fail("MISSING_TRANSACTION_HASH", "completed without transaction hash");
  }
  const transactionHash = status.transactionHash;

  await db
    .update(executions)
    .set({
      status: "EXECUTION_PENDING",
      txHash: transactionHash,
      transactionLink: status.transactionLink,
      sponsored: status.sponsored ?? null,
      lastKeeperHubStatus: "completed",
      updatedAt: now(),
    })
    .where(eq(executions.id, executionId));
  await writeAudit(db, positionId, "TRANSACTION_CONFIRMED", { executionId, keeperhubExecutionId, transactionHash, transactionLink: status.transactionLink, sponsored: status.sponsored ?? null }, decisionId, transactionHash);

  let receipt;
  try {
    receipt = await rpc.getTransactionReceipt({ hash: transactionHash as `0x${string}` });
  } catch {
    return fail("RECEIPT_FETCH_FAILED", "receipt fetch failed");
  }
  if (receipt.status !== "success") {
    return fail("RECEIPT_REVERTED", "receipt status not success");
  }

  const withdrawLog = receipt.logs.find(
    (log) => log.address.toLowerCase() === pool.toLowerCase() && log.topics[0] === WITHDRAW_TOPIC,
  );
  if (withdrawLog === undefined) {
    return fail("WITHDRAW_EVENT_MISSING", "Withdraw event not found");
  }
  let withdrawEvent: { reserve: string; user: string; to: string; amount: bigint };
  try {
    const decoded = decodeEventLog({
      abi: POOL_WITHDRAW_EVENT,
      data: withdrawLog.data,
      topics: withdrawLog.topics,
    });
    withdrawEvent = decoded.args as unknown as { reserve: string; user: string; to: string; amount: bigint };
  } catch {
    return fail("WITHDRAW_EVENT_DECODE_FAILED", "Withdraw event decode failed");
  }
  if (
    withdrawEvent.reserve.toLowerCase() !== usdcUnderlying.toLowerCase() ||
    withdrawEvent.user.toLowerCase() !== wallet.toLowerCase() ||
    withdrawEvent.to.toLowerCase() !== safeWallet.toLowerCase() ||
    withdrawEvent.amount <= BigInt(0)
  ) {
    return fail("WITHDRAW_EVENT_MISMATCH", "Withdraw event identity mismatch");
  }

  let postPositionAmount: bigint;
  try {
    const postPosition = await getAaveUsdcPosition(rpc, wallet);
    postPositionAmount = postPosition.aTokenBalanceBaseUnits;
  } catch {
    postPositionAmount = BigInt(0);
  }
  const row = await readRow();
  const prePositionAmount = BigInt(row?.prePositionAmount ?? "0");
  if (prePositionAmount <= BigInt(0) || postPositionAmount >= prePositionAmount) {
    return fail("POSITION_NOT_DECREASED", "aUSDC did not decrease after withdrawal");
  }

  const confirmedAt = now();
  await db
    .update(executions)
    .set({
      status: "EXECUTED_VERIFYING_DESTINATION",
      lastKeeperHubStatus: "completed",
      confirmedAt,
      blockNumber: Number(receipt.blockNumber).toString(),
      updatedAt: confirmedAt,
    })
    .where(eq(executions.id, executionId));
  await writeAudit(db, positionId, "WITHDRAW_EVENT_VERIFIED", {
    executionId,
    transactionHash,
    reserve: withdrawEvent.reserve,
    user: withdrawEvent.user,
    to: withdrawEvent.to,
    amount: withdrawEvent.amount.toString(),
    actualWithdrawAmount: withdrawEvent.amount.toString(),
  }, decisionId, transactionHash);
  await writeAudit(db, positionId, "DESTINATION_VERIFICATION_PENDING", { executionId, transactionHash, preSafeWalletBalance: row?.preSafeWalletBalance ?? null }, decisionId, transactionHash);

  return {
    outcome: "EXECUTED_VERIFYING_DESTINATION",
    executionId,
    decisionId,
    keeperhubExecutionId,
    status: "completed",
    transactionHash,
    transactionLink: status.transactionLink,
    sponsored: status.sponsored ?? null,
    actualWithdrawAmount: withdrawEvent.amount.toString(),
    prePositionAmount: row?.prePositionAmount ?? null,
    postPositionAmount: postPositionAmount.toString(),
    blockNumber: Number(receipt.blockNumber).toString(),
    errorCode: null,
    readyForDestinationVerification: true,
    auditEvents: [],
  };
};

export const getExecutionState = async (
  db: VindexDb,
  executionId: string,
): Promise<ExecutionResult | null> => {
  const rows = await db.select().from(executions).where(eq(executions.id, executionId)).limit(1);
  const execution = rows[0];
  if (execution === undefined) return null;
  return {
    outcome: execution.status as ExecutionState,
    executionId: execution.id,
    decisionId: execution.decisionId,
    keeperhubExecutionId: execution.keeperhubExecutionId,
    status: execution.lastKeeperHubStatus,
    transactionHash: execution.txHash,
    transactionLink: execution.transactionLink,
    sponsored: execution.sponsored,
    actualWithdrawAmount: null,
    prePositionAmount: execution.prePositionAmount,
    postPositionAmount: null,
    blockNumber: execution.blockNumber,
    errorCode: execution.errorCode,
    readyForDestinationVerification: execution.status === "EXECUTED_VERIFYING_DESTINATION",
    auditEvents: [],
  };
};

export const getLatestExecutionState = async (
  db: VindexDb,
  positionId: string,
): Promise<ExecutionResult | null> => {
  const rows = await db
    .select()
    .from(executions)
    .where(sql`${executions.decisionId} in (select id from threat_decisions where position_id = ${positionId})`)
    .orderBy(desc(executions.createdAt))
    .limit(1);
  if (rows[0] === undefined) return null;
  return getExecutionState(db, rows[0].id);
};
