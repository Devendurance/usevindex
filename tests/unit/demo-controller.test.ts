// D1 demo controller tests: authoritative status view derivation for every
// drill stage, validation flags + reasons, in-flight job guard (duplicate
// clicks cannot start a second job), route guards, refresh-resumes semantics,
// PROTECTED only after a receipt row, full-hash transaction links, no secrets
// in responses, and the demo_runs partial unique index. Mocks only — zero
// real network or chain writes.

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";

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
  vindexConfig,
} from "../../db/schema";
import { WrongChainError } from "../../lib/vindex/chain";
import {
  demoJobTypeLabel,
  getDemoLifecycleStatus,
  prepareDemoRoute,
  releaseDemoJob,
  runDemoDrillRoute,
  startDemoDrill,
  startDemoPrepare,
  tryAcquireDemoJob,
  type DemoLifecycleStatusView,
} from "../../lib/vindex/demo-controller";
import type { VindexEnv } from "../../lib/vindex/env";
import type { KeeperHubClient } from "../../lib/vindex/keeperhub";
import type { FailoverCanonicalClient } from "../../lib/vindex/rpc-failover";
import { CONFIG_SINGLETON_ID } from "../../db/schema";
import { MAX_UINT256 } from "../../lib/vindex/aave-registry";
import { DRILL_LABEL } from "../../lib/vindex/policy-templates";
import { setSafeWalletConfig } from "../../lib/vindex/safe-wallet";
import { closeTestDb, getTestDb } from "./helpers/test-db";
import {
  ATK,
  DEBT_TOKEN,
  ORACLE,
  POOL,
  POSITION_ID,
  SAFE_WALLET,
  USDC,
  WALLET,
  createFakeKeeperHub,
  createFakeRpc,
  freshChainState,
  type DemoChainState,
} from "./helpers/demo-fakes";

const ENV: VindexEnv = {
  baseSepoliaRpcUrl: "https://sepolia.base.org",
  keeperhubApiKey: "kh_test_key_123456",
  keeperhubApiBaseUrl: "https://app.keeperhub.com",
};

const NOW = () => new Date("2026-08-13T10:00:00.000Z");

const dbAvailable = Boolean(process.env.DATABASE_URL?.trim());
let db: Awaited<ReturnType<typeof getTestDb>>;

const seedRun = async (
  status: string,
  overrides: Partial<typeof demoRuns.$inferInsert> = {},
): Promise<typeof demoRuns.$inferSelect> => {
  const rows = await db
    .insert(demoRuns)
    .values({ status, positionId: POSITION_ID, ...overrides })
    .returning();
  return rows[0];
};

const seedPolicy = async (overrides: Partial<typeof protectionPolicies.$inferInsert> = {}): Promise<typeof protectionPolicies.$inferSelect> => {
  const rows = await db
    .insert(protectionPolicies)
    .values({
      positionId: POSITION_ID,
      mode: "DRILL_HIGH_SENSITIVITY",
      requiredSignals: 2,
      correlationWindowSec: 300,
      thresholdsJson: "{}",
      safeWalletSnapshot: SAFE_WALLET,
      isArmed: false,
      version: 1,
      ...overrides,
    })
    .returning();
  return rows[0];
};

const seedDecision = async (
  runId: string,
  overrides: Partial<typeof threatDecisions.$inferInsert> = {},
): Promise<{ decision: typeof threatDecisions.$inferSelect; policy: typeof protectionPolicies.$inferSelect }> => {
  const policy = await seedPolicy();
  const rows = await db
    .insert(threatDecisions)
    .values({
      positionId: POSITION_ID,
      policyId: policy.id,
      policyVersion: policy.version,
      state: "CONFIRMING",
      matchedCount: 3,
      contributingSignalIds: "[]",
      matchedFamiliesJson: '["ORACLE_PRICE_STATE","AAVE_RESERVE_STATE","POSITION_STATE"]',
      reasonJson: "{}",
      windowStartedAt: NOW(),
      confirmedAt: NOW(),
      expiresAt: new Date(NOW().getTime() + 3600 * 1000),
      ...overrides,
    })
    .returning();
  const decision = rows[0];
  await db
    .update(demoRuns)
    .set({ decisionId: decision.id, policyId: policy.id, status: "CONFIRMED" })
    .where(eq(demoRuns.id, runId));
  return { decision, policy };
};

const seedExecution = async (
  decisionId: string,
  status: string,
  overrides: Partial<typeof executions.$inferInsert> = {},
): Promise<typeof executions.$inferSelect> => {
  const rows = await db
    .insert(executions)
    .values({
      decisionId,
      status,
      chainId: 84532,
      target: POOL,
      function: "withdraw",
      parametersHash: "a".repeat(64),
      requestedAmount: MAX_UINT256,
      safeWallet: SAFE_WALLET,
      ...overrides,
    })
    .returning();
  return rows[0];
};

const seedReceipt = async (
  executionId: string,
  overrides: Partial<typeof rescueReceipts.$inferInsert> = {},
): Promise<typeof rescueReceipts.$inferSelect> => {
  const rows = await db
    .insert(rescueReceipts)
    .values({
      executionId,
      positionId: POSITION_ID,
      policyMode: "DRILL_HIGH_SENSITIVITY",
      verifiedAmount: "5000123",
      destination: SAFE_WALLET,
      txHash: `0x${"ab".repeat(32)}`,
      keeperhubExecutionId: "kh_withdraw_1",
      receiptJson: "{}",
      ...overrides,
    })
    .returning();
  return rows[0];
};

