// D1 live website demo controller. Three responsibilities:
//
// 1. Authoritative lifecycle status view for GET /api/vindex/demo/status —
//    derived from persisted rows ONLY (the DB is the source of truth, never a
//    fake animation). The only write is the idempotent self-heal: when the
//    last protection event is PROTECTED but a policy armed BEFORE the receipt
//    is still armed (the legacy M10 state), settle the lifecycle once so the
//    first read self-corrects. Policies armed AFTER the receipt are live
//    protection sessions and are never settled by a status read. No secrets
//    are ever included in the view.
// 2. Process-local in-flight job guard (Map keyed by positionId). It only
//    prevents duplicate button clicks inside one server process; the
//    demo_runs partial unique index on (position_id) is the cross-process
//    backstop.
// 3. Fire-and-forget background runners for prepareDemoPosition /
//    runDemoDrill. The route returns { runId, started: true } immediately and
//    the UI polls the status view; failures are persisted on the run row as
//    errorCode and surfaced truthfully.
import "server-only";

import { and, desc, eq, sql } from "drizzle-orm";

import type { VindexDb } from "../../db";
import {
  auditEvents,
  demoRuns,
  executions,
  protectedPositions,
  protectionPolicies,
  rescueReceipts,
  signalObservations,
  threatDecisions,
  verificationChecks,
} from "../../db/schema";
import { getAaveUsdcPosition } from "./aave-position";
import { WrongChainError } from "./chain";
import {
  getActiveDemoRun,
  prepareDemoPosition,
  runDemoDrill,
  type DemoRunOptions,
  type DemoRunStatus,
} from "./demo-run";
import type { VindexEnv } from "./env";
import { VindexApiError } from "./errors";
import {
  createKeeperHubClient,
  isKeeperHubHealthy,
  type KeeperHubClient,
} from "./keeperhub";
import { getArmedPolicy, settleCompletedProtection } from "./policy-service";
import { DRILL_LABEL } from "./policy-templates";
import { canonicalPositionId } from "./position-service";
import type { CanonicalReadClient } from "./public-client";
import { createFailoverPublicClient } from "./rpc-failover";
import { getSafeWalletConfig, validateSafeWallet } from "./safe-wallet";

// ---------------------------------------------------------------------------
// In-flight job guard
// ---------------------------------------------------------------------------

export type DemoJobKind = "prepare" | "drill";

/** Module-level, process-local: one demo job per position at a time. */
const inFlightJobs = new Map<string, DemoJobKind>();

export const tryAcquireDemoJob = (positionId: string, kind: DemoJobKind): boolean => {
  if (inFlightJobs.has(positionId)) return false;
  inFlightJobs.set(positionId, kind);
  return true;
};

export const releaseDemoJob = (positionId: string): void => {
  inFlightJobs.delete(positionId);
};

export const getInFlightDemoJob = (positionId: string): DemoJobKind | null =>
  inFlightJobs.get(positionId) ?? null;

/** Uppercase job label for the status view ("PREPARING" | "DRILLING"). */
export const demoJobTypeLabel = (kind: DemoJobKind | null): "PREPARING" | "DRILLING" | null =>
  kind === "prepare" ? "PREPARING" : kind === "drill" ? "DRILLING" : null;

// ---------------------------------------------------------------------------
// Background runners
// ---------------------------------------------------------------------------

const log = (...args: unknown[]): void => {
  console.warn("[vindex-demo]", ...args);
};

// Backstop for unexpected errors that bypassed setRunStatus: persist the
// failure on the run row so the status view can surface it truthfully.
const markRunFailed = async (
  db: VindexDb,
  runId: string,
  errorCode: string,
  completedAt: Date,
): Promise<void> => {
  const rows = await db
    .select({ status: demoRuns.status })
    .from(demoRuns)
    .where(eq(demoRuns.id, runId))
    .limit(1);
  const row = rows[0];
  if (row === undefined || row.status === "FAILED" || row.status === "PROTECTED") return;
  await db
    .update(demoRuns)
    .set({ status: "FAILED", errorCode, completedAt, updatedAt: completedAt })
    .where(eq(demoRuns.id, runId));
};

const errorCodeFrom = (error: unknown): string =>
  error instanceof VindexApiError ? error.code : "UNEXPECTED_DEMO_ERROR";

type RunnerOptions = Pick<DemoRunOptions, "keeperHubClient" | "publicClient" | "now">;

/**
 * Fire-and-forget runner for prepareDemoPosition. The run row must already
 * exist (created or adopted by the route). The guard is held for the whole
 * job; errors are swallowed after being persisted on the run row. Returns the
 * underlying promise so tests can await completion.
 */
