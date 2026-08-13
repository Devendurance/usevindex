// M5 policy + consensus engine. Backend-authoritative state:
// DRAFT -> ARMED -> WATCHING -> ELEVATED -> CONFIRMING.
// Only LIVE observations within the correlation window on Base Sepolia count.
// No simulation, no KeeperHub calls, no onchain writes.
import "server-only";

import { and, desc, eq, sql } from "drizzle-orm";

import type { VindexDb } from "../../db";
import {
  auditEvents,
  protectionPolicies,
  threatDecisions,
  type ThreatDecisionRow,
} from "../../db/schema";
import { VINDEX_CHAIN_ID } from "./chain";
import type { VindexEnv } from "./env";
import { VindexApiError } from "./errors";
import {
  SIGNAL_FRESHNESS_MAX_AGE_MS,
  collectLiveSignalObservations,
  getLatestSignalObservations,
  getSignalHistory,
  type SignalCollectionResult,
  type SignalObservation,
  type SignalSourceFamily,
} from "./signal-service";
import {
  DRILL_LABEL,
  POLICY_TEMPLATES,
  type PolicyMode,
  type PolicyTemplate,
} from "./policy-templates";
import { canonicalPositionId, refreshCurrentProtectedPosition } from "./position-service";
import { getSafeWalletConfig } from "./safe-wallet";
import type { KeeperHubClient } from "./keeperhub";
import type { CanonicalReadClient } from "./public-client";

export type ProtectionState = "DRAFT" | "WATCHING" | "ELEVATED" | "CONFIRMING";

export type MatchedFamilyView = {
  family: SignalSourceFamily;
  matched: boolean;
  reason: string;
  observationIds: string[];
  values: Record<string, string>;
};

export type PolicyView = {
  id: string;
  positionId: string;
  mode: PolicyMode;
  version: number;
  requiredSignals: number;
  correlationWindowSec: number;
  thresholds: Record<string, unknown>;
  safeWalletSnapshot: string;
  isArmed: boolean;
  armedAt: string | null;
  disarmedAt: string | null;
};

export type ConfirmationReReadView = {
  blockNumber: string;
  blockTimestamp: string | null;
  outcome: "passed" | "failed";
  reason: string | null;
  matchedFamilies: string[];
};

export type EvaluationView = {
  positionId: string;
  state: ProtectionState;
  policy: PolicyView | null;
  matchedFamilies: MatchedFamilyView[];
  matchedCount: number;
  decisionId: string | null;
  windowStartedAt: string | null;
  confirmedAt: string | null;
  expiresAt: string | null;
  readyForSimulation: boolean;
  lastEvaluatedAt: string;
  drill: boolean;
  drillLabel: string | null;
  drillExplanation: string | null;
  reRead: ConfirmationReReadView | null;
};

export type EvaluateOptions = {
  env: VindexEnv;
  db: VindexDb;
  positionId: string;
  collect?: typeof collectLiveSignalObservations;
  now?: () => Date;
  publicClient?: CanonicalReadClient;
  keeperHubClient?: KeeperHubClient;
};

export type ArmOptions = {
  env: VindexEnv;
  db: VindexDb;
  positionId: string;
  mode: PolicyMode;
  now?: () => Date;
  publicClient?: CanonicalReadClient;
  keeperHubClient?: KeeperHubClient;
};

const rowToPolicyView = (row: typeof protectionPolicies.$inferSelect): PolicyView => ({
  id: row.id,
  positionId: row.positionId,
  mode: row.mode as PolicyMode,
  version: row.version,
  requiredSignals: row.requiredSignals,
  correlationWindowSec: row.correlationWindowSec,
  thresholds: parseJsonObject(row.thresholdsJson),
  safeWalletSnapshot: row.safeWalletSnapshot,
  isArmed: row.isArmed,
  armedAt: row.armedAt?.toISOString() ?? null,
  disarmedAt: row.disarmedAt?.toISOString() ?? null,
});

const parseJsonObject = (json: string): Record<string, unknown> => {
  try {
    const parsed: unknown = JSON.parse(json);
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // fall through
  }
  return {};
};

const parseJsonArray = (json: string): string[] => {
  try {
    const parsed: unknown = JSON.parse(json);
    if (Array.isArray(parsed)) return parsed.map(String);
  } catch {
    // fall through
  }
  return [];
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
    decisionId,
    eventType,
    detailsJson: JSON.stringify(details),
    blockNumber,
  });
};

const decisionDetails = (decision: ThreatDecisionRow) => ({
  id: decision.id,
  state: decision.state,
  matchedCount: decision.matchedCount,
  windowStartedAt: decision.windowStartedAt.toISOString(),
  confirmedAt: decision.confirmedAt?.toISOString() ?? null,
  expiresAt: decision.expiresAt?.toISOString() ?? null,
});