const seedSignals = async (): Promise<void> => {
  await db.delete(signalObservations);
  const recent = NOW();
  await db.insert(signalObservations).values([
    {
      positionId: POSITION_ID, chainId: 84532, protocol: "Aave V3",
      sourceFamily: "ORACLE_PRICE_STATE", metric: "AAVE_USDC_ORACLE_PRICE",
      rawValue: "100000000", normalizedValue: "100000000", severity: null,
      contractAddress: ORACLE, blockNumber: "45399000",
      blockTimestamp: recent, observedAt: recent, rpcSource: "Base Sepolia", metadataJson: "{}",
    },
    {
      positionId: POSITION_ID, chainId: 84532, protocol: "Aave V3",
      sourceFamily: "AAVE_RESERVE_STATE", metric: "AAVE_RESERVE_TOTAL_VARIABLE_DEBT",
      rawValue: "6154634874505", normalizedValue: "6154634874505", severity: null,
      contractAddress: DEBT_TOKEN, blockNumber: "45399000",
      blockTimestamp: recent, observedAt: recent, rpcSource: "Base Sepolia", metadataJson: "{}",
    },
    {
      positionId: POSITION_ID, chainId: 84532, protocol: "Aave V3",
      sourceFamily: "POSITION_STATE", metric: "POSITION_AUSDC_BALANCE",
      rawValue: "5000123", normalizedValue: "5000123", severity: null,
      contractAddress: ATK, blockNumber: "45399000",
      blockTimestamp: recent, observedAt: recent, rpcSource: "Base Sepolia", metadataJson: "{}",
    },
  ]);
};

const drillChainState = (): { state: DemoChainState; withdrawTxHash: string } => {
  const state = freshChainState({ walletAUsdc: BigInt(5000123) });
  const withdrawTxHash = `0x${"cd".repeat(32)}`;
  state.withdrawTxHash = withdrawTxHash;
  return { state, withdrawTxHash };
};

// RPC fake that throws the given error from readContract — either for every
// call or only for the safe-wallet owner (leaving the position preflight read
// intact), to exercise the outage fallback paths.
const rpcThatThrows = (error: Error, onlyForSafeWallet = false): FailoverCanonicalClient => {
  const base = createFakeRpc(freshChainState());
  return {
    ...base,
    readContract: async (...args: unknown[]) => {
      const call = args[0] as { functionName?: string; args?: unknown[] } | undefined;
      const owner = String((call?.args ?? [])[0] ?? "").toLowerCase();
      if (!onlyForSafeWallet || (call?.functionName === "balanceOf" && owner === SAFE_WALLET.toLowerCase())) {
        throw error;
      }
      return (base.readContract as (...broad: unknown[]) => Promise<unknown>)(...args);
    },
  } as unknown as FailoverCanonicalClient;
};

const statusOf = (state: DemoChainState = freshChainState({ walletAUsdc: BigInt(5000123) }), holdKind: "prepare" | "drill" | null = null): Promise<DemoLifecycleStatusView> => {
  const held = holdKind !== null && tryAcquireDemoJob(POSITION_ID, holdKind);
  return getDemoLifecycleStatus(ENV, db, {
    keeperHubClient: createFakeKeeperHub().client,
    publicClient: createFakeRpc(state),
    now: NOW,
  }).finally(() => {
    if (held) releaseDemoJob(POSITION_ID);
  });
};

const pollUntil = async (predicate: () => Promise<boolean>, timeoutMs = 15_000): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("pollUntil timed out");
};

beforeAll(async () => {
  if (!dbAvailable) {
    // This suite's deliverable evidence lives in real-DB assertions. Skipping
    // silently would report green while verifying nothing — fail loudly so a
    // missing DATABASE_URL can never masquerade as a passing suite.
    throw new Error(
      "DATABASE_URL is not set — this suite requires a real Postgres database. " +
        "Set DATABASE_URL (or TEST_DATABASE_URL, see tests/unit/helpers/test-db.ts) to run it.",
    );
  }
  db = await getTestDb();
  await db.delete(verificationChecks);
  await db.delete(rescueReceipts);
  await db.delete(executions);
  await db.delete(threatDecisions);
  await db.delete(protectionPolicies);
  await db.delete(auditEvents);
  await db.delete(signalObservations);
  await db.delete(protectedPositions);
  await db.delete(demoRuns);
  await setSafeWalletConfig(db, SAFE_WALLET);
});

beforeEach(async () => {
  await db.delete(verificationChecks);
  await db.delete(rescueReceipts);
  await db.delete(executions);
  await db.delete(threatDecisions);
  await db.delete(protectionPolicies);
  await db.delete(auditEvents);
  await db.delete(signalObservations);
  await db.delete(protectedPositions);
  await db.delete(demoRuns);
  releaseDemoJob(POSITION_ID);
});

afterAll(async () => {
  await closeTestDb();
});