export const startDemoPrepare = (
  env: VindexEnv,
  db: VindexDb,
  runId: string,
  options: RunnerOptions = {},
): Promise<void> => {
  const now = options.now ?? (() => new Date());
  const job = (async () => {
    const rows = await db
      .select({ positionId: demoRuns.positionId })
      .from(demoRuns)
      .where(eq(demoRuns.id, runId))
      .limit(1);
    const positionId = rows[0]?.positionId;
    if (positionId === undefined) return; // run vanished — nothing to do
    if (!tryAcquireDemoJob(positionId, "prepare")) return; // another job won the race
    try {
      await prepareDemoPosition({ env, db, ...options });
    } catch (error) {
      await markRunFailed(db, runId, errorCodeFrom(error), now());
      log("prepare demo position failed", { runId, code: errorCodeFrom(error) });
    } finally {
      releaseDemoJob(positionId);
    }
  })();
  // Defensive: a failure before the inner try (e.g. the run-row read) must
  // not crash the process; the job promise itself never rejects.
  job.catch((error) => log("startDemoPrepare crashed", error));
  return job;
};

/**
 * Fire-and-forget runner for runDemoDrill. Same guard semantics as
 * startDemoPrepare.
 */
export const startDemoDrill = (
  env: VindexEnv,
  db: VindexDb,
  runId: string,
  options: RunnerOptions = {},
): Promise<void> => {
  const now = options.now ?? (() => new Date());
  const job = (async () => {
    const rows = await db
      .select({ positionId: demoRuns.positionId })
      .from(demoRuns)
      .where(eq(demoRuns.id, runId))
      .limit(1);
    const positionId = rows[0]?.positionId;
    if (positionId === undefined) return;
    if (!tryAcquireDemoJob(positionId, "drill")) return;
    try {
      await runDemoDrill({ env, db, runId, ...options });
    } catch (error) {
      await markRunFailed(db, runId, errorCodeFrom(error), now());
      log("demo drill failed", { runId, code: errorCodeFrom(error) });
    } finally {
      releaseDemoJob(positionId);
    }
  })();
  job.catch((error) => log("startDemoDrill crashed", error));
  return job;
};

// ---------------------------------------------------------------------------
// Status view
// ---------------------------------------------------------------------------

export const DRILL_STAGES = [
  "WATCHING",
  "THREAT_EVIDENCE",
  "MATCHED",
  "CONFIRMING",
  "SIMULATION_PASSED",
  "KEEPERHUB_SUBMISSION",
  "EXECUTING",
  "TRANSACTION_CONFIRMED",
  "VERIFYING_DESTINATION",
  "PROTECTED",
] as const;

export type DrillStage = (typeof DRILL_STAGES)[number];

const STAGE_LABELS: Record<DrillStage, string> = {
  WATCHING: "Watching",
  THREAT_EVIDENCE: "Threat evidence",
  MATCHED: "Matched",
  CONFIRMING: "Confirming",
  SIMULATION_PASSED: "Simulation passed",
  KEEPERHUB_SUBMISSION: "KeeperHub submission",
  EXECUTING: "Executing",
  TRANSACTION_CONFIRMED: "Transaction confirmed",
  VERIFYING_DESTINATION: "Verifying destination",
  PROTECTED: "Protected",
};

export type DemoActiveRunView = {
  runId: string;
  status: DemoRunStatus;
  fundingExecutionId: string | null;
  approvalExecutionId: string | null;
  supplyExecutionId: string | null;
  policyId: string | null;
  decisionId: string | null;
  evacuationExecutionId: string | null;
  rescueReceiptId: string | null;
  errorCode: string | null;
  startedAt: string;
  updatedAt: string;
  stageExecutionIds: { fund: string | null; approve: string | null; supply: string | null };
  transactionHashes: { fund: string | null; approve: string | null; supply: string | null; evacuation: string | null };
  transactionLinks: { fund: string | null; approve: string | null; supply: string | null; evacuation: string | null };
  keeperhubExecutionId: string | null;
  lastKeeperHubStatus: string | null;
};

export type DemoProtectionEventView = {
  status: "PROTECTED";
  receiptId: string;
  executionId: string;
  txHash: string | null;
  keeperhubExecutionId: string | null;
  verifiedAmount: string | null;
  expectedAmount: string | null;
  withdrawnAmount: string | null;
  safeWallet: string | null;
  destination: string | null;
  completedAt: string | null;
};

export type DemoCurrentPositionView = {
  exists: boolean;
  positionAmountBaseUnits: string;
  underlyingWalletBalance: string;
  live: boolean;
  observedAt: string | null;
};

export type DemoProtectionView = {
  armed: boolean;
  mode: string | null;
  policyId: string | null;
  armedAt: string | null;
};

export type DemoDrillProgressView = {
  stage: DrillStage;
  label: string;
  matchedCount: number;
  requiredSignals: number | null;
  drillLabel: string | null;
};

