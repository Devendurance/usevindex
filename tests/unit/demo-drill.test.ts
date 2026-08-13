// D1 demo drill service tests: exactly one evacuation per run/decision,
// correct invocation of the existing services, PROTECTED only after
// destination verification, lifecycle settlement, and historical-proof
// preservation. Mocks only — zero real network or chain writes.

import { describe, expect, it, afterAll, beforeAll, beforeEach } from "vitest";
import { eq } from "drizzle-orm";

import {
  auditEvents,
  demoRuns,
  executions,
  protectionPolicies,
  rescueReceipts,
  signalObservations,
  threatDecisions,
  verificationChecks,
} from "../../db/schema";
import { runDemoDrill } from "../../lib/vindex/demo-run";
import type { VindexEnv } from "../../lib/vindex/env";
import { MAX_UINT256 } from "../../lib/vindex/aave-registry";
import { armPolicy, disarmPolicy, evaluateProtectionPolicy, getArmedPolicy, settleCompletedProtection } from "../../lib/vindex/policy-service";
import { prepareEvacuation } from "../../lib/vindex/evacuation-service";
import { executeEvacuation } from "../../lib/vindex/execution-service";
import { getRescueReceipt, verifyEvacuationDestination } from "../../lib/vindex/verification-service";
import { collectLiveSignalObservations } from "../../lib/vindex/signal-service";
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
  createFakeKeeperHub,
  createFakeRpc,
  freshChainState,
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
  status = "POSITION_CREATED",
  overrides: Partial<typeof demoRuns.$inferInsert> = {},
): Promise<typeof demoRuns.$inferSelect> => {
  const rows = await db
    .insert(demoRuns)
    .values({ status, positionId: POSITION_ID, ...overrides })
    .returning();
  return rows[0];
};

// Two+ fresh signal families the arm gate and the DRILL consensus read.
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

const drillContext = () => {
  const state = freshChainState({ walletAUsdc: BigInt(5000123) });
  const withdrawTxHash = `0x${"cd".repeat(32)}`;
  state.withdrawTxHash = withdrawTxHash;
  return {
    state,
    withdrawTxHash,
    keeperHub: createFakeKeeperHub({ withdrawTxHash }),
  };
};

beforeAll(async () => {
  if (!dbAvailable) return;
  db = await getTestDb();
  await db.delete(verificationChecks);
  await db.delete(rescueReceipts);
  await db.delete(executions);
  await db.delete(threatDecisions);
  await db.delete(protectionPolicies);
  await db.delete(auditEvents);
  await db.delete(signalObservations);
  await db.delete(demoRuns);
  await setSafeWalletConfig(db, SAFE_WALLET);
});

beforeEach(async () => {
  if (!dbAvailable) return;
  await db.delete(verificationChecks);
  await db.delete(rescueReceipts);
  await db.delete(executions);
  await db.delete(threatDecisions);
  await db.delete(protectionPolicies);
  await db.delete(auditEvents);
  await db.delete(signalObservations);
  await db.delete(demoRuns);
});

afterAll(async () => {
  await closeTestDb();
});