describe("in-flight job guard", () => {
  it("acquires once per position and rejects a second job of either kind", () => {
    expect(tryAcquireDemoJob(POSITION_ID, "prepare")).toBe(true);
    expect(tryAcquireDemoJob(POSITION_ID, "drill")).toBe(false);
    expect(tryAcquireDemoJob(POSITION_ID, "prepare")).toBe(false);
    releaseDemoJob(POSITION_ID);
    expect(tryAcquireDemoJob(POSITION_ID, "drill")).toBe(true);
    releaseDemoJob(POSITION_ID);
  });

  it("derives the status-view job label", () => {
    expect(demoJobTypeLabel("prepare")).toBe("PREPARING");
    expect(demoJobTypeLabel("drill")).toBe("DRILLING");
    expect(demoJobTypeLabel(null)).toBeNull();
  });

  it("a second prepare while in-flight never starts a second job", async () => {
    const run = await seedRun("CREATED");
    const kh = createFakeKeeperHub();
    const state = freshChainState();

    tryAcquireDemoJob(POSITION_ID, "prepare");
    await startDemoPrepare(ENV, db, run.id, {
      keeperHubClient: kh.client,
      publicClient: createFakeRpc(state),
      now: NOW,
    });
    // No funding was attempted and the run row is untouched.
    expect(kh.calls.execute).toHaveLength(0);
    const row = (await db.select().from(demoRuns).where(eq(demoRuns.id, run.id)))[0];
    expect(row?.status).toBe("CREATED");
    releaseDemoJob(POSITION_ID);

    // With the guard released the same run resumes and completes prepare.
    await startDemoPrepare(ENV, db, run.id, {
      keeperHubClient: kh.client,
      publicClient: createFakeRpc(state),
      now: NOW,
    });
    const after = (await db.select().from(demoRuns).where(eq(demoRuns.id, run.id)))[0];
    expect(after?.status).toBe("POSITION_CREATED");
  });

  it("a second drill while in-flight never starts a second drill", async () => {
    const run = await seedRun("POSITION_CREATED");
    await seedSignals();
    const { state } = drillChainState();
    const kh = createFakeKeeperHub();

    tryAcquireDemoJob(POSITION_ID, "drill");
    await startDemoDrill(ENV, db, run.id, {
      keeperHubClient: kh.client,
      publicClient: createFakeRpc(state),
      now: NOW,
    });
    expect(await db.select().from(executions)).toHaveLength(0);
    expect(kh.calls.execute.filter((c) => c.functionName === "withdraw")).toHaveLength(0);
    releaseDemoJob(POSITION_ID);
  });
});