export type DemoValidationView = {
  readyToPrepare: boolean;
  readyToArm: boolean;
  readyToRunDrill: boolean;
  reasons: string[];
  inFlightJob: "PREPARING" | "DRILLING" | null;
};

export type DemoLifecycleStatusView = {
  positionId: string | null;
  activeRun: DemoActiveRunView | null;
  lastProtectionEvent: DemoProtectionEventView | null;
  currentPosition: DemoCurrentPositionView;
  protection: DemoProtectionView;
  drillProgress: DemoDrillProgressView;
  validation: DemoValidationView;
};

type StatusOptions = {
  keeperHubClient?: KeeperHubClient;
  publicClient?: ReturnType<typeof createFailoverPublicClient>;
  now?: () => Date;
};

type RunRow = typeof demoRuns.$inferSelect;
type ExecutionRow = typeof executions.$inferSelect;

// Latest run for the position that is NOT PROTECTED. Includes FAILED runs so
// the view can surface the truthful errorCode to the failure panel; a
// PROTECTED run is never "active" — it is represented by lastProtectionEvent.
const latestActiveRunRow = async (db: VindexDb, positionId: string): Promise<RunRow | null> => {
  const rows = await db
    .select()
    .from(demoRuns)
    .where(and(eq(demoRuns.positionId, positionId), sql`${demoRuns.status} <> 'PROTECTED'`))
    .orderBy(desc(demoRuns.createdAt))
    .limit(1);
  return rows[0] ?? null;
};

const runHasInProgress = (run: RunRow | null): boolean =>
  run !== null && run.status !== "FAILED";

// DEMO_STAGE_VERIFIED audit entries carry the per-stage KeeperHub execution
// id + verified transaction hash/link for this run (written by the shared
// stage runner). This is the persisted evidence for the prepare section.
const stageTxFromAudits = async (
  db: VindexDb,
  positionId: string,
  runId: string,
): Promise<Record<string, { executionId: string | null; transactionHash: string | null; transactionLink: string | null }>> => {
  const rows = await db
    .select()
    .from(auditEvents)
    .where(and(eq(auditEvents.positionId, positionId), eq(auditEvents.eventType, "DEMO_STAGE_VERIFIED")))
    .orderBy(desc(auditEvents.createdAt))
    .limit(100);
  const runPrefix = runId.slice(0, 8);
  const result: Record<string, { executionId: string | null; transactionHash: string | null; transactionLink: string | null }> = {};
  for (const row of rows) {
    let details: Record<string, unknown>;
    try {
      details = JSON.parse(row.detailsJson) as Record<string, unknown>;
    } catch {
      continue;
    }
    const stage = details.stage;
    if (typeof stage !== "string" || details.runId !== runPrefix) continue;
    result[stage] = {
      executionId: typeof details.keeperhubExecutionId === "string" ? details.keeperhubExecutionId : null,
      transactionHash: typeof details.transactionHash === "string" ? details.transactionHash : null,
      transactionLink: typeof details.transactionLink === "string" ? details.transactionLink : null,
    };
  }
  return result;
};

const activeRunView = async (
  db: VindexDb,
  run: RunRow,
  positionId: string,
): Promise<DemoActiveRunView> => {
  const stageTx = await stageTxFromAudits(db, positionId, run.id);
  const execution: ExecutionRow | null = run.evacuationExecutionId !== null
    ? (await db.select().from(executions).where(eq(executions.id, run.evacuationExecutionId)).limit(1))[0] ?? null
    : null;
  return {
    runId: run.id,
    status: run.status as DemoRunStatus,
    fundingExecutionId: run.fundingExecutionId,
    approvalExecutionId: run.approvalExecutionId,
    supplyExecutionId: run.supplyExecutionId,
    policyId: run.policyId,
    decisionId: run.decisionId,
    evacuationExecutionId: run.evacuationExecutionId,
    rescueReceiptId: run.rescueReceiptId,
    errorCode: run.errorCode,
    startedAt: run.startedAt.toISOString(),
    updatedAt: run.updatedAt.toISOString(),
    stageExecutionIds: {
      fund: run.fundingExecutionId,
      approve: run.approvalExecutionId,
      supply: run.supplyExecutionId,
    },
    transactionHashes: {
      fund: stageTx.fund?.transactionHash ?? null,
      approve: stageTx.approve?.transactionHash ?? null,
      supply: stageTx.supply?.transactionHash ?? null,
      evacuation: execution?.txHash ?? null,
    },
    transactionLinks: {
      fund: stageTx.fund?.transactionLink ?? null,
      approve: stageTx.approve?.transactionLink ?? null,
      supply: stageTx.supply?.transactionLink ?? null,
      evacuation: execution?.transactionLink ?? null,
    },
    keeperhubExecutionId: execution?.keeperhubExecutionId ?? null,
    lastKeeperHubStatus: execution?.lastKeeperHubStatus ?? null,
  };
};