export const getArmedPolicy = async (
  db: VindexDb,
  positionId: string,
): Promise<typeof protectionPolicies.$inferSelect | null> => {
  const rows = await db
    .select()
    .from(protectionPolicies)
    .where(
      and(
        eq(protectionPolicies.positionId, positionId),
        eq(protectionPolicies.isArmed, true),
      ),
    )
    .limit(1);
  return rows[0] ?? null;
};

export const isPolicyArmed = async (db: VindexDb, positionId: string): Promise<boolean> =>
  (await getArmedPolicy(db, positionId)) !== null;

export const armPolicy = async (options: ArmOptions): Promise<PolicyView> => {
  const { env, db, positionId, mode } = options;
  const now = options.now ?? (() => new Date());

  if (await isPolicyArmed(db, positionId)) {
    const existing = await getArmedPolicy(db, positionId);
    if (existing !== null) return rowToPolicyView(existing);
  }

  const readinessModel = await refreshCurrentProtectedPosition({
    env,
    db,
    publicClient: options.publicClient,
    keeperHubClient: options.keeperHubClient,
    now,
  });
  const readiness = readinessModel.readiness;
  if (!readiness.readyForMonitoring) {
    const failing = [
      !readiness.networkValid && "network",
      !readiness.contractsValid && "contracts",
      !readiness.executionWalletValid && "execution wallet",
      !readiness.positionExists && "position",
      (!readiness.safeWalletConfigured || !readiness.safeWalletValid) && "safe wallet",
      !readiness.keeperHubHealthy && "KeeperHub",
    ].filter(Boolean);
    throw new VindexApiError(
      "LIVE_READ_FAILED",
      `Cannot arm: M3 readiness incomplete (${failing.join(", ")}).`,
      422,
    );
  }

  // Enough LIVE M4 families (>= 2 of 3).
  const latestSignals = await getLatestSignalObservations(db, positionId, now);
  const liveFamilies = new Set(
    latestSignals.latest.filter((o) => o.sourceFamily !== undefined).map((o) => o.sourceFamily),
  );
  if (liveFamilies.size < 2) {
    throw new VindexApiError(
      "LIVE_READ_FAILED",
      `Cannot arm: only ${liveFamilies.size} of 3 signal families are live; at least 2 required.`,
      422,
    );
  }

  const config = await getSafeWalletConfig(db);
  if (config.safeWallet === null) {
    throw new VindexApiError("SAFE_WALLET_NOT_CONFIGURED", "Safe wallet is not configured.", 422);
  }

  const template: PolicyTemplate = POLICY_TEMPLATES[mode];
  const versionRows = await db
    .select({ version: protectionPolicies.version })
    .from(protectionPolicies)
    .where(eq(protectionPolicies.positionId, positionId));
  const version = versionRows.length === 0 ? 1 : Math.max(...versionRows.map((r) => r.version)) + 1;

  const armedAt = now();
  const inserted = await db
    .insert(protectionPolicies)
    .values({
      positionId,
      mode,
      requiredSignals: template.requiredSignals,
      correlationWindowSec: template.correlationWindowSec,
      thresholdsJson: JSON.stringify({
        ...template.thresholds,
        rules: template.rules,
      }),
      safeWalletSnapshot: config.safeWallet,
      isArmed: true,
      armedAt,
      version,
    })
    .onConflictDoNothing()
    .returning();

  const row = inserted[0];
  if (row === undefined) {
    // Concurrent arm — return the existing armed policy.
    const existing = await getArmedPolicy(db, positionId);
    if (existing !== null) return rowToPolicyView(existing);
    throw new VindexApiError("LIVE_READ_FAILED", "Could not arm the policy.", 422);
  }

  await writeAudit(db, positionId, "POLICY_ARMED", {
    policyId: row.id,
    mode,
    version,
    requiredSignals: template.requiredSignals,
    safeWalletSnapshot: config.safeWallet,
  });

  return rowToPolicyView(row);
};

export const disarmPolicy = async (
  db: VindexDb,
  positionId: string,
  now: () => Date = () => new Date(),
): Promise<{ alreadyDisarmed: boolean; policy: PolicyView | null }> => {
  void now;
  const armed = await getArmedPolicy(db, positionId);
  if (armed === null) {
    return { alreadyDisarmed: true, policy: null };
  }
  const disarmedAt = now();
  const updated = await db
    .update(protectionPolicies)
    .set({ isArmed: false, disarmedAt, updatedAt: disarmedAt })
    .where(
      and(
        eq(protectionPolicies.id, armed.id),
        eq(protectionPolicies.isArmed, true),
      ),
    )
    .returning({ id: protectionPolicies.id });
  if (updated.length === 0) {
    // A concurrent disarm won the race; the policy is already settled.
    return { alreadyDisarmed: true, policy: null };
  }

  // Close any active decision window so a later arm starts clean.
  await db
    .update(threatDecisions)
    .set({ state: "RESOLVED", updatedAt: disarmedAt })
    .where(
      and(
        eq(threatDecisions.policyId, armed.id),
        sql`${threatDecisions.state} in ('ELEVATED', 'CONFIRMING')`,
      ),
    );

  await writeAudit(db, positionId, "POLICY_DISARMED", { policyId: armed.id, mode: armed.mode });
  return { alreadyDisarmed: false, policy: rowToPolicyView({ ...armed, isArmed: false, disarmedAt }) };
};

