// M10 demo-run tests: stable per-run key derivation, active-run semantics,
// historical-rescue preservation, ALREADY_COMPLETE short-circuit, and the
// no-manual-insertion invariant. No real network or blockchain writes.

import { describe, expect, it, afterAll, beforeAll } from "vitest";
import { eq } from "drizzle-orm";

import {
  demoRuns,
  executions,
  rescueReceipts,
  threatDecisions,
  verificationChecks,
  auditEvents,
} from "../../db/schema";
import { m10IdempotencyKey, getActiveDemoRun, runDemoEndToEnd } from "../../lib/vindex/demo-run";
import type { KeeperHubClient, KeeperHubWallet } from "../../lib/vindex/keeperhub";
import type { VindexEnv } from "../../lib/vindex/env";
import { closeTestDb, getTestDb } from "./helpers/test-db";

const ENV: VindexEnv = {
  baseSepoliaRpcUrl: "https://sepolia.base.org",
  keeperhubApiKey: "kh_test_key_123456",
  keeperhubApiBaseUrl: "https://app.keeperhub.com",
};

const WALLET = "0x675638ddbbf8b70b906d68e3485da72c6c63d130";
const POSITION_ID = `base-sepolia:aave-v3:usdc:${WALLET.toLowerCase()}`;
const SAFE_WALLET = "0x2222222222222222222222222222222222222222";

const dbAvailable = Boolean(process.env.DATABASE_URL?.trim());
let db: Awaited<ReturnType<typeof getTestDb>>;

function createFakeKeeperHub(): KeeperHubClient {
  const wallet: KeeperHubWallet = {
    hasWallet: true,
    walletAddress: WALLET,
    walletId: "wal_1",
    isActive: true,
    invalidAddress: false,
    error: null,
  };
  return {
    healthCheck: async () => ({
      reachable: true,
      authenticated: true,
      keyShape: "kh_org" as const,
      statusCode: 200,
      errorCategory: null,
      checkedAt: "",
    }),
    getOrganizationWallet: async () => wallet,
  } as unknown as KeeperHubClient;
}

beforeAll(async () => {
  if (!dbAvailable) return;
  db = await getTestDb();
  await db.delete(verificationChecks);
  await db.delete(rescueReceipts);
  await db.delete(executions);
  await db.delete(threatDecisions);
  await db.delete(auditEvents);
  await db.delete(demoRuns);
});

afterAll(async () => {
  await closeTestDb();
});

describe("M10 idempotency keys", () => {
  it("are derived per demo run and per stage", () => {
    const runA = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const runB = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    expect(m10IdempotencyKey(runA, "fund")).toBe(`vindex-m10-${runA}-fund`);
    expect(m10IdempotencyKey(runA, "approve")).toBe(`vindex-m10-${runA}-approve`);
    expect(m10IdempotencyKey(runA, "supply")).toBe(`vindex-m10-${runA}-supply`);
    expect(m10IdempotencyKey(runA, "fund")).not.toBe(m10IdempotencyKey(runB, "fund"));
  });

  it("never collide with historical M2 or M7 keys", () => {
    const runId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
    const key = m10IdempotencyKey(runId, "supply");
    expect(key).toMatch(/^vindex-m10-/);
    expect(key).not.toContain("vindex-m2-");
    expect(key).not.toContain("vindex-m7-");
    expect(key).not.toContain("vindex-m1-");
  });
});

describe("active run semantics", () => {
  it.skipIf(!dbAvailable)("returns the active run and excludes terminal runs", async () => {
    const inserted = await db
      .insert(demoRuns)
      .values({ status: "CREATED", positionId: POSITION_ID })
      .returning({ id: demoRuns.id });
    const active = await getActiveDemoRun(db, POSITION_ID);
    expect(active?.id).toBe(inserted[0].id);

    await db
      .update(demoRuns)
      .set({ status: "PROTECTED" })
      .where(eq(demoRuns.id, inserted[0].id));
    expect(await getActiveDemoRun(db, POSITION_ID)).toBeNull();
  });

  it.skipIf(!dbAvailable)("a new run cannot overwrite the historical rescue", async () => {
    // Seed a "historical" completed run + its receipt/execution, then a fresh
    // PROTECTED run already on record; the orchestrator must short-circuit
    // with M10_ALREADY_COMPLETE and leave every historical row untouched.
    const historicalExec = await db
      .insert(executions)
      .values({
        decisionId: "00000000-0000-4000-8000-000000000001",
        status: "PROTECTED",
        chainId: 84532,
        target: "0x8bAB6d1b75f19e9eD9fCe8b9BD338844fF79aE27",
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
    await db.insert(demoRuns).values({
      status: "PROTECTED",
      positionId: POSITION_ID,
      rescueReceiptId: "00000000-0000-4000-8000-000000000099",
      completedAt: new Date(),
    });

    const beforeExec = (await db.select().from(executions)).length;
    const beforeReceipts = (await db.select().from(rescueReceipts)).length;

    const result = await runDemoEndToEnd({
      env: ENV,
      db,
      keeperHubClient: createFakeKeeperHub(),
      now: () => new Date("2026-08-12T12:00:00.000Z"),
    });

    expect(result.outcome).toBe("M10_ALREADY_COMPLETE");
    expect((await db.select().from(executions)).length).toBe(beforeExec);
    expect((await db.select().from(rescueReceipts)).length).toBe(beforeReceipts);
    // Historical receipt untouched.
    const receipt = (await db.select().from(rescueReceipts).where(eq(rescueReceipts.executionId, historicalExec[0].id)))[0];
    expect(receipt?.verifiedAmount).toBe("5000123");
  });
});

describe("no manual insertion", () => {
  it("the demo orchestrator never inserts signals or decisions directly", async () => {
    const source = await import("fs/promises").then((fs) =>
      fs.readFile("lib/vindex/demo-run.ts", "utf8"),
    );
    expect(source).not.toContain("insert(signalObservations)");
    expect(source).not.toContain("insert(threatDecisions)");
    expect(source).toContain("collectLiveSignalObservations");
    expect(source).toContain("evaluateProtectionPolicy");
  });
});