const latestProtectionEvent = async (
  db: VindexDb,
  positionId: string,
): Promise<DemoProtectionEventView | null> => {
  const rows = await db
    .select()
    .from(rescueReceipts)
    .where(eq(rescueReceipts.positionId, positionId))
    .orderBy(desc(rescueReceipts.createdAt))
    .limit(1);
  const receipt = rows[0];
  if (receipt === undefined) return null;

  // buildReceiptJson persists expectedWithdraw (simulated return value) and
  // withdrawn (actual onchain withdrawal) on the receipt row. Surface them
  // next to verifiedAmount so the demo UI can show the full amount set;
  // a malformed/unparseable receiptJson degrades the two fields to null.
  let expectedAmount: string | null = null;
  let withdrawnAmount: string | null = null;
  try {
    const details = JSON.parse(receipt.receiptJson) as Record<string, unknown>;
    if (typeof details.expectedWithdraw === "string") expectedAmount = details.expectedWithdraw;
    if (typeof details.withdrawn === "string") withdrawnAmount = details.withdrawn;
  } catch {
    // keep both null — the view never fabricates amounts
  }

  const execution: ExecutionRow | null = (await db.select().from(executions).where(eq(executions.id, receipt.executionId)).limit(1))[0] ?? null;
  return {
    status: "PROTECTED",
    receiptId: receipt.id,
    executionId: receipt.executionId,
    txHash: execution?.txHash ?? receipt.txHash,
    keeperhubExecutionId: execution?.keeperhubExecutionId ?? receipt.keeperhubExecutionId,
    verifiedAmount: receipt.verifiedAmount,
    expectedAmount,
    withdrawnAmount,
    safeWallet: execution?.safeWallet ?? receipt.destination,
    destination: receipt.destination,
    completedAt: receipt.createdAt.toISOString(),
  };
};

// Best-effort live position read with a persisted-snapshot fallback. The
// status endpoint must stay resilient when the chain read fails, so this
// never throws.
const currentPositionView = async (
  db: VindexDb,
  positionId: string,
  wallet: string,
  publicClient: CanonicalReadClient | null,
  now: () => Date,
): Promise<DemoCurrentPositionView> => {
  if (publicClient !== null) {
    try {
      const live = await getAaveUsdcPosition(publicClient, wallet);
      const positionAmountBaseUnits = live.aTokenBalanceBaseUnits.toString();
      return {
        exists: live.aTokenBalanceBaseUnits > BigInt(0),
        positionAmountBaseUnits,
        underlyingWalletBalance: live.underlyingBalanceBaseUnits.toString(),
        live: true,
        observedAt: now().toISOString(),
      };
    } catch {
      // fall through to the persisted snapshot
    }
  }
  const snapshot = (await db.select().from(protectedPositions).where(eq(protectedPositions.id, positionId)).limit(1))[0] ?? null;
  if (snapshot === null) {
    return {
      exists: false,
      positionAmountBaseUnits: "0",
      underlyingWalletBalance: "0",
      live: false,
      observedAt: null,
    };
  }
  const positionAmountBaseUnits = snapshot.latestPositionAmount;
  return {
    exists: BigInt(positionAmountBaseUnits) > BigInt(0),
    positionAmountBaseUnits,
    underlyingWalletBalance: snapshot.latestUnderlyingWalletBalance,
    live: false,
    observedAt: snapshot.observedAt.toISOString(),
  };
};

const protectionView = async (db: VindexDb, positionId: string): Promise<DemoProtectionView> => {
  const armed = await getArmedPolicy(db, positionId);
  if (armed === null) return { armed: false, mode: null, policyId: null, armedAt: null };
  return {
    armed: true,
    mode: armed.mode,
    policyId: armed.id,
    armedAt: armed.armedAt?.toISOString() ?? null,
  };
};