describe("runDemoDrill", () => {
  it.skipIf(!dbAvailable)("runs the full drill through PROTECTED and returns the completion view", async () => {
    const run = await seedRun();
    await seedSignals();
    const { state, withdrawTxHash, keeperHub } = drillContext();

    // (f) spy wrappers record every service invocation while delegating to
    // the real implementations.
    const calls: Array<{ service: string; args: unknown[] }> = [];
    const spy = <A extends unknown[], R>(service: string, fn: (...args: A) => R) =>
      (...args: A): R => {
        calls.push({ service, args });
        return fn(...args);
      };

    const view = await runDemoDrill({
      env: ENV,
      db,
      runId: run.id,
      keeperHubClient: keeperHub.client,
      publicClient: createFakeRpc(state),
      now: NOW,
      services: {
        disarmPolicy: spy("disarmPolicy", disarmPolicy),
        armPolicy: spy("armPolicy", armPolicy),
        collectLiveSignalObservations: spy("collect", collectLiveSignalObservations),
        evaluateProtectionPolicy: spy("evaluate", evaluateProtectionPolicy),
        prepareEvacuation: spy("prepare", prepareEvacuation),
        executeEvacuation: spy("execute", executeEvacuation),
        verifyEvacuationDestination: spy("verify", verifyEvacuationDestination),
        getRescueReceipt: spy("receipt", getRescueReceipt),
        settleCompletedProtection: spy("settle", settleCompletedProtection),
      },
    });

    expect(view.status).toBe("PROTECTED");
    expect(view.decisionId).not.toBeNull();
    expect(view.executionId).not.toBeNull();
    expect(view.keeperhubExecutionId).toMatch(/^kh_withdraw_/);
    expect(view.txHash).toBe(withdrawTxHash);
    expect(view.transactionLink).toBe(`https://sepolia.basescan.org/tx/${withdrawTxHash}`);
    expect(view.receiptId).not.toBeNull();
    expect(view.verifiedAmount).toBe("5000123");
    expect(view.destination).toBe(SAFE_WALLET);
    expect(view.safeWallet).toBe(SAFE_WALLET);
    expect(view.matchedCount).toBe(3);
    expect(view.requiredSignals).toBe(2);
    expect(view.drillLabel).toBe(DRILL_LABEL);

    // (f) services invoked in the documented order (the completion view
    // re-reads the receipt for the proof).
    expect(calls.map((c) => c.service)).toEqual([
      "disarmPolicy",
      "armPolicy",
      "collect",
      "evaluate",
      "prepare",
      "execute",
      "verify",
      "receipt",
      "settle",
      "receipt",
    ]);
    const armArgs = calls.find((c) => c.service === "armPolicy")?.args[0] as { mode: string; positionId: string };
    expect(armArgs.mode).toBe("DRILL_HIGH_SENSITIVITY");
    expect(armArgs.positionId).toBe(POSITION_ID);
    const evaluateArgs = calls.find((c) => c.service === "evaluate")?.args[0] as { positionId: string };
    expect(evaluateArgs.positionId).toBe(POSITION_ID);
    const prepareArgs = calls.find((c) => c.service === "prepare")?.args[0] as { decisionId: string };
    expect(prepareArgs.decisionId).toBe(view.decisionId);
    const executeArgs = calls.find((c) => c.service === "execute")?.args[0] as { executionId: string };
    expect(executeArgs.executionId).toBe(view.executionId);
    const verifyArgs = calls.find((c) => c.service === "verify")?.args[0] as { executionId: string };
    expect(verifyArgs.executionId).toBe(executeArgs.executionId);
    const receiptArgs = calls.find((c) => c.service === "receipt")?.args as [unknown, string];
    expect(receiptArgs[1]).toBe(view.receiptId);

    // Exactly one evacuation execution and one withdraw broadcast.
    const decisionExecs = await db
      .select()
      .from(executions)
      .where(eq(executions.decisionId, view.decisionId as string));
    expect(decisionExecs).toHaveLength(1);
    expect(decisionExecs[0]?.status).toBe("PROTECTED");
    expect(decisionExecs[0]?.keeperhubExecutionId).toBe(view.keeperhubExecutionId);
    expect(keeperHub.calls.execute.filter((c) => c.functionName === "withdraw")).toHaveLength(1);

    // Every stage transition persisted on the run row.
    const row = (await db.select().from(demoRuns).where(eq(demoRuns.id, run.id)))[0];
    expect(row?.status).toBe("PROTECTED");
    expect(row?.decisionId).toBe(view.decisionId);
    expect(row?.policyId).not.toBeNull();
    expect(row?.evacuationExecutionId).toBe(view.executionId);
    expect(row?.rescueReceiptId).toBe(view.receiptId);
    expect(row?.completedAt).not.toBeNull();

    // (j) lifecycle settled: no armed policy, decision resolved.
    expect(await getArmedPolicy(db, POSITION_ID)).toBeNull();
    const decisionRow = (await db
      .select()
      .from(threatDecisions)
      .where(eq(threatDecisions.id, view.decisionId as string)))[0];
    expect(decisionRow?.state).toBe("RESOLVED");
  });

  it.skipIf(!dbAvailable)("a second drill call on the same run cannot create a second execution", async () => {
    const run = await seedRun();
    await seedSignals();
    const { state, keeperHub } = drillContext();

    const first = await runDemoDrill({
      env: ENV,
      db,
      runId: run.id,
      keeperHubClient: keeperHub.client,
      publicClient: createFakeRpc(state),
      now: NOW,
    });
    expect(first.status).toBe("PROTECTED");
    const withdrawBroadcasts = keeperHub.calls.execute.filter((c) => c.functionName === "withdraw");
    expect(withdrawBroadcasts).toHaveLength(1);

    const second = await runDemoDrill({
      env: ENV,
      db,
      runId: run.id,
      keeperHubClient: keeperHub.client,
      publicClient: createFakeRpc(state),
      now: NOW,
    });
    expect(second.status).toBe("PROTECTED");
    expect(second.decisionId).toBe(first.decisionId);
    expect(second.executionId).toBe(first.executionId);
    expect(second.receiptId).toBe(first.receiptId);
    // No second broadcast and still exactly one execution row.
    expect(keeperHub.calls.execute.filter((c) => c.functionName === "withdraw")).toHaveLength(1);
    const decisionExecs = await db
      .select()
      .from(executions)
      .where(eq(executions.decisionId, first.decisionId as string));
    expect(decisionExecs).toHaveLength(1);
  });

  it.skipIf(!dbAvailable)("resumes from EXECUTED without re-executing and settles the lifecycle", async () => {
    const run = await seedRun();
    await seedSignals();
    const state = freshChainState({ walletAUsdc: BigInt(0), safeUsdc: BigInt(5000123) });
    const keeperHub = createFakeKeeperHub();

    // Pre-verification state: armed DRILL policy, CONFIRMING decision and an
    // EXECUTED_VERIFYING_DESTINATION execution with its Withdraw evidence.
    await disarmPolicy(db, POSITION_ID);
    const policy = await armPolicy({
      env: ENV, db, positionId: POSITION_ID, mode: "DRILL_HIGH_SENSITIVITY",
      publicClient: createFakeRpc(freshChainState({ walletAUsdc: BigInt(5000123) })),
      keeperHubClient: createFakeKeeperHub().client, now: NOW,
    });
    const decisionRows = await db
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
      })
      .returning({ id: threatDecisions.id });
    const decisionId = decisionRows[0].id;
    const txHash = `0x${"ab".repeat(32)}`;
    const execRows = await db
      .insert(executions)
      .values({
        decisionId,
        status: "EXECUTED_VERIFYING_DESTINATION",
        chainId: 84532,
        target: POOL,
        function: "withdraw",
        parametersHash: "a".repeat(64),
        requestedAmount: MAX_UINT256,
        safeWallet: SAFE_WALLET,
        keeperhubExecutionId: "direct_m7_1",
        txHash,
        transactionLink: `https://sepolia.basescan.org/tx/${txHash}`,
        sponsored: true,
        prePositionAmount: "5000123",
        preSafeWalletBalance: "0",
        preBlockNumber: "45399096",
        lastKeeperHubStatus: "completed",
      })
      .returning({ id: executions.id });
    const executionId = execRows[0].id;
    await db.insert(auditEvents).values({
      positionId: POSITION_ID,
      decisionId,
      eventType: "WITHDRAW_EVENT_VERIFIED",
      detailsJson: JSON.stringify({ executionId, transactionHash: txHash, actualWithdrawAmount: "5000123" }),
      blockNumber: "45399100",
    });
    await db
      .update(demoRuns)
      .set({ status: "EXECUTED", decisionId, evacuationExecutionId: executionId })
      .where(eq(demoRuns.id, run.id));

    const view = await runDemoDrill({
      env: ENV,
      db,
      runId: run.id,
      keeperHubClient: keeperHub.client,
      publicClient: createFakeRpc(state),
      now: NOW,
    });

    expect(view.status).toBe("PROTECTED");
    expect(view.decisionId).toBe(decisionId);
    expect(view.executionId).toBe(executionId);
    expect(view.txHash).toBe(txHash);
    expect(view.verifiedAmount).toBe("5000123");
    // No new broadcasts, no second execution.
    expect(keeperHub.calls.simulate).toHaveLength(0);
    expect(keeperHub.calls.execute).toHaveLength(0);
    const execRowsAfter = await db.select().from(executions).where(eq(executions.decisionId, decisionId));
    expect(execRowsAfter).toHaveLength(1);
    expect(execRowsAfter[0]?.status).toBe("PROTECTED");
    // (j) lifecycle settled on the resume path too.
    expect(await getArmedPolicy(db, POSITION_ID)).toBeNull();
    const decisionAfter = (await db
      .select()
      .from(threatDecisions)
      .where(eq(threatDecisions.id, decisionId)))[0];
    expect(decisionAfter?.state).toBe("RESOLVED");
  });

  it.skipIf(!dbAvailable)("fails with INTERVENTION_REQUIRED when destination verification does not verify", async () => {
    const run = await seedRun();
    await seedSignals();
    const state = freshChainState({
      walletAUsdc: BigInt(5000123),
      flipOnWithdraw: { wallet: true, safe: false },
    });
    const withdrawTxHash = `0x${"cd".repeat(32)}`;
    state.withdrawTxHash = withdrawTxHash;
    const keeperHub = createFakeKeeperHub({ withdrawTxHash });

    await expect(
      runDemoDrill({
        env: ENV,
        db,
        runId: run.id,
        keeperHubClient: keeperHub.client,
        publicClient: createFakeRpc(state),
        now: NOW,
      }),
    ).rejects.toMatchObject({ code: "INTERVENTION_REQUIRED" });

    // The run is FAILED, never PROTECTED, and no receipt exists.
    const row = (await db.select().from(demoRuns).where(eq(demoRuns.id, run.id)))[0];
    expect(row?.status).toBe("FAILED");
    expect(row?.errorCode).toBe("INTERVENTION_REQUIRED");
    expect(row?.completedAt).not.toBeNull();
    expect(row?.rescueReceiptId).toBeNull();
    expect(await db.select().from(rescueReceipts)).toHaveLength(0);
    const executionRows = await db.select().from(executions);
    expect(executionRows[0]?.status).toBe("INTERVENTION_REQUIRED");
  });

  it.skipIf(!dbAvailable)("a new drill completion preserves the previous rescue receipt", async () => {
    // Historical completed run + its execution and receipt.
    const historicalExec = await db
      .insert(executions)
      .values({
        decisionId: "00000000-0000-4000-8000-000000000001",
        status: "PROTECTED",
        chainId: 84532,
        target: POOL,
        function: "withdraw",
        parametersHash: "h".repeat(64),
        requestedAmount: "1",
        safeWallet: SAFE_WALLET,
        keeperhubExecutionId: "historical_exec_1",
        txHash: `0x${"11".repeat(32)}`,
        preSafeWalletBalance: "0",
      })
      .returning({ id: executions.id });
    await db.insert(rescueReceipts).values({
      executionId: historicalExec[0].id,
      positionId: POSITION_ID,
      policyMode: "DRILL_HIGH_SENSITIVITY",
      verifiedAmount: "5000123",
      destination: SAFE_WALLET,
      txHash: `0x${"11".repeat(32)}`,
      keeperhubExecutionId: "historical_exec_1",
      status: "PROTECTED",
      receiptJson: "{}",
    });
    const historicalRun = await db
      .insert(demoRuns)
      .values({
        status: "PROTECTED",
        positionId: POSITION_ID,
        rescueReceiptId: "00000000-0000-4000-8000-000000000099",
        completedAt: new Date(),
      })
      .returning({ id: demoRuns.id });

    const run = await seedRun();
    await seedSignals();
    const { state, withdrawTxHash, keeperHub } = drillContext();
    const view = await runDemoDrill({
      env: ENV,
      db,
      runId: run.id,
      keeperHubClient: keeperHub.client,
      publicClient: createFakeRpc(state),
      now: NOW,
    });

    expect(view.status).toBe("PROTECTED");
    expect(view.runId).toBe(run.id);
    expect(view.txHash).toBe(withdrawTxHash);

    // The historical proof rows are untouched; the new run created its own.
    const receipts = await db.select().from(rescueReceipts);
    expect(receipts).toHaveLength(2);
    const historical = receipts.find((r) => r.executionId === historicalExec[0].id);
    expect(historical?.verifiedAmount).toBe("5000123");
    expect(historical?.status).toBe("PROTECTED");
    const historicalRow = (await db
      .select()
      .from(demoRuns)
      .where(eq(demoRuns.id, historicalRun[0].id)))[0];
    expect(historicalRow?.status).toBe("PROTECTED");
    expect(historicalRow?.rescueReceiptId).toBe("00000000-0000-4000-8000-000000000099");
    const freshReceipt = receipts.find((r) => r.executionId === view.executionId);
    expect(freshReceipt?.id).toBe(view.receiptId);
  });
});
