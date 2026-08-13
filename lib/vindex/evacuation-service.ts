// M6 pre-execution validator + withdrawal simulation.
// Turns a CURRENT confirmed decision into one persisted, fully validated
// evacuation intent whose exact Aave withdrawal simulates successfully through
// KeeperHub (simulate:true). ZERO onchain writes; ZERO KeeperHub broadcasts.
import "server-only";

import { createHash } from "node:crypto";
import { desc, eq, sql } from "drizzle-orm";

import type { VindexDb } from "../../db";
import { executions, simulations, threatDecisions } from "../../db/schema";
import { getAaveUsdcPosition } from "./aave-position";
import { AAVE_V3_BASE_SEPOLIA, MAX_UINT256, POOL_ABI } from "./aave-registry";
import { VINDEX_CHAIN_ID, WrongChainError } from "./chain";
import type { VindexEnv } from "./env";
import { VindexApiError } from "./errors";
import {
  createKeeperHubClient,
  isKeeperHubHealthy,
  type ContractCallSimulation,
  type KeeperHubClient,
} from "./keeperhub";
import { readCanonicalChainState, type CanonicalReadClient } from "./public-client";
import { createFailoverPublicClient } from "./rpc-failover";
import { getArmedPolicy, getAuditEvents as policyAudit } from "./policy-service";
import { canonicalPositionId } from "./position-service";
import { getSafeWalletConfig, validateSafeWallet } from "./safe-wallet";
import { getSignalHistory } from "./signal-service";

export const EXIT_FUNCTION = "withdraw" as const;
export const AMOUNT_MODE_FULL_POSITION = "FULL_POSITION" as const;

export type ExecutionPreparationView = {
  executionId: string;
  decisionId: string;
  simulationId: string | null;
  state: string;
  target: string;
  asset: string;
  amountMode: typeof AMOUNT_MODE_FULL_POSITION;
  amountBaseUnits: string;
  safeWallet: string;
  gasEstimate: string | null;
  expectedWithdrawAmount: string | null;
  blockNumber: string | null;
  blockTimestamp: string | null;
  simulatedAt: string | null;
  parametersHash: string;
  readyForExecution: boolean;
  errorCode: string | null;
};

export type PrepareEvacuationOptions = {
  env: VindexEnv;
  db: VindexDb;
  decisionId: string;
  keeperHubClient?: KeeperHubClient;
  publicClient?: CanonicalReadClient;
  now?: () => Date;
};

export const exitParametersHash = (input: {
  chainId: number;
  pool: string;
  asset: string;
  amount: string;
  safeWallet: string;
  decisionId: string;
  policyVersion: number;
}): string =>
  createHash("sha256")
    .update(
      [
        String(input.chainId),
        input.pool,
        input.asset,
        input.amount,
        input.safeWallet,
        input.decisionId,
        String(input.policyVersion),
      ].join("|"),
    )
    .digest("hex");

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

export const getPreparedExecution = async (
  db: VindexDb,
  decisionId: string,
): Promise<ExecutionPreparationView | null> => {
  const rows = await db
    .select()
    .from(executions)
    .where(eq(executions.decisionId, decisionId))
    .limit(1);
  const row = rows[0];
  if (row === undefined) return null;

  let simulation: typeof simulations.$inferSelect | null = null;
  if (row.simulationId !== null) {
    const simRows = await db
      .select()
      .from(simulations)
      .where(eq(simulations.id, row.simulationId))
      .limit(1);
    simulation = simRows[0] ?? null;
  }

  return {
    executionId: row.id,
    decisionId: row.decisionId,
    simulationId: row.simulationId,
    state: row.status,
    target: row.target,
    asset: AAVE_V3_BASE_SEPOLIA.usdcUnderlying,
    amountMode: AMOUNT_MODE_FULL_POSITION,
    amountBaseUnits: row.requestedAmount,
    safeWallet: row.safeWallet,
    gasEstimate: simulation?.gasEstimate ?? null,
    expectedWithdrawAmount: simulation?.simulatedReturnValue ?? null,
    blockNumber: row.blockNumber,
    blockTimestamp: row.blockTimestamp?.toISOString() ?? null,
    simulatedAt: simulation?.createdAt.toISOString() ?? null,
    parametersHash: row.parametersHash,
    readyForExecution: row.status === "SIMULATION_PASSED",
    errorCode: row.errorCode,
  };
};