// Authoritative drill progress stage, derived from persisted rows ONLY:
// WATCHING -> THREAT_EVIDENCE -> MATCHED (N/M) -> CONFIRMING ->
// SIMULATION_PASSED -> KEEPERHUB_SUBMISSION -> EXECUTING ->
// TRANSACTION_CONFIRMED -> VERIFYING_DESTINATION -> PROTECTED. PROTECTED
// requires a rescue_receipts row — never derived from execution status alone.
const deriveDrillProgress = async (
  db: VindexDb,
  run: RunRow | null,
  positionId: string,
  protectedEvent: DemoProtectionEventView | null,
): Promise<Omit<DemoDrillProgressView, "label">> => {
  const drillLabel = run !== null && (run.decisionId !== null || run.evacuationExecutionId !== null) ? DRILL_LABEL : null;

  // PROTECTED is a terminal position state, not a run state: no active run
  // plus a verified receipt means the last demo completed.
  if (run === null) {
    return protectedEvent !== null
      ? { stage: "PROTECTED", matchedCount: 0, requiredSignals: null, drillLabel: null }
      : { stage: "WATCHING", matchedCount: 0, requiredSignals: null, drillLabel: null };
  }

  // A rescueReceiptId without a receipt row must never claim PROTECTED.
  if (run.rescueReceiptId !== null) {
    const receipt = (await db.select().from(rescueReceipts).where(eq(rescueReceipts.id, run.rescueReceiptId)).limit(1))[0] ?? null;
    if (receipt !== null && receipt.status === "PROTECTED") {
      return { stage: "PROTECTED", matchedCount: 0, requiredSignals: null, drillLabel };
    }
  }

  const decision = run.decisionId !== null
    ? (await db.select().from(threatDecisions).where(eq(threatDecisions.id, run.decisionId)).limit(1))[0] ?? null
    : null;
  const policyRow = run.policyId !== null
    ? (await db.select({ requiredSignals: protectionPolicies.requiredSignals }).from(protectionPolicies).where(eq(protectionPolicies.id, run.policyId)).limit(1))[0] ?? null
    : null;
  const requiredSignals = policyRow?.requiredSignals ?? null;
  const matched = decision?.matchedCount ?? 0;

  const execution: ExecutionRow | null = run.evacuationExecutionId !== null
    ? (await db.select().from(executions).where(eq(executions.id, run.evacuationExecutionId)).limit(1))[0] ?? null
    : null;

  if (execution !== null) {
    if (execution.status === "EXECUTED_VERIFYING_DESTINATION") {
      const check = (await db.select({ id: verificationChecks.id }).from(verificationChecks).where(eq(verificationChecks.executionId, execution.id)).limit(1))[0] ?? null;
      const stage = check !== null
        ? "VERIFYING_DESTINATION" as const
        : execution.txHash !== null
          ? "TRANSACTION_CONFIRMED" as const
          : "EXECUTING" as const;
      return { stage, matchedCount: matched, requiredSignals, drillLabel };
    }
    if (execution.status === "SIMULATION_PASSED") {
      return { stage: "SIMULATION_PASSED", matchedCount: matched, requiredSignals, drillLabel };
    }
    if (execution.status === "SUBMISSION_PENDING" || execution.status === "SUBMISSION_UNKNOWN") {
      return { stage: "KEEPERHUB_SUBMISSION", matchedCount: matched, requiredSignals, drillLabel };
    }
    if (execution.status === "EXECUTION_PENDING") {
      // With a KeeperHub execution id the submission is confirmed on their
      // side; without one the execution is still being resolved.
      return {
        stage: execution.keeperhubExecutionId !== null ? "KEEPERHUB_SUBMISSION" : "EXECUTING",
        matchedCount: matched,
        requiredSignals,
        drillLabel,
      };
    }
    if (execution.status === "PROTECTED") {
      // Execution finished but the receipt row is missing — destination
      // verification is not complete, so PROTECTED must not be claimed.
      return { stage: "VERIFYING_DESTINATION", matchedCount: matched, requiredSignals, drillLabel };
    }
    // EXECUTION_FAILED and anything else: the last reached stage is EXECUTING.
    return { stage: "EXECUTING", matchedCount: matched, requiredSignals, drillLabel };
  }

  if (decision !== null) {
    if (decision.state === "CONFIRMING" && decision.confirmedAt !== null) {
      return { stage: "CONFIRMING", matchedCount: matched, requiredSignals, drillLabel };
    }
    if (decision.state === "ELEVATED") {
      // ELEVATED with the full match set (confirmation re-read failed) is the
      // persisted "N/M matched" state; a partial match is threat evidence.
      const fullyMatched = requiredSignals !== null && matched >= requiredSignals;
      return {
        stage: fullyMatched ? "MATCHED" : "THREAT_EVIDENCE",
        matchedCount: matched,
        requiredSignals,
        drillLabel,
      };
    }
    // EXPIRED/RESOLVED/other: no live threat decision.
    return { stage: "WATCHING", matchedCount: matched, requiredSignals, drillLabel };
  }

  // No decision yet: signals already collected for this position mean the
  // observation stage produced evidence; otherwise the honest baseline.
  const signal = (await db.select({ id: signalObservations.id }).from(signalObservations).where(eq(signalObservations.positionId, positionId)).limit(1))[0] ?? null;
  return signal !== null
    ? { stage: "THREAT_EVIDENCE", matchedCount: 0, requiredSignals, drillLabel }
    : { stage: "WATCHING", matchedCount: 0, requiredSignals, drillLabel };
};