describe("status view — drill progress stage derivation", () => {
  it("WATCHING when no run or decision exists", async () => {
    const view = await statusOf();
    expect(view.activeRun).toBeNull();
    expect(view.drillProgress.stage).toBe("WATCHING");
    expect(view.drillProgress.label).toBe("Watching");
    expect(view.drillProgress.matchedCount).toBe(0);
    expect(view.drillProgress.requiredSignals).toBeNull();
    expect(view.drillProgress.drillLabel).toBeNull();
  });

  it("THREAT_EVIDENCE when signals were collected but no decision exists", async () => {
    await seedRun("OBSERVING");
    await seedSignals();
    const view = await statusOf();
    expect(view.drillProgress.stage).toBe("THREAT_EVIDENCE");
    expect(view.drillProgress.drillLabel).toBeNull();
  });

  it("THREAT_EVIDENCE for a partial ELEVATED decision (1/2)", async () => {
    const run = await seedRun("OBSERVING");
    await seedDecision(run.id, { state: "ELEVATED", matchedCount: 1, confirmedAt: null });
    const view = await statusOf();
    expect(view.drillProgress.stage).toBe("THREAT_EVIDENCE");
    expect(view.drillProgress.matchedCount).toBe(1);
    expect(view.drillProgress.requiredSignals).toBe(2);
    expect(view.drillProgress.drillLabel).toBe(DRILL_LABEL);
  });

  it("MATCHED N/M for an ELEVATED decision with the full match set (3/2)", async () => {
    const run = await seedRun("OBSERVING");
    await seedDecision(run.id, { state: "ELEVATED", matchedCount: 3, confirmedAt: null });
    const view = await statusOf();
    expect(view.drillProgress.stage).toBe("MATCHED");
    expect(view.drillProgress.matchedCount).toBe(3);
    expect(view.drillProgress.requiredSignals).toBe(2);
  });

  it("CONFIRMING for a confirmed decision", async () => {
    const run = await seedRun("OBSERVING");
    await seedDecision(run.id);
    const view = await statusOf();
    expect(view.drillProgress.stage).toBe("CONFIRMING");
    expect(view.activeRun?.decisionId).toBeTruthy();
    expect(view.activeRun?.policyId).toBeTruthy();
  });

  it("SIMULATION_PASSED from the prepared execution row", async () => {
    const run = await seedRun("OBSERVING");
    const { decision } = await seedDecision(run.id);
    const execution = await seedExecution(decision.id, "SIMULATION_PASSED");
    await db.update(demoRuns).set({ status: "SIMULATED", evacuationExecutionId: execution.id }).where(eq(demoRuns.id, run.id));
    const view = await statusOf();
    expect(view.drillProgress.stage).toBe("SIMULATION_PASSED");
  });

  it("KEEPERHUB_SUBMISSION for SUBMISSION_PENDING / SUBMISSION_UNKNOWN / EXECUTION_PENDING with a KeeperHub id", async () => {
    for (const [status, keeperhubExecutionId] of [
      ["SUBMISSION_PENDING", "kh_withdraw_1"],
      ["SUBMISSION_UNKNOWN", "kh_withdraw_1"],
      ["EXECUTION_PENDING", "kh_withdraw_1"],
    ] as const) {
      await db.delete(demoRuns);
      await db.delete(executions);
      await db.delete(threatDecisions);
      await db.delete(protectionPolicies);
      const run = await seedRun("OBSERVING");
      const { decision } = await seedDecision(run.id);
      const execution = await seedExecution(decision.id, status, { keeperhubExecutionId, lastKeeperHubStatus: "pending" });
      await db.update(demoRuns).set({ status: "EXECUTED", evacuationExecutionId: execution.id }).where(eq(demoRuns.id, run.id));
      const view = await statusOf();
      expect(view.drillProgress.stage).toBe("KEEPERHUB_SUBMISSION");
      expect(view.activeRun?.keeperhubExecutionId).toBe("kh_withdraw_1");
      expect(view.activeRun?.lastKeeperHubStatus).toBe("pending");
    }
  });

  it("EXECUTING for EXECUTION_PENDING without a resolvable KeeperHub id", async () => {
    const run = await seedRun("OBSERVING");
    const { decision } = await seedDecision(run.id);
    const execution = await seedExecution(decision.id, "EXECUTION_PENDING", { keeperhubExecutionId: null });
    await db.update(demoRuns).set({ status: "EXECUTED", evacuationExecutionId: execution.id }).where(eq(demoRuns.id, run.id));
    const view = await statusOf();
    expect(view.drillProgress.stage).toBe("EXECUTING");
  });

  it("TRANSACTION_CONFIRMED for EXECUTED_VERIFYING_DESTINATION with a tx hash before verification", async () => {
    const txHash = `0x${"ab".repeat(32)}`;
    const run = await seedRun("OBSERVING");
    const { decision } = await seedDecision(run.id);
    const execution = await seedExecution(decision.id, "EXECUTED_VERIFYING_DESTINATION", {
      txHash,
      transactionLink: `https://sepolia.basescan.org/tx/${txHash}`,
      keeperhubExecutionId: "kh_withdraw_1",
      lastKeeperHubStatus: "completed",
    });
    await db.update(demoRuns).set({ status: "EXECUTED", evacuationExecutionId: execution.id }).where(eq(demoRuns.id, run.id));
    const view = await statusOf();
    expect(view.drillProgress.stage).toBe("TRANSACTION_CONFIRMED");
    expect(view.activeRun?.transactionHashes.evacuation).toBe(txHash);
    expect(view.activeRun?.transactionLinks.evacuation).toBe(`https://sepolia.basescan.org/tx/${txHash}`);
  });

  it("VERIFYING_DESTINATION once a verification check row exists", async () => {
    const run = await seedRun("OBSERVING");
    const { decision } = await seedDecision(run.id);
    const execution = await seedExecution(decision.id, "EXECUTED_VERIFYING_DESTINATION", {
      txHash: `0x${"ab".repeat(32)}`,
      keeperhubExecutionId: "kh_withdraw_1",
    });
    await db.insert(verificationChecks).values({
      executionId: execution.id,
      assetAddress: POOL,
      destination: SAFE_WALLET,
      preBalance: "0",
      postBalance: "5000123",
      delta: "5000123",
      expectedAmount: "5000123",
      verified: true,
      blockNumber: "45399100",
      blockTimestamp: NOW(),
    });
    await db.update(demoRuns).set({ status: "EXECUTED", evacuationExecutionId: execution.id }).where(eq(demoRuns.id, run.id));
    const view = await statusOf();
    expect(view.drillProgress.stage).toBe("VERIFYING_DESTINATION");
  });

  it("PROTECTED only after a receipt row exists — never from execution status alone", async () => {
    // Execution claims PROTECTED but no receipt row: must NOT be PROTECTED.
    const run = await seedRun("OBSERVING");
    const { decision } = await seedDecision(run.id);
    const execution = await seedExecution(decision.id, "PROTECTED", { txHash: `0x${"ab".repeat(32)}` });
    await db.update(demoRuns).set({ status: "EXECUTED", evacuationExecutionId: execution.id }).where(eq(demoRuns.id, run.id));
    const before = await statusOf();
    expect(before.drillProgress.stage).toBe("VERIFYING_DESTINATION");
    expect(before.drillProgress.stage).not.toBe("PROTECTED");

    // Receipt row + PROTECTED run: the demo is complete.
    const receipt = await seedReceipt(execution.id);
    await db.update(demoRuns).set({ status: "PROTECTED", rescueReceiptId: receipt.id, completedAt: NOW() }).where(eq(demoRuns.id, run.id));
    const after = await statusOf();
    expect(after.activeRun).toBeNull();
    expect(after.drillProgress.stage).toBe("PROTECTED");
    expect(after.drillProgress.label).toBe("Protected");
  });
});

