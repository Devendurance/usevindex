// D1 demo prepare service tests: fresh-run creation, stage idempotency,
// resume safety, demo idempotency keys, and historical-run preservation.
// Mocks only — zero real network or chain writes.

import { describe, expect, it, afterAll, beforeAll, beforeEach } from "vitest";
import { rmSync } from "node:fs";
import { eq } from "drizzle-orm";

import { auditEvents, demoRuns } from "../../db/schema";
import {
  DEMO_IDEMPOTENCY_PREFIX,
  DEMO_SIMULATIONS_DIR,
  demoIdempotencyKey,
  getActiveDemoRun,
  prepareDemoPosition,
} from "../../lib/vindex/demo-run";
import type { VindexEnv } from "../../lib/vindex/env";
import { setSafeWalletConfig } from "../../lib/vindex/safe-wallet";
import { closeTestDb, getTestDb } from "./helpers/test-db";
import {
  createFakeKeeperHub,
  createFakeRpc,
  freshChainState,
  POSITION_ID,
  SAFE_WALLET,
} from "./helpers/demo-fakes";

const ENV: VindexEnv = {
  baseSepoliaRpcUrl: "https://sepolia.base.org",
  keeperhubApiKey: "kh_test_key_123456",
  keeperhubApiBaseUrl: "https://app.keeperhub.com",
};

const dbAvailable = Boolean(process.env.DATABASE_URL?.trim());
let db: Awaited<ReturnType<typeof getTestDb>>;

beforeAll(async () => {
  if (!dbAvailable) return;
  db = await getTestDb();
  await db.delete(auditEvents);
  await db.delete(demoRuns);
  await setSafeWalletConfig(db, SAFE_WALLET);
});

beforeEach(async () => {
  if (!dbAvailable) return;
  await db.delete(auditEvents);
  await db.delete(demoRuns);
});

afterAll(async () => {
  await closeTestDb();
  // Test runs persist fake simulation evidence; keep the working tree clean.
  rmSync(DEMO_SIMULATIONS_DIR, { recursive: true, force: true });
});

describe("demo idempotency keys", () => {
  it("derive vindex-demo keys per run and stage, never vindex-m10-", () => {
    const runA = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const runB = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    expect(demoIdempotencyKey(runA, "fund")).toBe(`vindex-demo-${runA}-fund`);
    expect(demoIdempotencyKey(runA, "approve")).toBe(`vindex-demo-${runA}-approve`);
    expect(demoIdempotencyKey(runA, "supply")).toBe(`vindex-demo-${runA}-supply`);
    expect(demoIdempotencyKey(runA, "fund")).not.toBe(demoIdempotencyKey(runB, "fund"));
    for (const stage of ["fund", "approve", "supply"] as const) {
      const key = demoIdempotencyKey(runA, stage);
      expect(key).toMatch(new RegExp(`^${DEMO_IDEMPOTENCY_PREFIX}-`));
      expect(key).not.toContain("vindex-m10-");
      expect(key).not.toContain("vindex-m1-");
      expect(key).not.toContain("vindex-m2-");
      expect(key).not.toContain("vindex-m7-");
    }
  });
});