const competingExecutionExists = async (db: VindexDb, decisionId: string): Promise<boolean> => {
  const rows = await db
    .select({ id: executions.id })
    .from(executions)
    .where(and(eq(executions.decisionId, decisionId), sql`${executions.status} in ('EXECUTED_VERIFYING_DESTINATION', 'PROTECTED')`))
    .limit(1);
  return rows.length > 0;
};

const EMPTY_CURRENT_POSITION: DemoCurrentPositionView = {
  exists: false,
  positionAmountBaseUnits: "0",
  underlyingWalletBalance: "0",
  live: false,
  observedAt: null,
};

/**
 * Authoritative lifecycle status view. Read-only except the idempotent
 * self-heal (a policy armed BEFORE a PROTECTED receipt settles once; a
 * policy armed after the receipt is a live protection session and is left
 * untouched). Never throws for RPC/KeeperHub unavailability — the view
 * degrades to persisted data.
 */
export const getDemoLifecycleStatus = async (
  env: VindexEnv,
  db: VindexDb,
  options: StatusOptions = {},
): Promise<DemoLifecycleStatusView> => {
  const now = options.now ?? (() => new Date());
  const keeperHubClient: KeeperHubClient =
    options.keeperHubClient ??
    createKeeperHubClient({ apiKey: env.keeperhubApiKey, baseUrl: env.keeperhubApiBaseUrl });
  let publicClient: ReturnType<typeof createFailoverPublicClient> | null = options.publicClient ?? null;
  if (publicClient === null) {
    try {
      publicClient = createFailoverPublicClient(process.env);
    } catch {
      publicClient = null;
    }
  }

  // Resolve the execution wallet: KeeperHub first, then the persisted
  // snapshot as a degraded fallback so the demo page still renders when
  // KeeperHub is down.
  let wallet: string | null = null;
  try {
    const orgWallet = await keeperHubClient.getOrganizationWallet();
    if (orgWallet.hasWallet && orgWallet.walletAddress !== null) {
      wallet = orgWallet.walletAddress;
    }
  } catch {
    wallet = null;
  }
  if (wallet === null) {
    const snapshot = await db
      .select({ executionWallet: protectedPositions.executionWallet })
      .from(protectedPositions)
      .orderBy(desc(protectedPositions.observedAt))
      .limit(1);
    wallet = snapshot[0]?.executionWallet ?? null;
  }
  if (wallet === null) {
    // Nothing to key on — degraded empty view with a truthful reason.
    return {
      positionId: null,
      activeRun: null,
      lastProtectionEvent: null,
      currentPosition: EMPTY_CURRENT_POSITION,
      protection: { armed: false, mode: null, policyId: null, armedAt: null },
      drillProgress: { stage: "WATCHING", label: STAGE_LABELS.WATCHING, matchedCount: 0, requiredSignals: null, drillLabel: null },
      validation: {
        readyToPrepare: false,
        readyToArm: false,
        readyToRunDrill: false,
        reasons: ["KeeperHub organization wallet is unavailable."],
        inFlightJob: null,
      },
    };
  }

  const positionId = canonicalPositionId(wallet);

  const [run, protectedEvent, initialProtection, config] = await Promise.all([
    latestActiveRunRow(db, positionId),
    latestProtectionEvent(db, positionId),
    protectionView(db, positionId),
    getSafeWalletConfig(db),
  ]);

  // Self-heal: legacy armed-after-PROTECTED state (the M10 live DB) corrects
  // itself once on first read; settleCompletedProtection is idempotent. The
  // settle is scoped by policy age: only a policy armed BEFORE the receipt's
  // completion may be settled. A policy armed AFTER the receipt is a fresh
  // protection session (the operator's re-arm before run 2, or the drill's
  // own arm -> prepare window) and must survive status reads untouched.
  let protection = initialProtection;
  if (protectedEvent !== null && protection.armed && protection.armedAt !== null) {
    const receiptTime = Date.parse(protectedEvent.completedAt ?? "");
    const armedTime = Date.parse(protection.armedAt);
    if (!Number.isNaN(receiptTime) && !Number.isNaN(armedTime) && armedTime < receiptTime) {
      await settleCompletedProtection(db, positionId, now);
      protection = await protectionView(db, positionId);
    }
  }

  const [activeRun, currentPosition, drillProgress] = await Promise.all([
    run !== null ? activeRunView(db, run, positionId) : Promise.resolve(null),
    currentPositionView(db, positionId, wallet, publicClient as unknown as CanonicalReadClient | null, now),
    deriveDrillProgress(db, run, positionId, protectedEvent),
  ]);

  const safeWalletConfigured = config.safeWallet !== null;
  const inFlightKind = getInFlightDemoJob(positionId);
  const inFlightJob = demoJobTypeLabel(inFlightKind);
  const positionLive = currentPosition.live && currentPosition.exists;
  const runInProgress = runHasInProgress(run);
  // A CREATED run that never persisted a funding execution is a crash-stuck
  // row: no broadcast ever happened and the prepare route adopts/resumes the
  // same row with identical idempotency keys, so the UI may safely re-trigger
  // prepare. A CREATED run WITH a funding execution id is genuinely in flight.
  const staleCreatedRun = run !== null && run.status === "CREATED" && run.fundingExecutionId === null;

  const reasons: string[] = [];
  if (inFlightKind !== null) reasons.push(`A demo ${inFlightKind} job is already running.`);
  if (!safeWalletConfigured) reasons.push("Safe wallet is not configured.");
  if (!positionLive) reasons.push("The demo position is not live (or could not be read).");
  if (runInProgress && !staleCreatedRun) reasons.push(`A demo run is already in progress (${run?.status ?? "unknown"}).`);

  const readyToPrepare = (!runInProgress || staleCreatedRun) && inFlightKind === null;
  const readyToArm = positionLive && safeWalletConfigured && !protection.armed;

  let readyToRunDrill = false;
  if (runInProgress && run !== null) {
    const competing = run.decisionId !== null && run.evacuationExecutionId === null
      ? await competingExecutionExists(db, run.decisionId)
      : false;
    if (competing) {
      reasons.push("Another evacuation already executed for this decision.");
    } else {
      readyToRunDrill = positionLive && safeWalletConfigured && inFlightKind === null;
    }
  } else {
    reasons.push("No active demo run — prepare the demo position first.");
  }

  return {
    positionId,
    activeRun,
    lastProtectionEvent: protectedEvent,
    currentPosition,
    protection,
    drillProgress: {
      ...drillProgress,
      label: STAGE_LABELS[drillProgress.stage],
    },
    validation: {
      readyToPrepare,
      readyToArm,
      readyToRunDrill,
      reasons,
      inFlightJob,
    },
  };
};