// Post-PROTECTED lifecycle settlement: once a protection event is completed
// (execution status PROTECTED + rescue receipt), the armed policy is disarmed
// so a future protection session never inherits an armed policy. Idempotent
// and additive-only: no historical row is ever deleted or updated; the only
// writes are the disarm transition plus appended audit events.
export const settleCompletedProtection = async (
  db: VindexDb,
  positionId: string,
  now: () => Date = () => new Date(),
): Promise<{ alreadyDisarmed: boolean; policy: PolicyView | null }> => {
  const armed = await getArmedPolicy(db, positionId);
  if (armed === null) {
    return { alreadyDisarmed: true, policy: null };
  }
  const activeDecisions = await db
    .select()
    .from(threatDecisions)
    .where(
      and(
        eq(threatDecisions.policyId, armed.id),
        sql`${threatDecisions.state} in ('ELEVATED', 'CONFIRMING')`,
      ),
    );
  const result = await disarmPolicy(db, positionId, now);
  if (!result.alreadyDisarmed) {
    // Only the call that actually performed the disarm appends the
    // resolution audit; a concurrent settle that lost the race is a no-op.
    for (const decision of activeDecisions) {
      await writeAudit(
        db,
        positionId,
        "DECISION_RESOLVED",
        { decisionId: decision.id, ...decisionDetails(decision) },
        decision.id,
      );
    }
  }
  return result;
};

type EligibleObservation = {
  id: string | undefined;
  metric: string;
  rawValue: string;
  observedAt: string;
  metadata: Record<string, unknown>;
};

const dropPercent = (oldestRaw: string, newestRaw: string): bigint => {
  const oldest = BigInt(oldestRaw);
  const newest = BigInt(newestRaw);
  if (oldest <= BigInt(0)) return BigInt(0);
  return ((oldest - newest) * BigInt(100)) / oldest;
};

const metricObservations = async (
  db: VindexDb,
  positionId: string,
  metric: string,
  windowStartMs: number,
): Promise<EligibleObservation[]> => {
  const history = await getSignalHistory(db, positionId, { metric: metric as never, limit: 100 });
  return history
    .filter((o) => Date.parse(o.observedAt) >= windowStartMs)
    .map((o) => ({
      id: o.id,
      metric: o.metric,
      rawValue: o.rawValue,
      observedAt: o.observedAt,
      metadata: o.metadata,
    }));
};

const latestObservationFor = (
  observations: SignalObservation[],
  metric: string,
): SignalObservation | null =>
  observations.find((o) => o.metric === metric) ?? null;