const blockTimestampOf = async (
  rpc: CanonicalReadClient,
  blockNumber: bigint,
): Promise<Date | null> => {
  try {
    const block = await (
      rpc as unknown as {
        getBlock: (params: { blockNumber: bigint }) => Promise<{ timestamp: bigint }>;
      }
    ).getBlock({ blockNumber });
    return new Date(Number(block.timestamp) * 1000);
  } catch {
    return null;
  }
};

export const prepareEvacuation = async (
  options: PrepareEvacuationOptions,
): Promise<ExecutionPreparationView> => {
  const { env, db, decisionId } = options;
  const now = options.now ?? (() => new Date());

  const keeperHubClient: KeeperHubClient =
    options.keeperHubClient ??
    createKeeperHubClient({ apiKey: env.keeperhubApiKey, baseUrl: env.keeperhubApiBaseUrl });
  const rpc: CanonicalReadClient =
    options.publicClient ?? (createFailoverPublicClient(process.env) as unknown as CanonicalReadClient);

  const decisionRows = await db
    .select()
    .from(threatDecisions)
    .where(eq(threatDecisions.id, decisionId))
    .limit(1);
  const decision = decisionRows[0];
  if (decision === undefined) {
    throw new VindexApiError("BAD_REQUEST", "Decision not found.", 404);
  }

  const { usdcUnderlying, pool, usdcAToken } = AAVE_V3_BASE_SEPOLIA;

  // --- 1. Current authorization (never trusts artifacts) -----------------------
  const positionId = decision.positionId;
  await writeAudit(db, positionId, "PRE_EXECUTION_VALIDATION_STARTED", { decisionId });

  const policy = await getArmedPolicy(db, positionId);
  if (policy === null) {
    await writeAudit(db, positionId, "PRE_EXECUTION_VALIDATION_FAILED", { decisionId, reason: "policy is not armed" }, decisionId);
    throw new VindexApiError("POLICY_ARMED_RECONFIGURE_REQUIRED", "No armed policy for this position.", 409);
  }
  if (decision.policyId !== policy.id || decision.policyVersion !== policy.version) {
    await writeAudit(db, positionId, "PRE_EXECUTION_VALIDATION_FAILED", { decisionId, reason: "decision does not belong to the armed policy/version" }, decisionId);
    throw new VindexApiError("BAD_REQUEST", "Decision does not belong to the currently armed policy/version.", 409);
  }
  if (decision.state !== "CONFIRMING" || decision.confirmedAt === null) {
    await writeAudit(db, positionId, "PRE_EXECUTION_VALIDATION_FAILED", { decisionId, reason: "decision is not confirmed" }, decisionId);
    throw new VindexApiError("BAD_REQUEST", "Decision is not a confirmed CONFIRMING decision.", 409);
  }
  const nowMs = now().getTime();
  if (decision.expiresAt === null || decision.expiresAt.getTime() <= nowMs) {
    await writeAudit(db, positionId, "PRE_EXECUTION_VALIDATION_FAILED", { decisionId, reason: "decision expired" }, decisionId);
    throw new VindexApiError("BAD_REQUEST", "Decision has expired.", 409);
  }

  // Confirmation evidence must still exist (contributing observations).
  let contributingSignalIds: string[] = [];
  try {
    contributingSignalIds = JSON.parse(decision.contributingSignalIds ?? "[]") as string[];
  } catch {
    contributingSignalIds = [];
  }
  if (contributingSignalIds.length > 0) {
    const history = await getSignalHistory(db, positionId, { limit: 500 });
    const historyIds = new Set(history.map((o) => o.id));
    const missing = contributingSignalIds.filter((id) => !historyIds.has(id));
    if (missing.length > 0) {
      await writeAudit(db, positionId, "PRE_EXECUTION_VALIDATION_FAILED", { decisionId, reason: `${missing.length} contributing observation(s) no longer exist` }, decisionId);
      throw new VindexApiError("BAD_REQUEST", "Confirmation evidence (contributing observations) is no longer valid.", 409);
    }
  }

  // --- 2. Chain -----------------------------------------------------------------
  let blockNumber: bigint;
  try {
    blockNumber = (await readCanonicalChainState(rpc)).latestBlock;
  } catch (error) {
    if (error instanceof WrongChainError) {
      await writeAudit(db, positionId, "PRE_EXECUTION_VALIDATION_FAILED", { decisionId, reason: "wrong chain" }, decisionId);
      throw new VindexApiError("WRONG_CHAIN", "The connected chain is not Base Sepolia (84532).", 502);
    }
    await writeAudit(db, positionId, "PRE_EXECUTION_VALIDATION_FAILED", { decisionId, reason: "rpc unavailable" }, decisionId);
    throw new VindexApiError("RPC_UNAVAILABLE", "The Base Sepolia RPC is unavailable.", 502);
  }

  // --- 3. KeeperHub wallet + health ----------------------------------------------
  let wallet: string;
  try {
    const orgWallet = await keeperHubClient.getOrganizationWallet();
    if (!orgWallet.hasWallet || orgWallet.invalidAddress || orgWallet.walletAddress === null) {
      throw new Error("no wallet");
    }
    wallet = orgWallet.walletAddress;
  } catch {
    await writeAudit(db, positionId, "PRE_EXECUTION_VALIDATION_FAILED", { decisionId, reason: "keeperhub wallet unavailable" }, decisionId);
    throw new VindexApiError("KEEPERHUB_UNAVAILABLE", "KeeperHub organization wallet is unavailable.", 502);
  }
  if (canonicalPositionId(wallet) !== positionId) {
    await writeAudit(db, positionId, "PRE_EXECUTION_VALIDATION_FAILED", { decisionId, reason: "keeperhub wallet does not own the position" }, decisionId);
    throw new VindexApiError("BAD_REQUEST", "KeeperHub wallet does not match the decision position owner.", 409);
  }
  let keeperHubHealthy = false;
  try {
    keeperHubHealthy = isKeeperHubHealthy(await keeperHubClient.healthCheck());
  } catch {
    keeperHubHealthy = false;
  }
  if (!keeperHubHealthy) {
    await writeAudit(db, positionId, "PRE_EXECUTION_VALIDATION_FAILED", { decisionId, reason: "keeperhub not authenticated/reachable" }, decisionId);
    throw new VindexApiError("KEEPERHUB_UNAVAILABLE", "KeeperHub is not reachable/authenticated.", 502);
  }

  // --- 4. Destination pinning ------------------------------------------------------
  const config = await getSafeWalletConfig(db);
  const safeWallet = config.safeWallet;
  if (safeWallet === null || safeWallet !== policy.safeWalletSnapshot) {
    await writeAudit(db, positionId, "PRE_EXECUTION_VALIDATION_FAILED", { decisionId, reason: "safe wallet does not match armed snapshot" }, decisionId);
    throw new VindexApiError("INVALID_SAFE_WALLET", "The configured safe wallet no longer matches the armed policy snapshot.", 409);
  }
  const walletValidation = validateSafeWallet(safeWallet, wallet);
  if (!walletValidation.valid) {
    await writeAudit(db, positionId, "PRE_EXECUTION_VALIDATION_FAILED", { decisionId, reason: walletValidation.reason }, decisionId);
    throw new VindexApiError("INVALID_SAFE_WALLET", walletValidation.reason, 409);
  }

  // --- 5. Position + allowlist ------------------------------------------------------
  if (pool !== AAVE_V3_BASE_SEPOLIA.pool || usdcUnderlying !== AAVE_V3_BASE_SEPOLIA.usdcUnderlying) {
    throw new VindexApiError("BAD_REQUEST", "Canonical allowlist mismatch.", 500);
  }
  let position;
  try {
    position = await getAaveUsdcPosition(rpc, wallet);
  } catch {
    await writeAudit(db, positionId, "PRE_EXECUTION_VALIDATION_FAILED", { decisionId, reason: "position read failed" }, decisionId);
    throw new VindexApiError("LIVE_READ_FAILED", "Could not read the current Aave position.", 502);
  }
  if (position.aTokenBalanceBaseUnits <= BigInt(0)) {
    await writeAudit(db, positionId, "PRE_EXECUTION_VALIDATION_FAILED", { decisionId, reason: "zero position" }, decisionId);
    throw new VindexApiError("POSITION_ZERO", "The protected position is zero — nothing to withdraw.", 422);
  }
  if (position.aToken.toLowerCase() !== usdcAToken.toLowerCase()) {
    await writeAudit(db, positionId, "PRE_EXECUTION_VALIDATION_FAILED", { decisionId, reason: "aToken mapping mismatch" }, decisionId);
    throw new VindexApiError("BAD_REQUEST", "aToken mapping does not match the canonical aUSDC.", 409);
  }

  // --- 6. Idempotency ----------------------------------------------------------------
  const parametersHash = exitParametersHash({
    chainId: VINDEX_CHAIN_ID,
    pool,
    asset: usdcUnderlying,
    amount: MAX_UINT256,
    safeWallet,
    decisionId,
    policyVersion: policy.version,
  });
  const existing = await getPreparedExecution(db, decisionId);
  if (existing !== null) {
    if (existing.parametersHash === parametersHash) {
      return existing;
    }
    await writeAudit(db, positionId, "PRE_EXECUTION_VALIDATION_FAILED", { decisionId, reason: "parameters conflict" }, decisionId);
    throw new VindexApiError("BAD_REQUEST", "PREPARATION_CONFLICT — the same decision produced different withdrawal parameters.", 409);
  }

  // --- 7. Persist PREPARED execution metadata ----------------------------------------
  const blockTimestamp = await blockTimestampOf(rpc, blockNumber);
  const preparedAt = now();
  const prepared = await db
    .insert(executions)
    .values({
      decisionId,
      status: "PREPARED",
      chainId: VINDEX_CHAIN_ID,
      target: pool,
      function: EXIT_FUNCTION,
      parametersHash,
      requestedAmount: MAX_UINT256,
      safeWallet,
      blockNumber: blockNumber.toString(),
      blockTimestamp,
      updatedAt: preparedAt,
    })
    .onConflictDoNothing()
    .returning();
  const executionRow = prepared[0];
  if (executionRow === undefined) {
    // Concurrent preparation — return the existing one.
    const again = await getPreparedExecution(db, decisionId);
    if (again !== null) return again;
    throw new VindexApiError("BAD_REQUEST", "Could not prepare the execution.", 409);
  }

  // --- 8. KeeperHub simulate:true ------------------------------------------------------
  await writeAudit(db, positionId, "SIMULATION_STARTED", { decisionId, executionId: executionRow.id, parametersHash }, decisionId);

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
  const parametersJson = JSON.stringify({
    asset: usdcUnderlying,
    amount: MAX_UINT256,
    amountMode: AMOUNT_MODE_FULL_POSITION,
    to: safeWallet,
  });

  let simulation: ContractCallSimulation;
  try {
    simulation = await keeperHubClient.simulateContractCall({
      contractAddress: pool,
      chainId: VINDEX_CHAIN_ID,
      functionName: EXIT_FUNCTION,
      functionArgs,
      abi: JSON.stringify([withdrawEntry]),
    });
  } catch (error) {
    const reason = error instanceof Error ? error.message : "simulation call failed";
    await db
      .insert(simulations)
      .values({
        decisionId,
        chainId: VINDEX_CHAIN_ID,
        target: pool,
        function: EXIT_FUNCTION,
        parametersJson,
        parametersHash,
        blockNumber: blockNumber.toString(),
        blockTimestamp,
        success: false,
        wouldRevert: true,
        revertReason: reason,
      })
      .returning({ id: simulations.id })
      .then((rows) => rows[0]?.id);
    await db
      .update(executions)
      .set({ status: "BLOCKED", errorCode: "SIMULATION_FAILED", updatedAt: now() })
      .where(eq(executions.id, executionRow.id));
    await writeAudit(db, positionId, "SIMULATION_FAILED", { decisionId, executionId: executionRow.id, reason }, decisionId);
    return {
      executionId: executionRow.id,
      decisionId,
      simulationId: null,
      state: "BLOCKED",
      target: pool,
      asset: usdcUnderlying,
      amountMode: AMOUNT_MODE_FULL_POSITION,
      amountBaseUnits: MAX_UINT256,
      safeWallet,
      gasEstimate: null,
      expectedWithdrawAmount: null,
      blockNumber: blockNumber.toString(),
      blockTimestamp: blockTimestamp?.toISOString() ?? null,
      simulatedAt: null,
      parametersHash,
      readyForExecution: false,
      errorCode: "SIMULATION_FAILED",
    };
  }

  const gateFailure =
    simulation.wouldRevert
      ? `Simulation would revert: ${simulation.revertReason ?? simulation.error ?? "unknown reason"}`
      : simulation.success !== true
        ? `Simulation did not succeed: ${simulation.error ?? "unknown error"}`
        : simulation.status !== "simulated"
          ? `Simulation returned unexpected status: ${simulation.status ?? "none"}`
          : simulation.from === null || simulation.from.toLowerCase() !== wallet.toLowerCase()
            ? "Simulation sender mismatch."
            : simulation.to === null || simulation.to.toLowerCase() !== pool.toLowerCase()
              ? "Simulation target mismatch."
              : simulation.gasEstimate === null || !/^\d+$/.test(simulation.gasEstimate) || BigInt(simulation.gasEstimate) <= BigInt(0)
                ? "Simulation produced no valid gas estimate."
                : null;

  if (gateFailure !== null) {
    const simRows = await db
      .insert(simulations)
      .values({
        decisionId,
        chainId: VINDEX_CHAIN_ID,
        target: pool,
        function: EXIT_FUNCTION,
        parametersJson,
        parametersHash,
        blockNumber: blockNumber.toString(),
        blockTimestamp,
        success: false,
        wouldRevert: simulation.wouldRevert,
        gasEstimate: simulation.gasEstimate,
        revertReason: simulation.revertReason ?? gateFailure,
      })
      .returning({ id: simulations.id });
    const simulationId = simRows[0]?.id ?? null;
    await db
      .update(executions)
      .set({ status: "BLOCKED", simulationId, errorCode: "SIMULATION_FAILED", updatedAt: now() })
      .where(eq(executions.id, executionRow.id));
    await writeAudit(db, positionId, "SIMULATION_FAILED", { decisionId, executionId: executionRow.id, reason: gateFailure }, decisionId);
    return {
      executionId: executionRow.id,
      decisionId,
      simulationId,
      state: "BLOCKED",
      target: pool,
      asset: usdcUnderlying,
      amountMode: AMOUNT_MODE_FULL_POSITION,
      amountBaseUnits: MAX_UINT256,
      safeWallet,
      gasEstimate: simulation.gasEstimate,
      expectedWithdrawAmount: null,
      blockNumber: blockNumber.toString(),
      blockTimestamp: blockTimestamp?.toISOString() ?? null,
      simulatedAt: null,
      parametersHash,
      readyForExecution: false,
      errorCode: "SIMULATION_FAILED",
    };
  }

  // --- 9. Persist the successful simulation and finalize PREPARED -> SIMULATION_PASSED --
  const simulatedReturnValue =
    simulation.simulatedReturnValue !== null && simulation.simulatedReturnValue !== undefined
      ? String(simulation.simulatedReturnValue)
      : null;

  const simRows = await db
    .insert(simulations)
    .values({
      decisionId,
      chainId: VINDEX_CHAIN_ID,
      target: pool,
      function: EXIT_FUNCTION,
      parametersJson,
      parametersHash,
      blockNumber: blockNumber.toString(),
      blockTimestamp,
      success: true,
      wouldRevert: false,
      gasEstimate: simulation.gasEstimate,
      simulatedReturnValue,
      revertReason: null,
    })
    .returning({ id: simulations.id });
  const simulationId = simRows[0]?.id ?? null;

  await db
    .update(executions)
    .set({ status: "SIMULATION_PASSED", simulationId, updatedAt: now() })
    .where(eq(executions.id, executionRow.id));

  await writeAudit(db, positionId, "SIMULATION_PASSED", { decisionId, executionId: executionRow.id, simulationId, blockNumber: blockNumber.toString() }, decisionId, blockNumber.toString());
  await writeAudit(db, positionId, "EXECUTION_PREPARED", { decisionId, executionId: executionRow.id, simulationId, parametersHash }, decisionId);

  return {
    executionId: executionRow.id,
    decisionId,
    simulationId,
    state: "SIMULATION_PASSED",
    target: pool,
    asset: usdcUnderlying,
    amountMode: AMOUNT_MODE_FULL_POSITION,
    amountBaseUnits: MAX_UINT256,
    safeWallet,
    gasEstimate: simulation.gasEstimate,
    expectedWithdrawAmount: simulatedReturnValue,
    blockNumber: blockNumber.toString(),
    blockTimestamp: blockTimestamp?.toISOString() ?? null,
    simulatedAt: now().toISOString(),
    parametersHash,
    readyForExecution: true,
    errorCode: null,
  };
};

export const getLatestPreparedExecution = async (
  db: VindexDb,
  positionId: string,
): Promise<ExecutionPreparationView | null> => {
  const rows = await db
    .select()
    .from(executions)
    .where(sql`${executions.decisionId} in (select id from threat_decisions where position_id = ${positionId})`)
    .orderBy(desc(executions.createdAt))
    .limit(1);
  if (rows[0] === undefined) return null;
  return getPreparedExecution(db, rows[0].decisionId);
};

export { policyAudit };