// ---------------------------------------------------------------------------
// Route guards (shared by the POST routes so the logic is unit-testable)
// ---------------------------------------------------------------------------

const resolvePositionFromEnv = async (
  keeperHubClient: KeeperHubClient,
): Promise<{ wallet: string; positionId: string }> => {
  let orgWallet;
  try {
    orgWallet = await keeperHubClient.getOrganizationWallet();
  } catch {
    throw new VindexApiError("KEEPERHUB_UNAVAILABLE", "KeeperHub is not reachable.", 502);
  }
  if (!orgWallet.hasWallet || orgWallet.walletAddress === null) {
    throw new VindexApiError("KEEPERHUB_UNAVAILABLE", "KeeperHub organization wallet is not configured.", 502);
  }
  return { wallet: orgWallet.walletAddress, positionId: canonicalPositionId(orgWallet.walletAddress) };
};

// Error mapping shared by every route-level live read — the position preflight
// AND the safe-wallet balance read: WrongChainError -> WRONG_CHAIN (502), any
// other RPC/transport failure -> RPC_ALL_UNAVAILABLE (503). Never leaks a raw
// error or the generic LIVE_READ_FAILED mapping to the route.
const readLiveOrMapError = async <T>(read: () => Promise<T>): Promise<T> => {
  try {
    return await read();
  } catch (error) {
    if (error instanceof WrongChainError) {
      throw new VindexApiError("WRONG_CHAIN", "The connected chain is not Base Sepolia (84532).", 502);
    }
    throw new VindexApiError("RPC_ALL_UNAVAILABLE", "All Base Sepolia RPC endpoints are unavailable.", 503);
  }
};

const readLivePosition = async (
  publicClient: CanonicalReadClient,
  wallet: string,
): Promise<{ aTokenBalanceBaseUnits: bigint; underlyingBalanceBaseUnits: bigint; blockNumber: bigint }> => {
  const live = await readLiveOrMapError(() => getAaveUsdcPosition(publicClient, wallet));
  return {
    aTokenBalanceBaseUnits: live.aTokenBalanceBaseUnits,
    underlyingBalanceBaseUnits: live.underlyingBalanceBaseUnits,
    blockNumber: live.latestBlockNumber,
  };
};

type RouteOptions = {
  keeperHubClient?: KeeperHubClient;
  publicClient?: ReturnType<typeof createFailoverPublicClient>;
  now?: () => Date;
};

/**
 * POST /api/vindex/demo/prepare guard + kickoff. Cheap guards run
 * synchronously (org wallet, safe wallet, KeeperHub health, in-flight guard,
 * live-position preflight so a second position is never funded); the run row
 * is created/adopted here and the background job is fired immediately after.
 * Adoption semantics live in prepareDemoPosition: an existing active run is
 * resumed, never duplicated.
 */