describe("status view — protection event, position, protection", () => {
  it("lastProtectionEvent is null when no receipt exists", async () => {
    const view = await statusOf();
    expect(view.lastProtectionEvent).toBeNull();
  });

  it("lastProtectionEvent shows the latest receipt and its execution", async () => {
    const txHash = `0x${"ab".repeat(32)}`;
    const run = await seedRun("OBSERVING");
    const { decision } = await seedDecision(run.id);
    const execution = await seedExecution(decision.id, "PROTECTED", {
      txHash,
      keeperhubExecutionId: "kh_withdraw_1",
      prePositionAmount: "5000123",
      preSafeWalletBalance: "0",
    });
    const receipt = await seedReceipt(execution.id, { txHash, keeperhubExecutionId: "kh_withdraw_1" });
    await db.update(demoRuns).set({ status: "PROTECTED", rescueReceiptId: receipt.id, completedAt: NOW() }).where(eq(demoRuns.id, run.id));
    await db.delete(demoRuns); // PROTECTED runs never surface as activeRun

    const view = await statusOf();
    expect(view.lastProtectionEvent).toMatchObject({
      status: "PROTECTED",
      receiptId: receipt.id,
      executionId: execution.id,
      txHash,
      keeperhubExecutionId: "kh_withdraw_1",
      verifiedAmount: "5000123",
      safeWallet: SAFE_WALLET,
      destination: SAFE_WALLET,
    });
    expect(view.lastProtectionEvent?.completedAt).toBe(receipt.createdAt.toISOString());
  });

  it("self-heal: armed policy + PROTECTED event settles once and reports disarmed", async () => {
    const txHash = `0x${"ab".repeat(32)}`;
    const run = await seedRun("OBSERVING");
    const { decision } = await seedDecision(run.id);
    const execution = await seedExecution(decision.id, "PROTECTED", { txHash, keeperhubExecutionId: "kh_withdraw_1" });
    const receipt = await seedReceipt(execution.id);
    await db.update(demoRuns).set({ status: "PROTECTED", rescueReceiptId: receipt.id, completedAt: NOW() }).where(eq(demoRuns.id, run.id));
    // Legacy M10 state: the drill policy is still armed after PROTECTED.
    await seedPolicy({ isArmed: true, armedAt: NOW() });

    const first = await statusOf();
    expect(first.lastProtectionEvent?.status).toBe("PROTECTED");
    expect(first.protection.armed).toBe(false);
    const policies = await db.select().from(protectionPolicies).where(eq(protectionPolicies.isArmed, true));
    expect(policies).toHaveLength(0);

    // Idempotent: a second read stays settled and does not error.
    const second = await statusOf();
    expect(second.protection.armed).toBe(false);
    // Historical evidence is preserved.
    expect(await db.select().from(rescueReceipts)).toHaveLength(1);
    expect(await db.select().from(executions)).toHaveLength(1);
  });

  it("currentPosition reflects the live chain read", async () => {
    const view = await statusOf(freshChainState({ walletAUsdc: BigInt(5000123), walletUsdc: BigInt(999) }));
    expect(view.currentPosition).toMatchObject({
      exists: true,
      positionAmountBaseUnits: "5000123",
      underlyingWalletBalance: "999",
      live: true,
    });
    expect(view.currentPosition.observedAt).toBe(NOW().toISOString());

    const drained = await statusOf(freshChainState());
    expect(drained.currentPosition.exists).toBe(false);
    expect(drained.currentPosition.positionAmountBaseUnits).toBe("0");
  });
});

describe("status view — validation flags", () => {
  it("readyToPrepare only when no in-progress run", async () => {
    expect((await statusOf()).validation.readyToPrepare).toBe(true);

    await seedRun("CREATED");
    const during = await statusOf();
    expect(during.validation.readyToPrepare).toBe(false);
    expect(during.validation.reasons).toContain("A demo run is already in progress (CREATED).");

    await db.delete(demoRuns);
    await seedRun("FAILED", { errorCode: "SIMULATION_FAILED", completedAt: NOW() });
    const afterFailure = await statusOf();
    expect(afterFailure.validation.readyToPrepare).toBe(true);
    expect(afterFailure.activeRun?.errorCode).toBe("SIMULATION_FAILED");
    expect(afterFailure.activeRun?.status).toBe("FAILED");
  });

  it("readyToArm only when position live + safe wallet configured + not armed", async () => {
    // Safe wallet configured (beforeAll), position live -> ready.
    expect((await statusOf()).validation.readyToArm).toBe(true);

    // Position drained -> not ready.
    expect((await statusOf(freshChainState())).validation.readyToArm).toBe(false);

    // Armed policy -> not ready.
    await seedPolicy({ isArmed: true, armedAt: NOW() });
    const armed = await statusOf();
    expect(armed.validation.readyToArm).toBe(false);
    expect(armed.protection.armed).toBe(true);
    expect(armed.protection.mode).toBe("DRILL_HIGH_SENSITIVITY");
    expect(armed.protection.policyId).toBeTruthy();
    expect(armed.protection.armedAt).toBe(NOW().toISOString());

    // No safe wallet -> not ready.
    await db.delete(protectionPolicies);
    await db.update(vindexConfig).set({ safeWallet: null }).where(eq(vindexConfig.id, CONFIG_SINGLETON_ID));
    const noSafe = await statusOf();
    expect(noSafe.validation.readyToArm).toBe(false);
    expect(noSafe.validation.reasons).toContain("Safe wallet is not configured.");
    await setSafeWalletConfig(db, SAFE_WALLET);
  });

  it("readyToRunDrill only when live position + active run + safe wallet + no competing execution + no in-flight", async () => {
    const run = await seedRun("POSITION_CREATED");
    const ready = await statusOf();
    expect(ready.validation.readyToRunDrill).toBe(true);
    expect(ready.validation.reasons).not.toContain("No active demo run — prepare the demo position first.");

    // Not live -> not ready.
    const drained = await statusOf(freshChainState());
    expect(drained.validation.readyToRunDrill).toBe(false);

    // In-flight drill -> not ready, reflected in the view.
    const inFlight = await statusOf(freshChainState({ walletAUsdc: BigInt(5000123) }), "drill");
    expect(inFlight.validation.inFlightJob).toBe("DRILLING");
    expect(inFlight.validation.readyToRunDrill).toBe(false);
    expect(inFlight.validation.reasons).toContain("A demo drill job is already running.");

    // Competing executed evacuation for the run's decision -> not ready.
    const { decision } = await seedDecision(run.id);
    await seedExecution(decision.id, "EXECUTED_VERIFYING_DESTINATION", { txHash: `0x${"ab".repeat(32)}` });
    const competing = await statusOf();
    expect(competing.validation.readyToRunDrill).toBe(false);
    expect(competing.validation.reasons).toContain("Another evacuation already executed for this decision.");
  });
});