describe("prepareDemoPosition", () => {
  it.skipIf(!dbAvailable)("creates a fresh run and advances FUNDED -> POSITION_CREATED with persisted KeeperHub execution ids", async () => {
    const kh = createFakeKeeperHub();
    const view = await prepareDemoPosition({
      env: ENV,
      db,
      keeperHubClient: kh.client,
      publicClient: createFakeRpc(freshChainState()),
      now: () => new Date("2026-08-13T10:00:00.000Z"),
    });

    expect(view.status).toBe("POSITION_CREATED");
    expect(view.fundingExecutionId).toBe(kh.calls.execute[0]?.executionId);
    expect(view.approvalExecutionId).toBe(kh.calls.execute[1]?.executionId);
    expect(view.supplyExecutionId).toBe(kh.calls.execute[2]?.executionId);
    expect(kh.calls.execute).toHaveLength(3);
    expect(view.transactionHashes.funding).toMatch(/^0x[0-9a-f]{64}$/);
    expect(view.transactionHashes.approval).toMatch(/^0x[0-9a-f]{64}$/);
    expect(view.transactionHashes.supply).toMatch(/^0x[0-9a-f]{64}$/);
    expect(view.links.supply).toContain("https://sepolia.basescan.org/tx/");
    expect(view.livePositionAmountBaseUnits).toBe("5000123");
    expect(view.safeWallet).toBe(SAFE_WALLET);
    expect(view.startingBlockNumber).toBeTruthy();

    const run = (await db.select().from(demoRuns).where(eq(demoRuns.id, view.runId)))[0];
    expect(run?.status).toBe("POSITION_CREATED");
    expect(run?.fundingExecutionId).toBe(view.fundingExecutionId);
    expect(run?.approvalExecutionId).toBe(view.approvalExecutionId);
    expect(run?.supplyExecutionId).toBe(view.supplyExecutionId);
    expect(run?.startingBlockNumber).toBe(view.startingBlockNumber);
    expect(run?.preDemoSafeWalletBalance).toBe("0");
    expect(run?.completedAt).toBeNull();

    // Every broadcast used the stable vindex-demo per-run keys.
    expect(kh.calls.execute.map((c) => c.idempotencyKey)).toEqual([
      `vindex-demo-${view.runId}-fund`,
      `vindex-demo-${view.runId}-approve`,
      `vindex-demo-${view.runId}-supply`,
    ]);
    expect(kh.calls.execute.map((c) => c.functionName)).toEqual(["mint", "approve", "supply"]);

    // Audits use DEMO_* names, never M10_*.
    const events = await db.select().from(auditEvents).where(eq(auditEvents.positionId, POSITION_ID));
    const types = events.map((e) => e.eventType);
    expect(types).toContain("DEMO_SIMULATION_PASSED");
    expect(types).toContain("DEMO_KEEPERHUB_SUBMITTED");
    expect(types).toContain("DEMO_STAGE_VERIFIED");
    expect(types).toContain("DEMO_FUNDED");
    expect(types).toContain("DEMO_APPROVED");
    expect(types).toContain("DEMO_POSITION_CREATED");
    expect(types.some((t) => t.startsWith("M10_"))).toBe(false);
  });

  it.skipIf(!dbAvailable)("resuming a completed prepare performs zero new broadcasts", async () => {
    const seeded = await db
      .insert(demoRuns)
      .values({
        status: "POSITION_CREATED",
        positionId: POSITION_ID,
        fundingExecutionId: "kh_fund_1",
        approvalExecutionId: "kh_approve_1",
        supplyExecutionId: "kh_supply_1",
      })
      .returning({ id: demoRuns.id });

    const kh = createFakeKeeperHub();
    const view = await prepareDemoPosition({
      env: ENV,
      db,
      keeperHubClient: kh.client,
      publicClient: createFakeRpc(freshChainState({ walletAUsdc: BigInt(5000123) })),
      now: () => new Date("2026-08-13T10:00:00.000Z"),
    });

    expect(view.runId).toBe(seeded[0].id);
    expect(view.status).toBe("POSITION_CREATED");
    expect(kh.calls.simulate).toHaveLength(0);
    expect(kh.calls.execute).toHaveLength(0);
    expect(kh.calls.status).toHaveLength(0);
    expect(view.fundingExecutionId).toBe("kh_fund_1");
    expect(view.approvalExecutionId).toBe("kh_approve_1");
    expect(view.supplyExecutionId).toBe("kh_supply_1");
    expect(view.livePositionAmountBaseUnits).toBe("5000123");
    // The adopt-only path appends no audit events.
    const events = await db.select().from(auditEvents).where(eq(auditEvents.positionId, POSITION_ID));
    expect(events).toHaveLength(0);
  });

  it.skipIf(!dbAvailable)("resumes from persisted state and only completes the missing stages", async () => {
    const seeded = await db
      .insert(demoRuns)
      .values({
        status: "FUNDED",
        positionId: POSITION_ID,
        fundingExecutionId: "kh_fund_1",
      })
      .returning({ id: demoRuns.id });

    const kh = createFakeKeeperHub();
    const view = await prepareDemoPosition({
      env: ENV,
      db,
      keeperHubClient: kh.client,
      publicClient: createFakeRpc(freshChainState()),
      now: () => new Date("2026-08-13T10:00:00.000Z"),
    });

    expect(view.runId).toBe(seeded[0].id);
    expect(view.status).toBe("POSITION_CREATED");
    expect(view.fundingExecutionId).toBe("kh_fund_1");
    // Fund is NOT re-broadcast; approve + supply use the same run's keys.
    expect(kh.calls.execute.map((c) => [c.functionName, c.idempotencyKey])).toEqual([
      ["approve", `vindex-demo-${seeded[0].id}-approve`],
      ["supply", `vindex-demo-${seeded[0].id}-supply`],
    ]);
    const run = (await db.select().from(demoRuns).where(eq(demoRuns.id, seeded[0].id)))[0];
    expect(run?.status).toBe("POSITION_CREATED");
    expect(run?.approvalExecutionId).toBe(kh.calls.execute[0]?.executionId);
    expect(run?.supplyExecutionId).toBe(kh.calls.execute[1]?.executionId);
  });

  it.skipIf(!dbAvailable)("adopts but fails the run when a POSITION_CREATED run has no live position", async () => {
    const seeded = await db
      .insert(demoRuns)
      .values({
        status: "POSITION_CREATED",
        positionId: POSITION_ID,
        fundingExecutionId: "kh_fund_1",
        approvalExecutionId: "kh_approve_1",
        supplyExecutionId: "kh_supply_1",
      })
      .returning({ id: demoRuns.id });

    const kh = createFakeKeeperHub();
    await expect(
      prepareDemoPosition({
        env: ENV,
        db,
        keeperHubClient: kh.client,
        publicClient: createFakeRpc(freshChainState()),
        now: () => new Date("2026-08-13T10:00:00.000Z"),
      }),
    ).rejects.toMatchObject({ code: "POSITION_ZERO" });

    // NEVER re-fund/re-supply on the adopt path.
    expect(kh.calls.execute).toHaveLength(0);
    const run = (await db.select().from(demoRuns).where(eq(demoRuns.id, seeded[0].id)))[0];
    expect(run?.status).toBe("FAILED");
    expect(run?.errorCode).toBe("POSITION_ZERO");
    expect(run?.completedAt).not.toBeNull();
  });

  it.skipIf(!dbAvailable)("a new prepare leaves historical completed runs untouched", async () => {
    const historical = await db
      .insert(demoRuns)
      .values({
        status: "PROTECTED",
        positionId: POSITION_ID,
        rescueReceiptId: "00000000-0000-4000-8000-000000000099",
        completedAt: new Date(),
      })
      .returning({ id: demoRuns.id });

    const kh = createFakeKeeperHub();
    const view = await prepareDemoPosition({
      env: ENV,
      db,
      keeperHubClient: kh.client,
      publicClient: createFakeRpc(freshChainState()),
      now: () => new Date("2026-08-13T10:00:00.000Z"),
    });

    // getActiveDemoRun ignores terminal runs; a brand-new run is created
    // alongside the historical one, which stays untouched.
    expect(view.runId).not.toBe(historical[0].id);
    expect((await getActiveDemoRun(db, POSITION_ID))?.id).toBe(view.runId);
    const rows = await db.select().from(demoRuns).where(eq(demoRuns.positionId, POSITION_ID));
    expect(rows).toHaveLength(2);
    const historicalRow = rows.find((r) => r.id === historical[0].id);
    expect(historicalRow?.status).toBe("PROTECTED");
    expect(historicalRow?.rescueReceiptId).toBe("00000000-0000-4000-8000-000000000099");
    expect(historicalRow?.completedAt).not.toBeNull();
    const newRow = rows.find((r) => r.id === view.runId);
    expect(newRow?.status).toBe("POSITION_CREATED");
  });
});