export const evaluateProtectionPolicy = async (
  options: EvaluateOptions,
): Promise<EvaluationView> => {
  const { db, positionId } = options;
  const now = options.now ?? (() => new Date());
  const nowMs = now().getTime();
  const lastEvaluatedAt = now().toISOString();

  const policyRow = await getArmedPolicy(db, positionId);
  if (policyRow === null) {
    return {
      positionId,
      state: "DRAFT",
      policy: null,
      matchedFamilies: [],
      matchedCount: 0,
      decisionId: null,
      windowStartedAt: null,
      confirmedAt: null,
      expiresAt: null,
      readyForSimulation: false,
      lastEvaluatedAt,
      drill: false,
      drillLabel: null,
      drillExplanation: null,
      reRead: null,
    };
  }
  const policy = rowToPolicyView(policyRow);
  const template = POLICY_TEMPLATES[policy.mode];
  const windowStartMs = nowMs - policy.correlationWindowSec * 1000;
  const drill = policy.mode === "DRILL_HIGH_SENSITIVITY";

  // Eligible observations: LIVE (fresh) and inside the correlation window.
  const latest = await getLatestSignalObservations(db, positionId, now);
  const eligible = latest.latest.filter(
    (o) =>
      o.chainId === VINDEX_CHAIN_ID &&
      Date.parse(o.observedAt) >= windowStartMs &&
      nowMs - Date.parse(o.observedAt) <= SIGNAL_FRESHNESS_MAX_AGE_MS,
  );
  const metricToObservation = new Map(eligible.map((o) => [o.metric, o]));

  // History (within the window) for drop rules.
  const totalATokenHistory = await metricObservations(
    db, positionId, "AAVE_RESERVE_TOTAL_ATOKEN", windowStartMs,
  );
  const positionHistory = await metricObservations(
    db, positionId, "POSITION_AUSDC_BALANCE", windowStartMs,
  );

  const thresholds = policy.thresholds;

  const matchedFamilies: MatchedFamilyView[] = [];

  // --- ORACLE_PRICE_STATE ------------------------------------------------
  {
    const oracle = latestObservationFor(eligible, "AAVE_USDC_ORACLE_PRICE");
    let matched = false;
    let reason = "No eligible LIVE oracle observation in the correlation window.";
    let observationIds: string[] = [];
    const values: Record<string, string> = {};
    if (oracle !== null) {
      const price = BigInt(oracle.rawValue);
      values.raw = oracle.rawValue;
      values.block = oracle.blockNumber;
      if (oracle.id !== undefined) observationIds = [oracle.id];
      if (policy.mode === "STANDARD") {
        const min = BigInt(Number(thresholds.oracleMinUsd8 ?? 97_000_000));
        const max = BigInt(Number(thresholds.oracleMaxUsd8 ?? 103_000_000));
        matched = price < min || price > max;
        reason = matched
          ? `Aave USDC oracle price ${oracle.rawValue} (8 decimals) is outside 0.97–1.03 USD.`
          : `Aave USDC oracle price ${oracle.rawValue} (8 decimals) is inside 0.97–1.03 USD.`;
      } else {
        const max = BigInt(Number(thresholds.oracleMaxUsd8 ?? 101_000_000));
        matched = price <= max;
        reason = matched
          ? `DRILL condition: Aave USDC oracle price ${oracle.rawValue} (8 decimals) <= 1.01 USD.`
          : `DRILL condition not met: oracle price ${oracle.rawValue} > 1.01 USD.`;
      }
    }
    matchedFamilies.push({
      family: "ORACLE_PRICE_STATE",
      matched,
      reason,
      observationIds,
      values,
    });
  }

  // --- AAVE_RESERVE_STATE ---------------------------------------------------
  {
    let matched = false;
    let reason = "No eligible LIVE reserve observations in the correlation window.";
    let observationIds: string[] = [];
    const values: Record<string, string> = {};
    if (policy.mode === "STANDARD") {
      const frozen = metricToObservation
        .get("AAVE_RESERVE_TOTAL_ATOKEN")
        ?.metadata.booleans;
      const isFrozen =
        typeof frozen === "object" && frozen !== null
          ? (frozen as { isFrozen?: boolean }).isFrozen === true
          : false;
      values.isFrozen = String(isFrozen);
      if (isFrozen) {
        matched = true;
        reason = "Aave reserve is frozen (isFrozen == true).";
      } else if (totalATokenHistory.length >= 2) {
        const newest = totalATokenHistory[0];
        const oldest = totalATokenHistory[totalATokenHistory.length - 1];
        const drop = dropPercent(oldest.rawValue, newest.rawValue);
        values.dropPct = drop.toString();
        values.oldest = oldest.rawValue;
        values.newest = newest.rawValue;
        if (newest.id !== undefined) observationIds = [newest.id];
        const threshold = BigInt(Number(thresholds.reserveSupplyDropPct ?? 15));
        matched = drop >= threshold;
        reason = matched
          ? `Aave reserve supplied state (aToken totalSupply) dropped ${drop.toString()}% within the window (>= ${threshold.toString()}%).`
          : `Aave reserve supplied state is stable (drop ${drop.toString()}% < ${threshold.toString()}%).`;
      } else {
        reason =
          "STANDARD reserve rule: not frozen and fewer than 2 eligible total-supply observations in the window — cannot prove a 15% drop.";
      }
    } else {
      const debt = latestObservationFor(eligible, "AAVE_RESERVE_TOTAL_VARIABLE_DEBT");
      if (debt !== null) {
        values.raw = debt.rawValue;
        values.block = debt.blockNumber;
        if (debt.id !== undefined) observationIds = [debt.id];
        const min = BigInt(Number(thresholds.reserveVariableDebtMin ?? 0));
        matched = BigInt(debt.rawValue) > min;
        reason = matched
          ? `DRILL condition: Aave USDC reserve variable debt ${debt.rawValue} > 0.`
          : `DRILL condition not met: variable debt ${debt.rawValue} <= 0.`;
      }
    }
    matchedFamilies.push({
      family: "AAVE_RESERVE_STATE",
      matched,
      reason,
      observationIds,
      values,
    });
  }

  // --- POSITION_STATE ---------------------------------------------------------
  {
    let matched = false;
    let reason = "No eligible LIVE position observations in the correlation window.";
    let observationIds: string[] = [];
    const values: Record<string, string> = {};
    if (policy.mode === "STANDARD") {
      if (positionHistory.length >= 2) {
        const newest = positionHistory[0];
        const oldest = positionHistory[positionHistory.length - 1];
        const drop = dropPercent(oldest.rawValue, newest.rawValue);
        values.dropPct = drop.toString();
        values.oldest = oldest.rawValue;
        values.newest = newest.rawValue;
        if (newest.id !== undefined) observationIds = [newest.id];
        const threshold = BigInt(Number(thresholds.positionDropPct ?? 10));
        matched = drop >= threshold;
        reason = matched
          ? `Protected aUSDC balance dropped ${drop.toString()}% within the window (>= ${threshold.toString()}%).`
          : `Protected aUSDC balance is stable (drop ${drop.toString()}% < ${threshold.toString()}%).`;
      } else {
        reason =
          "STANDARD position rule: fewer than 2 eligible position observations in the window — cannot prove a 10% drop.";
      }
    } else {
      const balance = latestObservationFor(eligible, "POSITION_AUSDC_BALANCE");
      if (balance !== null) {
        values.raw = balance.rawValue;
        values.block = balance.blockNumber;
        if (balance.id !== undefined) observationIds = [balance.id];
        const min = BigInt(Number(thresholds.positionBalanceMin ?? 0));
        matched = BigInt(balance.rawValue) > min;
        reason = matched
          ? `DRILL condition: protected aUSDC balance ${balance.rawValue} > 0.`
          : `DRILL condition not met: aUSDC balance ${balance.rawValue} <= 0.`;
      }
    }
    matchedFamilies.push({
      family: "POSITION_STATE",
      matched,
      reason,
      observationIds,
      values,
    });
  }

  const matchedFamiliesView = matchedFamilies.filter((m) => m.matched);
  const matchedCount = matchedFamiliesView.length;
  const contributingSignalIds = [
    ...new Set(matchedFamiliesView.flatMap((m) => m.observationIds)),
  ];

  const decisionRows = await db
    .select()
    .from(threatDecisions)
    .where(eq(threatDecisions.policyId, policyRow.id))
    .orderBy(desc(threatDecisions.createdAt))
    .limit(1);
  const latestDecision = decisionRows[0] ?? null;

  // Idempotent: an already-confirmed, unexpired CONFIRMING decision returns as-is.
  if (
    latestDecision !== null &&
    latestDecision.state === "CONFIRMING" &&
    latestDecision.confirmedAt !== null &&
    latestDecision.expiresAt !== null &&
    latestDecision.expiresAt.getTime() > nowMs
  ) {
    return {
      positionId,
      state: "CONFIRMING",
      policy,
      matchedFamilies,
      matchedCount,
      decisionId: latestDecision.id,
      windowStartedAt: latestDecision.windowStartedAt.toISOString(),
      confirmedAt: latestDecision.confirmedAt.toISOString(),
      expiresAt: latestDecision.expiresAt.toISOString(),
      readyForSimulation: true,
      lastEvaluatedAt,
      drill,
      drillLabel: drill ? DRILL_LABEL : null,
      drillExplanation: drill
        ? "Real measurements with intentionally sensitive thresholds. This is a protection drill, not evidence of an Aave exploit."
        : null,
      reRead: null,
    };
  }

  // Expire stale confirmed decisions so a new window can open.
  if (
    latestDecision !== null &&
    latestDecision.state === "CONFIRMING" &&
    latestDecision.confirmedAt !== null &&
    latestDecision.expiresAt !== null &&
    latestDecision.expiresAt.getTime() <= nowMs
  ) {
    await db
      .update(threatDecisions)
      .set({ state: "EXPIRED", updatedAt: now() })
      .where(eq(threatDecisions.id, latestDecision.id));
    await writeAudit(db, positionId, "DECISION_EXPIRED", {
      decisionId: latestDecision.id,
      ...decisionDetails(latestDecision),
    });
  }

  const transitionToConfirming = async (
    decision: ThreatDecisionRow,
  ): Promise<EvaluationView> => {
    const reRead = await confirmationReRead(options, policy, template, now);
    if (reRead.outcome === "passed") {
      const confirmedAt = now();
      const expiresAt = new Date(confirmedAt.getTime() + 3600 * 1000);
      await db
        .update(threatDecisions)
        .set({ state: "CONFIRMING", confirmedAt, expiresAt, updatedAt: confirmedAt })
        .where(eq(threatDecisions.id, decision.id));
      await writeAudit(
        db,
        positionId,
        "CONFIRMATION_PASSED",
        {
          decisionId: decision.id,
          blockNumber: reRead.blockNumber,
          matchedFamilies: reRead.matchedFamilies,
        },
        decision.id,
        reRead.blockNumber,
      );
      return {
        positionId,
        state: "CONFIRMING",
        policy,
        matchedFamilies,
        matchedCount,
        decisionId: decision.id,
        windowStartedAt: decision.windowStartedAt.toISOString(),
        confirmedAt: confirmedAt.toISOString(),
        expiresAt: expiresAt.toISOString(),
        readyForSimulation: true,
        lastEvaluatedAt,
        drill,
        drillLabel: drill ? DRILL_LABEL : null,
        drillExplanation: drill
          ? "Real measurements with intentionally sensitive thresholds. This is a protection drill, not evidence of an Aave exploit."
          : null,
        reRead,
      };
    }
    // Re-read failed: fall back to ELEVATED with the explicit reason.
    await db
      .update(threatDecisions)
      .set({ state: "ELEVATED", updatedAt: now() })
      .where(eq(threatDecisions.id, decision.id));
    await writeAudit(
      db,
      positionId,
      "CONFIRMATION_FAILED",
      {
        decisionId: decision.id,
        reason: reRead.reason,
        blockNumber: reRead.blockNumber,
      },
      decision.id,
      reRead.blockNumber,
    );
    return {
      positionId,
      state: "ELEVATED",
      policy,
      matchedFamilies,
      matchedCount,
      decisionId: decision.id,
      windowStartedAt: decision.windowStartedAt.toISOString(),
      confirmedAt: null,
      expiresAt: null,
      readyForSimulation: false,
      lastEvaluatedAt,
      drill,
      drillLabel: drill ? DRILL_LABEL : null,
      drillExplanation: drill
        ? "Real measurements with intentionally sensitive thresholds. This is a protection drill, not evidence of an Aave exploit."
        : null,
      reRead,
    };
  };

  const baseView = (
    state: ProtectionState,
    decision: ThreatDecisionRow | null,
    readyForSimulation: boolean,
  ): EvaluationView => ({
    positionId,
    state,
    policy,
    matchedFamilies,
    matchedCount,
    decisionId: decision?.id ?? null,
    windowStartedAt: decision?.windowStartedAt.toISOString() ?? null,
    confirmedAt: decision?.confirmedAt?.toISOString() ?? null,
    expiresAt: decision?.expiresAt?.toISOString() ?? null,
    readyForSimulation,
    lastEvaluatedAt,
    drill,
    drillLabel: drill ? DRILL_LABEL : null,
    drillExplanation: drill
      ? "Real measurements with intentionally sensitive thresholds. This is a protection drill, not evidence of an Aave exploit."
      : null,
    reRead: null,
  });

  if (matchedCount >= policy.requiredSignals) {
    if (latestDecision !== null && latestDecision.state === "CONFIRMING") {
      // Re-evaluation while confirming: no new rows.
      return baseView("CONFIRMING", latestDecision, latestDecision.confirmedAt !== null);
    }
    if (latestDecision !== null && latestDecision.state === "ELEVATED") {
      // Real transition ELEVATED -> CONFIRMING.
      await writeAudit(
        db,
        positionId,
        "CONSENSUS_REACHED",
        {
          decisionId: latestDecision.id,
          matchedCount,
          matchedFamilies: matchedFamiliesView.map((m) => m.family),
          contributingSignalIds,
        },
        latestDecision.id,
      );
      await writeAudit(
        db,
        positionId,
        "CONFIRMATION_STARTED",
        { decisionId: latestDecision.id, blockNumber: null },
        latestDecision.id,
      );
      return transitionToConfirming(latestDecision);
    }
    // New window: create the decision directly in CONFIRMING.
    const windowStartedAt = now();
    const inserted = await db
      .insert(threatDecisions)
      .values({
        positionId,
        policyId: policyRow.id,
        policyVersion: policy.version,
        state: "CONFIRMING",
        matchedCount,
        contributingSignalIds: JSON.stringify(contributingSignalIds),
        matchedFamiliesJson: JSON.stringify(matchedFamiliesView.map((m) => m.family)),
        reasonJson: JSON.stringify(
          Object.fromEntries(matchedFamiliesView.map((m) => [m.family, m.reason])),
        ),
        windowStartedAt,
      })
      .onConflictDoNothing()
      .returning();
    const decision = inserted[0];
    if (decision === undefined) {
      // Concurrent window — return the existing one.
      const existing = await db
        .select()
        .from(threatDecisions)
        .where(eq(threatDecisions.policyId, policyRow.id))
        .orderBy(desc(threatDecisions.createdAt))
        .limit(1);
      const row = existing[0];
      if (row !== undefined) return baseView("CONFIRMING", row, row.confirmedAt !== null);
      return baseView("WATCHING", null, false);
    }
    await writeAudit(
      db,
      positionId,
      "CONSENSUS_REACHED",
      {
        decisionId: decision.id,
        matchedCount,
        matchedFamilies: matchedFamiliesView.map((m) => m.family),
        contributingSignalIds,
      },
      decision.id,
    );
    await writeAudit(
      db,
      positionId,
      "CONFIRMATION_STARTED",
      { decisionId: decision.id },
      decision.id,
    );
    return transitionToConfirming(decision);
  }

  if (matchedCount === 1) {
    if (latestDecision !== null && latestDecision.state === "ELEVATED") {
      return baseView("ELEVATED", latestDecision, false);
    }
    // Real transition WATCHING -> ELEVATED (or ELEVATED cleared -> ELEVATED).
    const windowStartedAt = now();
    const inserted = await db
      .insert(threatDecisions)
      .values({
        positionId,
        policyId: policyRow.id,
        policyVersion: policy.version,
        state: "ELEVATED",
        matchedCount,
        contributingSignalIds: JSON.stringify(contributingSignalIds),
        matchedFamiliesJson: JSON.stringify(matchedFamiliesView.map((m) => m.family)),
        reasonJson: JSON.stringify(
          Object.fromEntries(matchedFamiliesView.map((m) => [m.family, m.reason])),
        ),
        windowStartedAt,
      })
      .onConflictDoNothing()
      .returning();
    const decision = inserted[0];
    if (decision !== undefined) {
      await writeAudit(
        db,
        positionId,
        "STATE_ELEVATED",
        {
          decisionId: decision.id,
          matchedCount,
          matchedFamilies: matchedFamiliesView.map((m) => m.family),
        },
        decision.id,
      );
      return baseView("ELEVATED", decision, false);
    }
    const existing = await db
      .select()
      .from(threatDecisions)
      .where(eq(threatDecisions.policyId, policyRow.id))
      .orderBy(desc(threatDecisions.createdAt))
      .limit(1);
    const row = existing[0];
    if (row !== undefined) return baseView("ELEVATED", row, false);
    return baseView("WATCHING", null, false);
  }

  // matchedCount === 0 -> WATCHING. Clear a lingering ELEVATED window.
  if (latestDecision !== null && latestDecision.state === "ELEVATED") {
    await db
      .update(threatDecisions)
      .set({ state: "RESOLVED", updatedAt: now() })
      .where(eq(threatDecisions.id, latestDecision.id));
    await writeAudit(db, positionId, "DECISION_RESOLVED", {
      decisionId: latestDecision.id,
      ...decisionDetails(latestDecision),
    });
  }
  return baseView("WATCHING", null, false);
};