describe("route guards", () => {
  it("prepare route rejects when a job is already in flight", async () => {
    tryAcquireDemoJob(POSITION_ID, "prepare");
    try {
      await expect(
        prepareDemoRoute(ENV, db, {
          keeperHubClient: createFakeKeeperHub().client,
          publicClient: createFakeRpc(freshChainState()),
          now: NOW,
        }),
      ).rejects.toMatchObject({ code: "IN_FLIGHT_JOB", status: 409 });
    } finally {
      releaseDemoJob(POSITION_ID);
    }
    expect(await db.select().from(demoRuns)).toHaveLength(0);
  });

  it("prepare route creates a run and the background job prepares the position", async () => {
    const kh = createFakeKeeperHub();
    const state = freshChainState();
    const result = await prepareDemoRoute(ENV, db, {
      keeperHubClient: kh.client,
      publicClient: createFakeRpc(state),
      now: NOW,
    });
    expect(result.started).toBe(true);
    expect(result.runId).toBeTruthy();

    await pollUntil(async () => {
      const row = (await db.select().from(demoRuns).where(eq(demoRuns.id, result.runId)))[0];
      return row?.status === "POSITION_CREATED";
    });
    expect(kh.calls.execute.map((c) => c.functionName)).toEqual(["mint", "approve", "supply"]);
  });

  it("prepare route adopts an existing active run without duplicating it", async () => {
    const existing = await seedRun("POSITION_CREATED", {
      fundingExecutionId: "kh_mint_1",
      approvalExecutionId: "kh_approve_1",
      supplyExecutionId: "kh_supply_1",
    });
    const kh = createFakeKeeperHub();
    const state = freshChainState({ walletAUsdc: BigInt(5000123) });
    const result = await prepareDemoRoute(ENV, db, {
      keeperHubClient: kh.client,
      publicClient: createFakeRpc(state),
      now: NOW,
    });
    expect(result.runId).toBe(existing.id);
    await pollUntil(async () => {
      const rows = await db.select().from(demoRuns).where(eq(demoRuns.id, existing.id));
      return rows[0]?.status === "POSITION_CREATED";
    });
    // No new run, no new broadcasts.
    expect(await db.select().from(demoRuns).where(eq(demoRuns.positionId, POSITION_ID))).toHaveLength(1);
    expect(kh.calls.execute).toHaveLength(0);
  });

  it("prepare route rejects a live position that belongs to no run", async () => {
    await expect(
      prepareDemoRoute(ENV, db, {
        keeperHubClient: createFakeKeeperHub().client,
        publicClient: createFakeRpc(freshChainState({ walletAUsdc: BigInt(5000123) })),
        now: NOW,
      }),
    ).rejects.toMatchObject({ code: "POSITION_ZERO", status: 409 });
    expect(await db.select().from(demoRuns)).toHaveLength(0);
  });

  it("drill route requires an active run (NO_ACTIVE_RUN)", async () => {
    await expect(
      runDemoDrillRoute(ENV, db, {
        keeperHubClient: createFakeKeeperHub().client,
        publicClient: createFakeRpc(freshChainState({ walletAUsdc: BigInt(5000123) })),
        now: NOW,
      }),
    ).rejects.toMatchObject({ code: "NO_ACTIVE_RUN", status: 409 });
  });

  it("drill route rejects when a job is already in flight", async () => {
    await seedRun("POSITION_CREATED");
    tryAcquireDemoJob(POSITION_ID, "drill");
    try {
      await expect(
        runDemoDrillRoute(ENV, db, {
          keeperHubClient: createFakeKeeperHub().client,
          publicClient: createFakeRpc(freshChainState({ walletAUsdc: BigInt(5000123) })),
          now: NOW,
        }),
      ).rejects.toMatchObject({ code: "IN_FLIGHT_JOB", status: 409 });
    } finally {
      releaseDemoJob(POSITION_ID);
    }
  });

  it("drill route rejects a drained position with POSITION_ZERO", async () => {
    await seedRun("POSITION_CREATED");
    await expect(
      runDemoDrillRoute(ENV, db, {
        keeperHubClient: createFakeKeeperHub().client,
        publicClient: createFakeRpc(freshChainState()),
        now: NOW,
      }),
    ).rejects.toMatchObject({ code: "POSITION_ZERO", status: 422 });
  });

  it("drill route rejects a competing executed evacuation", async () => {
    const run = await seedRun("POSITION_CREATED");
    const { decision } = await seedDecision(run.id);
    await seedExecution(decision.id, "EXECUTED_VERIFYING_DESTINATION", { txHash: `0x${"ab".repeat(32)}` });
    await expect(
      runDemoDrillRoute(ENV, db, {
        keeperHubClient: createFakeKeeperHub().client,
        publicClient: createFakeRpc(freshChainState({ walletAUsdc: BigInt(5000123) })),
        now: NOW,
      }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST", status: 409 });
  });

  it("drill route runs the full drill to PROTECTED with a receipt", async () => {
    const run = await seedRun("POSITION_CREATED");
    await seedSignals();
    const { state, withdrawTxHash } = drillChainState();
    const kh = createFakeKeeperHub({ withdrawTxHash });

    const result = await runDemoDrillRoute(ENV, db, {
      keeperHubClient: kh.client,
      publicClient: createFakeRpc(state),
      now: NOW,
    });
    expect(result.runId).toBe(run.id);

    await pollUntil(async () => {
      const row = (await db.select().from(demoRuns).where(eq(demoRuns.id, run.id)))[0];
      return row?.status === "PROTECTED";
    });
    const row = (await db.select().from(demoRuns).where(eq(demoRuns.id, run.id)))[0];
    expect(row?.rescueReceiptId).not.toBeNull();

    // Authoritative view: PROTECTED stage, receipt event, full-hash link.
    const view = await statusOf(freshChainState({ walletAUsdc: BigInt(0), safeUsdc: BigInt(5000123) }));
    expect(view.drillProgress.stage).toBe("PROTECTED");
    expect(view.lastProtectionEvent?.txHash).toBe(withdrawTxHash);
    expect(view.lastProtectionEvent?.verifiedAmount).toBe("5000123");
    expect(view.lastProtectionEvent?.safeWallet).toBe(SAFE_WALLET);
    expect(view.lastProtectionEvent?.keeperhubExecutionId).toMatch(/^kh_withdraw_/);
    expect(view.activeRun).toBeNull();
    expect(view.protection.armed).toBe(false); // settled after PROTECTED
  });
});

describe("status view — refresh resumes from persisted state", () => {
  it("mid-prepare status reflects persisted stage execution ids and tx hashes", async () => {
    const kh = createFakeKeeperHub();
    const state = freshChainState();
    const result = await prepareDemoRoute(ENV, db, {
      keeperHubClient: kh.client,
      publicClient: createFakeRpc(state),
      now: NOW,
    });
    await pollUntil(async () => {
      const row = (await db.select().from(demoRuns).where(eq(demoRuns.id, result.runId)))[0];
      return row?.status === "POSITION_CREATED";
    });

    const view = await getDemoLifecycleStatus(ENV, db, {
      keeperHubClient: createFakeKeeperHub().client,
      publicClient: createFakeRpc(state),
      now: NOW,
    });
    expect(view.activeRun?.runId).toBe(result.runId);
    expect(view.activeRun?.status).toBe("POSITION_CREATED");
    expect(view.activeRun?.stageExecutionIds).toEqual({
      fund: kh.calls.execute[0]?.executionId,
      approve: kh.calls.execute[1]?.executionId,
      supply: kh.calls.execute[2]?.executionId,
    });
    expect(view.activeRun?.transactionHashes.fund).toMatch(/^0x[0-9a-f]{64}$/);
    expect(view.activeRun?.transactionHashes.approve).toMatch(/^0x[0-9a-f]{64}$/);
    expect(view.activeRun?.transactionHashes.supply).toMatch(/^0x[0-9a-f]{64}$/);
    expect(view.activeRun?.transactionLinks.supply).toContain("https://sepolia.basescan.org/tx/");
    expect(view.currentPosition.exists).toBe(true);
  });
});

describe("status view — no secrets and full-hash links", () => {
  it("the view never contains secrets", async () => {
    const txHash = `0x${"ab".repeat(32)}`;
    const run = await seedRun("OBSERVING");
    const { decision } = await seedDecision(run.id);
    const execution = await seedExecution(decision.id, "PROTECTED", {
      txHash,
      transactionLink: `https://sepolia.basescan.org/tx/${txHash}`,
      keeperhubExecutionId: "kh_withdraw_1",
      lastKeeperHubStatus: "completed",
    });
    await seedReceipt(execution.id);
    await db.update(demoRuns).set({ status: "PROTECTED", rescueReceiptId: (await db.select().from(rescueReceipts))[0].id, completedAt: NOW() }).where(eq(demoRuns.id, run.id));

    const view = await statusOf();
    const serialized = JSON.stringify(view);
    // Never the API key, its base URL or the RPC endpoint. KeeperHub
    // execution ids (kh_...) legitimately appear as proof data, so the
    // assertion targets the credential values themselves, not the prefix.
    expect(serialized).not.toContain(ENV.keeperhubApiKey);
    expect(serialized).not.toContain(ENV.keeperhubApiBaseUrl);
    expect(serialized).not.toContain(ENV.baseSepoliaRpcUrl);
    expect(serialized).not.toContain("kh_test_key");
  });

  it("evacuation transaction link uses the full 66-char hash", async () => {
    const txHash = `0x${"cd".repeat(32)}`;
    expect(txHash).toHaveLength(66);
    const run = await seedRun("OBSERVING");
    const { decision } = await seedDecision(run.id);
    const execution = await seedExecution(decision.id, "EXECUTED_VERIFYING_DESTINATION", {
      txHash,
      transactionLink: `https://sepolia.basescan.org/tx/${txHash}`,
      keeperhubExecutionId: "kh_withdraw_1",
    });
    await db.update(demoRuns).set({ status: "EXECUTED", evacuationExecutionId: execution.id }).where(eq(demoRuns.id, run.id));
    const view = await statusOf();
    expect(view.activeRun?.transactionHashes.evacuation).toBe(txHash);
    expect(view.activeRun?.transactionLinks.evacuation).toBe(`https://sepolia.basescan.org/tx/${txHash}`);
  });
});

describe("outage fallbacks (zero real writes)", () => {
  it("status view degrades truthfully to an empty view when KeeperHub is unreachable", async () => {
    const kh = createFakeKeeperHub();
    const downKeeperHub: KeeperHubClient = {
      ...kh.client,
      getOrganizationWallet: async () => {
        throw new Error("KeeperHub transport failure");
      },
    };
    // The read must resolve with a degraded view (the route then returns 200)
    // — it must never reject into a 5xx.
    const view = await getDemoLifecycleStatus(ENV, db, {
      keeperHubClient: downKeeperHub,
      publicClient: createFakeRpc(freshChainState()),
      now: NOW,
    });
    expect(view.positionId).toBeNull();
    expect(view.activeRun).toBeNull();
    expect(view.lastProtectionEvent).toBeNull();
    expect(view.currentPosition).toMatchObject({
      exists: false,
      positionAmountBaseUnits: "0",
      underlyingWalletBalance: "0",
      live: false,
      observedAt: null,
    });
    expect(view.validation).toMatchObject({
      readyToPrepare: false,
      readyToArm: false,
      readyToRunDrill: false,
      inFlightJob: null,
    });
    expect(view.validation.reasons).toContain("KeeperHub organization wallet is unavailable.");
  });

  it("currentPosition falls back to the persisted snapshot when the RPC read throws", async () => {
    await db.insert(protectedPositions).values({
      id: POSITION_ID,
      chainId: 84532,
      protocol: "aave-v3",
      poolAddress: POOL,
      assetAddress: USDC,
      assetSymbol: "USDC",
      assetDecimals: 6,
      positionTokenAddress: ATK,
      executionWallet: WALLET,
      safeWallet: SAFE_WALLET,
      latestPositionAmount: "1234567",
      latestUnderlyingWalletBalance: "888",
      latestNativeBalanceWei: "0",
      latestAllowance: "0",
      latestBlockNumber: "45399000",
      latestBlockTimestamp: NOW(),
      observedAt: NOW(),
    });

    const view = await getDemoLifecycleStatus(ENV, db, {
      keeperHubClient: createFakeKeeperHub().client,
      publicClient: rpcThatThrows(new Error("RPC transport failure")),
      now: NOW,
    });
    expect(view.positionId).toBe(POSITION_ID);
    expect(view.currentPosition).toMatchObject({
      exists: true,
      positionAmountBaseUnits: "1234567",
      underlyingWalletBalance: "888",
      live: false,
    });
    expect(view.currentPosition.observedAt).toBe(NOW().toISOString());
  });

  it("a failing prepare job persists FAILED with errorCode and the runner never rejects", async () => {
    const run = await seedRun("CREATED");
    const kh = createFakeKeeperHub();
    const failingKeeperHub: KeeperHubClient = {
      ...kh.client,
      executeContractCall: async () => {
        throw new Error("KeeperHub transport failure");
      },
    };
    const job = startDemoPrepare(ENV, db, run.id, {
      keeperHubClient: failingKeeperHub,
      publicClient: createFakeRpc(freshChainState()),
      now: NOW,
    });
    // The background runner swallows the failure after persisting it — the
    // returned promise resolves and no unhandled rejection reaches the process.
    await expect(job).resolves.toBeUndefined();
    const row = (await db.select().from(demoRuns).where(eq(demoRuns.id, run.id)))[0];
    expect(row?.status).toBe("FAILED");
    expect(row?.errorCode).toBe("SUBMISSION_UNKNOWN");
    expect(row?.completedAt).toBeTruthy();
  });

  it("prepare route maps a safe-wallet RPC failure to RPC_ALL_UNAVAILABLE (503)", async () => {
    await expect(
      prepareDemoRoute(ENV, db, {
        keeperHubClient: createFakeKeeperHub().client,
        publicClient: rpcThatThrows(new Error("RPC transport failure"), true),
        now: NOW,
      }),
    ).rejects.toMatchObject({ code: "RPC_ALL_UNAVAILABLE", status: 503 });
  });

  it("prepare route maps a wrong-chain safe-wallet read to WRONG_CHAIN (502)", async () => {
    await expect(
      prepareDemoRoute(ENV, db, {
        keeperHubClient: createFakeKeeperHub().client,
        publicClient: rpcThatThrows(new WrongChainError(84533), true),
        now: NOW,
      }),
    ).rejects.toMatchObject({ code: "WRONG_CHAIN", status: 502 });
  });
});

describe("demo_runs partial unique index (migration 0008)", () => {
  it("PROTECTED and CREATED runs for the same position coexist", async () => {
    await seedRun("PROTECTED", { completedAt: NOW() });
    const created = await seedRun("CREATED");
    const rows = await db
      .select()
      .from(demoRuns)
      .where(and(eq(demoRuns.positionId, POSITION_ID), eq(demoRuns.id, created.id)));
    expect(rows).toHaveLength(1);
    const all = await db.select().from(demoRuns).where(eq(demoRuns.positionId, POSITION_ID));
    expect(all.map((r) => r.status).sort()).toEqual(["CREATED", "PROTECTED"]);
  });

  it("FAILED and CREATED runs for the same position coexist", async () => {
    await seedRun("FAILED", { errorCode: "SIMULATION_FAILED", completedAt: NOW() });
    const created = await seedRun("CREATED");
    expect(created.status).toBe("CREATED");
  });

  it("two concurrent CREATED inserts for the same position — one wins", async () => {
    await seedRun("CREATED");
    let violated = false;
    try {
      await db.insert(demoRuns).values({ status: "CREATED", positionId: POSITION_ID });
    } catch (error) {
      // Drizzle wraps the driver error (SQLSTATE 23505 = unique_violation)
      // in a DrizzleQueryError with the PostgresError as `cause`.
      const code = (error as { cause?: { code?: string } }).cause?.code;
      violated = code === "23505";
    }
    expect(violated).toBe(true);
    const rows = await db.select().from(demoRuns).where(eq(demoRuns.positionId, POSITION_ID));
    expect(rows).toHaveLength(1);
  });
});