export const prepareDemoRoute = async (
  env: VindexEnv,
  db: VindexDb,
  options: RouteOptions = {},
): Promise<{ runId: string; started: true }> => {
  const now = options.now ?? (() => new Date());
  const keeperHubClient =
    options.keeperHubClient ?? createKeeperHubClient({ apiKey: env.keeperhubApiKey, baseUrl: env.keeperhubApiBaseUrl });
  const publicClient =
    options.publicClient ?? (createFailoverPublicClient(process.env) as never);
  const rpc = publicClient as unknown as CanonicalReadClient;

  const { wallet, positionId } = await resolvePositionFromEnv(keeperHubClient);

  const config = await getSafeWalletConfig(db);
  if (config.safeWallet === null) {
    throw new VindexApiError("SAFE_WALLET_NOT_CONFIGURED", "Safe wallet is not configured.", 422);
  }
  const safeWallet = config.safeWallet; // narrowed to string below the null check
  const walletValidation = validateSafeWallet(safeWallet, wallet);
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
  if (getInFlightDemoJob(positionId) !== null) {
    throw new VindexApiError("IN_FLIGHT_JOB", "A demo job is already running for this position.", 409);
  }

  let run = await getActiveDemoRun(db, positionId);
  if (run === null) {
    // Preflight identical to prepareDemoPosition's own preflight: a live
    // position that does not belong to any run must never be funded twice.
    const live = await readLivePosition(rpc, wallet);
    if (live.aTokenBalanceBaseUnits > BigInt(0)) {
      throw new VindexApiError("POSITION_ZERO", `Existing aUSDC position (${live.aTokenBalanceBaseUnits}) found before a demo run — diagnose instead of creating another position.`, 409);
    }
    const safePosition = await readLiveOrMapError(() => getAaveUsdcPosition(rpc, safeWallet));
    const inserted = await db
      .insert(demoRuns)
      .values({
        status: "CREATED",
        positionId,
        startingBlockNumber: live.blockNumber.toString(),
        startingBlockTimestamp: now(),
        preDemoSafeWalletBalance: safePosition.underlyingBalanceBaseUnits.toString(),
      })
      .onConflictDoNothing()
      .returning();
    run = inserted[0] ?? (await getActiveDemoRun(db, positionId));
    if (run === null) {
      throw new VindexApiError("BAD_REQUEST", "Could not create or adopt a demo run.", 409);
    }
  }

  startDemoPrepare(env, db, run.id, { keeperHubClient, publicClient, now });
  return { runId: run.id, started: true };
};

/**
 * POST /api/vindex/demo/drill guard + kickoff. Guards mirror runDemoDrill's
 * own guards so a doomed call fails fast with a truthful 4xx instead of
 * wasting a background job: active run, no in-flight job, safe wallet,
 * position live (or resume), no competing execution.
 */
export const runDemoDrillRoute = async (
  env: VindexEnv,
  db: VindexDb,
  options: RouteOptions = {},
): Promise<{ runId: string; started: true }> => {
  const now = options.now ?? (() => new Date());
  const keeperHubClient =
    options.keeperHubClient ?? createKeeperHubClient({ apiKey: env.keeperhubApiKey, baseUrl: env.keeperhubApiBaseUrl });
  const publicClient =
    options.publicClient ?? (createFailoverPublicClient(process.env) as never);
  const rpc = publicClient as unknown as CanonicalReadClient;

  const { wallet, positionId } = await resolvePositionFromEnv(keeperHubClient);

  // The query keys on the position, so the run trivially belongs to it.
  const run = await getActiveDemoRun(db, positionId);
  if (run === null) {
    throw new VindexApiError("NO_ACTIVE_RUN", "No active demo run for this position.", 409);
  }
  if (getInFlightDemoJob(positionId) !== null) {
    throw new VindexApiError("IN_FLIGHT_JOB", "A demo job is already running for this position.", 409);
  }
  const config = await getSafeWalletConfig(db);
  if (config.safeWallet === null) {
    throw new VindexApiError("SAFE_WALLET_NOT_CONFIGURED", "Safe wallet is not configured.", 422);
  }

  const live = await readLivePosition(rpc, wallet);
  if (live.aTokenBalanceBaseUnits <= BigInt(0) && run.evacuationExecutionId === null) {
    throw new VindexApiError("POSITION_ZERO", "The demo position is not live — nothing to protect.", 422);
  }

  if (run.decisionId !== null && run.evacuationExecutionId === null) {
    if (await competingExecutionExists(db, run.decisionId)) {
      throw new VindexApiError("BAD_REQUEST", "Another evacuation already executed for this decision — no second evacuation.", 409);
    }
  }

  startDemoDrill(env, db, run.id, { keeperHubClient, publicClient, now });
  return { runId: run.id, started: true };
};