const confirmationReRead = async (
  options: EvaluateOptions,
  policy: PolicyView,
  template: PolicyTemplate,
  now: () => Date,
): Promise<ConfirmationReReadView> => {
  const collect = options.collect ?? collectLiveSignalObservations;
  const initialLatest = await getLatestSignalObservations(options.db, options.positionId, now);
  const initialBlock = initialLatest.observedAt
    ? (initialLatest.latest[0]?.blockNumber ?? "")
    : "";

  let batch: SignalCollectionResult;
  try {
    batch = await collect({
      env: options.env,
      db: options.db,
      publicClient: options.publicClient,
      keeperHubClient: options.keeperHubClient,
      now,
    });
  } catch (error) {
    return {
      blockNumber: "",
      blockTimestamp: null,
      outcome: "failed",
      reason: `Confirmation re-read collection failed: ${error instanceof Error ? error.message : "unknown"}`,
      matchedFamilies: [],
    };
  }

  if (batch.outcome === "FAILED") {
    return {
      blockNumber: batch.blockNumber,
      blockTimestamp: batch.blockTimestamp,
      outcome: "failed",
      reason: `Confirmation re-read collection failed: ${batch.diagnostics.join("; ")}`,
      matchedFamilies: [],
    };
  }
  if (batch.blockNumber === initialBlock || BigInt(batch.blockNumber) <= BigInt(initialBlock)) {
    return {
      blockNumber: batch.blockNumber,
      blockTimestamp: batch.blockTimestamp,
      outcome: "failed",
      reason: "Confirmation re-read did not observe a newer block.",
      matchedFamilies: [],
    };
  }

  // Re-evaluate distinct families against the fresh batch.
  const freshFamilies = new Set(
    batch.observations
      .filter((o) => o.sourceFamily !== undefined)
      .map((o) => o.sourceFamily),
  );
  const matchedFamilies = freshFamilies.size;

  // Re-check the non-zero position on the fresh batch.
  const positionObservation = batch.observations.find(
    (o) => o.metric === "POSITION_AUSDC_BALANCE",
  );
  const positionNonZero =
    positionObservation !== undefined && BigInt(positionObservation.rawValue) > BigInt(0);

  // Verify the safe wallet still equals the armed snapshot.
  let safeWalletMatches = false;
  let safeWalletReason = "";
  try {
    const config = await getSafeWalletConfig(options.db);
    safeWalletMatches = config.safeWallet !== null && config.safeWallet === policy.safeWalletSnapshot;
    if (!safeWalletMatches) {
      safeWalletReason = "The configured safe wallet no longer matches the armed policy snapshot.";
    }
  } catch (error) {
    safeWalletReason =
      error instanceof Error ? error.message : "Safe-wallet re-read failed.";
  }

  if (matchedFamilies < policy.requiredSignals) {
    return {
      blockNumber: batch.blockNumber,
      blockTimestamp: batch.blockTimestamp,
      outcome: "failed",
      reason: `Confirmation re-read matched ${matchedFamilies} distinct families (need ${policy.requiredSignals}).`,
      matchedFamilies: [...freshFamilies],
    };
  }
  if (!positionNonZero) {
    return {
      blockNumber: batch.blockNumber,
      blockTimestamp: batch.blockTimestamp,
      outcome: "failed",
      reason: "Confirmation re-read found the protected position is zero.",
      matchedFamilies: [...freshFamilies],
    };
  }
  if (!safeWalletMatches) {
    return {
      blockNumber: batch.blockNumber,
      blockTimestamp: batch.blockTimestamp,
      outcome: "failed",
      reason: safeWalletReason || "Safe-wallet re-read failed.",
      matchedFamilies: [...freshFamilies],
    };
  }

  return {
    blockNumber: batch.blockNumber,
    blockTimestamp: batch.blockTimestamp,
    outcome: "passed",
    reason: null,
    matchedFamilies: [...freshFamilies],
  };
};

export const getCurrentDecisionView = async (
  db: VindexDb,
  positionId: string,
  now: () => Date = () => new Date(),
): Promise<EvaluationView> => {
  const policyRow = await getArmedPolicy(db, positionId);
  if (policyRow === null) {
    return {
      positionId,
      state: "DRAFT",
      policy: null,
      matchedFamilies: [],
      matchedCount: 0,
      decisionId: null,
      windowStartedAt: null,
      confirmedAt: null,
      expiresAt: null,
      readyForSimulation: false,
      lastEvaluatedAt: now().toISOString(),
      drill: false,
      drillLabel: null,
      drillExplanation: null,
      reRead: null,
    };
  }
  const policy = rowToPolicyView(policyRow);
  const drill = policy.mode === "DRILL_HIGH_SENSITIVITY";
  const decision = await db
    .select()
    .from(threatDecisions)
    .where(eq(threatDecisions.policyId, policyRow.id))
    .orderBy(desc(threatDecisions.createdAt))
    .limit(1);

  const row = decision[0] ?? null;
  let state: ProtectionState = "WATCHING";
  if (row !== null) {
    if (row.state === "ELEVATED" || row.state === "CONFIRMING") {
      state = row.state as ProtectionState;
    }
  }

  const matchedFamilies = parseJsonArray(row?.matchedFamiliesJson ?? "[]").map((family) => ({
    family: family as SignalSourceFamily,
    matched: true,
    reason: (parseJsonObject(row?.reasonJson ?? "{}")[family] as string) ?? "",
    observationIds: parseJsonArray(row?.contributingSignalIds ?? "[]"),
    values: {},
  }));

  return {
    positionId,
    state,
    policy,
    matchedFamilies,
    matchedCount: row?.matchedCount ?? 0,
    decisionId: row?.id ?? null,
    windowStartedAt: row?.windowStartedAt.toISOString() ?? null,
    confirmedAt: row?.confirmedAt?.toISOString() ?? null,
    expiresAt: row?.expiresAt?.toISOString() ?? null,
    readyForSimulation:
      state === "CONFIRMING" &&
      row?.confirmedAt !== null &&
      (row?.expiresAt === null || row.expiresAt.getTime() > now().getTime()),
    lastEvaluatedAt: now().toISOString(),
    drill,
    drillLabel: drill ? DRILL_LABEL : null,
    drillExplanation: drill
      ? "Real measurements with intentionally sensitive thresholds. This is a protection drill, not evidence of an Aave exploit."
      : null,
    reRead: null,
  };
};

export const getAuditEvents = async (
  db: VindexDb,
  positionId: string,
  limit = 50,
): Promise<Array<{ id: string; eventType: string; createdAt: string; details: Record<string, unknown>; blockNumber: string | null }>> => {
  const rows = await db
    .select()
    .from(auditEvents)
    .where(eq(auditEvents.positionId, positionId))
    .orderBy(desc(auditEvents.createdAt))
    .limit(limit);
  return rows.map((row) => ({
    id: row.id,
    eventType: row.eventType,
    createdAt: row.createdAt.toISOString(),
    details: parseJsonObject(row.detailsJson),
    blockNumber: row.blockNumber,
  }));
};

export const assertSafeWalletChangeAllowed = async (
  db: VindexDb,
  positionId: string,
): Promise<void> => {
  if (await isPolicyArmed(db, positionId)) {
    throw new VindexApiError(
      "POLICY_ARMED_RECONFIGURE_REQUIRED",
      "A protection policy is armed. Disarm it before changing the safe wallet.",
      409,
    );
  }
};

export { canonicalPositionId };
