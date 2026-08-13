// M5 policy + consensus tests: STANDARD/DRILL evaluation, distinct-family
// counting, freshness gates, confirmation re-read, safe-wallet pin, and
// idempotency. Uses the isolated test database; chain/KeeperHub/collection
// interaction is faked — no network, no real transactions.

import { describe, expect, it, vi, afterAll, beforeAll } from "vitest";

import {
  notificationDeliveries,
  protectedPositions,
  signalObservations,
  telegramSubscriptions,
} from "../../db/schema";
import {
  armPolicy,
  assertSafeWalletChangeAllowed,
  disarmPolicy,
  evaluateProtectionPolicy,
  getAuditEvents,
} from "../../lib/vindex/policy-service";
import {
  collectLiveSignalObservations,
  type SignalCollectionResult,
} from "../../lib/vindex/signal-service";
import { setSafeWalletConfig } from "../../lib/vindex/safe-wallet";
import type { KeeperHubClient, KeeperHubWallet } from "../../lib/vindex/keeperhub";
import type { CanonicalReadClient } from "../../lib/vindex/public-client";
import type { VindexEnv } from "../../lib/vindex/env";
import { closeTestDb, getTestDb } from "./helpers/test-db";

// The P1 alert hooks are fire-and-forget but still call the Telegram
// transport; mock it so no real network traffic ever leaves the test process.
vi.mock("../../lib/telegram/client", () => ({
  sendTelegramMessage: vi.fn(async () => ({ ok: true, messageId: "100", errorCode: null })),
}));

const ENV: VindexEnv = {
  baseSepoliaRpcUrl: "https://sepolia.base.org",
  keeperhubApiKey: "kh_test_key_123456",
  keeperhubApiBaseUrl: "https://app.keeperhub.com",
};

const WALLET = "0x675638ddbbf8b70b906d68e3485da72c6c63d130";
const USDC = "0xba50Cd2A20f6DA35D788639E581bca8d0B5d4D5f";
const POOL = "0x8bAB6d1b75f19e9eD9fCe8b9BD338844fF79aE27";
void USDC;
void POOL;
const ORACLE = "0x943b0dE18d4abf4eF02A85912F8fc07684C141dF";
const ATK = "0x10F1A9D11CDf50041f3f8cB7191CBE2f31750ACC";
const VDEBT = `0x${"77".repeat(20)}`;
const SAFE_WALLET = "0x2222222222222222222222222222222222222222";
const POSITION_ID = `base-sepolia:aave-v3:usdc:${WALLET.toLowerCase()}`;

// Evaluated at collection time, so module scope.
const dbAvailable = Boolean(process.env.DATABASE_URL?.trim());
let db: Awaited<ReturnType<typeof getTestDb>>;
let now: () => Date;

const makeWallet = (): KeeperHubWallet => ({
  hasWallet: true,
  walletAddress: WALLET,
  walletId: "wal_1",
  isActive: true,
  invalidAddress: false,
  error: null,
});

function createFakeKeeperHub(): KeeperHubClient {
  const client = {
    healthCheck: async () => ({
      reachable: true,
      authenticated: true,
      keyShape: "kh_org" as const,
      statusCode: 200,
      errorCategory: null,
      checkedAt: "",
    }),
    getOrganizationWallet: async () => makeWallet(),
  } as unknown as KeeperHubClient;
  return client;
}

function createFakeRpc(): CanonicalReadClient {
  const client = {
    getChainId: async () => 84532,
    getBlockNumber: async () => BigInt(45390000),
    getBalance: async () => BigInt("20000000000000000"),
    getBytecode: async () => "0x1234" as `0x${string}`,
    readContract: async (args: { address: string; functionName: string }): Promise<unknown> => {
      if (args.functionName === "getAssetPrice") return BigInt(99979128);
      if (args.functionName === "getReserveData") {
        return {
          liquidityIndex: BigInt("1242191067788355469701703930"),
          currentLiquidityRate: BigInt("22017985532403510445356237"),
          variableDebtTokenAddress: VDEBT,
        };
      }
      if (args.functionName === "getReserveConfigurationData") {
        return [BigInt(6), BigInt(8250), BigInt(8600), BigInt(0), BigInt(2000), true, true, false, true, false];
      }
      if (args.functionName === "totalSupply") return BigInt(9052688315567);
      if (args.functionName === "balanceOf") {
        if (args.address.toLowerCase() === ATK.toLowerCase()) return BigInt(5000056);
        return BigInt(0);
      }
      if (args.functionName === "allowance") return BigInt(0);
      if (args.functionName === "decimals") return BigInt(6);
      if (args.functionName === "symbol") return "USDC";
      if (args.functionName === "getPool") return POOL;
      if (args.functionName === "getReserveTokensAddresses") {
        return [ATK, `0x${"33".repeat(20)}`, VDEBT];
      }
      throw new Error(`Unexpected readContract call: ${args.functionName}`);
    },
    getTransactionReceipt: async () => {
      throw new Error("unexpected receipt read");
    },
    getBlock: async () => ({ timestamp: BigInt(Math.floor(Date.now() / 1000)) }),
  } as unknown as CanonicalReadClient;
  return client;
}

const seedObservation = async (
  metric: string,
  family: string,
  rawValue: string,
  contract: string,
  observedAt: Date,
  blockNumber: string,
  metadata: Record<string, unknown> = {},
  chainId = 84532,
): Promise<string> => {
  const inserted = await db
    .insert(signalObservations)
    .values({
      positionId: POSITION_ID,
      chainId,
      protocol: "Aave V3",
      sourceFamily: family,
      metric,
      rawValue,
      normalizedValue: rawValue,
      severity: null,
      contractAddress: contract,
      blockNumber,
      blockTimestamp: observedAt,
      observedAt,
      rpcSource: "Base Sepolia",
      metadataJson: JSON.stringify(metadata),
    })
    .returning({ id: signalObservations.id });
  return inserted[0].id;
};

const clearSignals = async () => {
  await db.delete(signalObservations);
};

const seedDrillBaseline = async (nowMs: number): Promise<void> => {
  await clearSignals();
  await seedObservation(
    "AAVE_USDC_ORACLE_PRICE", "ORACLE_PRICE_STATE", "99979128", ORACLE,
    new Date(nowMs - 60_000), "1000",
  );
  await seedObservation(
    "AAVE_RESERVE_TOTAL_VARIABLE_DEBT", "AAVE_RESERVE_STATE", "6154634874505", VDEBT,
    new Date(nowMs - 60_000), "1000",
  );
  await seedObservation(
    "POSITION_AUSDC_BALANCE", "POSITION_STATE", "5000065", ATK,
    new Date(nowMs - 60_000), "1000", { owner: WALLET, aToken: ATK },
  );
};

const seedStandardHealthy = async (nowMs: number): Promise<void> => {
  await clearSignals();
  await seedObservation("AAVE_USDC_ORACLE_PRICE", "ORACLE_PRICE_STATE", "100000000", ORACLE, new Date(nowMs - 120_000), "500");
  await seedObservation("AAVE_USDC_ORACLE_PRICE", "ORACLE_PRICE_STATE", "100000000", ORACLE, new Date(nowMs - 60_000), "1000");
  await seedObservation("AAVE_RESERVE_TOTAL_ATOKEN", "AAVE_RESERVE_STATE", "9052688315567", ATK, new Date(nowMs - 120_000), "500", { booleans: { isFrozen: false } });
  await seedObservation("AAVE_RESERVE_TOTAL_ATOKEN", "AAVE_RESERVE_STATE", "9052688315567", ATK, new Date(nowMs - 60_000), "1000", { booleans: { isFrozen: false } });
  await seedObservation("POSITION_AUSDC_BALANCE", "POSITION_STATE", "5000000", ATK, new Date(nowMs - 120_000), "500", { owner: WALLET });
  await seedObservation("POSITION_AUSDC_BALANCE", "POSITION_STATE", "5000000", ATK, new Date(nowMs - 60_000), "1000", { owner: WALLET });
};

const makePassingReRead = (blockNumber = "2000"): (typeof collectLiveSignalObservations) => {
  const fakeCollect = async (): Promise<SignalCollectionResult> => ({
    outcome: "COMPLETE",
    chainId: 84532,
    blockNumber,
    blockTimestamp: "2026-08-12T00:00:20.000Z",
    observedAt: "2026-08-12T00:00:20.000Z",
    rpcSource: "Base Sepolia",
    positionId: POSITION_ID,
    familiesCollected: ["ORACLE_PRICE_STATE", "AAVE_RESERVE_STATE", "POSITION_STATE"],
    observations: [
      { positionId: POSITION_ID, chainId: 84532, protocol: "Aave V3", sourceFamily: "ORACLE_PRICE_STATE", metric: "AAVE_USDC_ORACLE_PRICE", rawValue: "99979128", normalizedValue: "99979128", severity: null, contractAddress: ORACLE, blockNumber, blockTimestamp: "2026-08-12T00:00:20.000Z", observedAt: "2026-08-12T00:00:20.000Z", rpcSource: "Base Sepolia", metadata: {} },
      { positionId: POSITION_ID, chainId: 84532, protocol: "Aave V3", sourceFamily: "AAVE_RESERVE_STATE", metric: "AAVE_RESERVE_TOTAL_VARIABLE_DEBT", rawValue: "6154634874505", normalizedValue: "6154634874505", severity: null, contractAddress: VDEBT, blockNumber, blockTimestamp: "2026-08-12T00:00:20.000Z", observedAt: "2026-08-12T00:00:20.000Z", rpcSource: "Base Sepolia", metadata: {} },
      { positionId: POSITION_ID, chainId: 84532, protocol: "Aave V3", sourceFamily: "POSITION_STATE", metric: "POSITION_AUSDC_BALANCE", rawValue: "5000065", normalizedValue: "5000065", severity: null, contractAddress: ATK, blockNumber, blockTimestamp: "2026-08-12T00:00:20.000Z", observedAt: "2026-08-12T00:00:20.000Z", rpcSource: "Base Sepolia", metadata: {} },
    ],
    persistedCount: 3,
    duplicateCount: 0,
    diagnostics: [],
  });
  return fakeCollect as unknown as typeof collectLiveSignalObservations;
};

beforeAll(async () => {
  if (!dbAvailable) return;
  db = await getTestDb();
  await db.delete(signalObservations);
  // P1 tables: deliveries/subscriptions must start clean so the alert-hook
  // assertions below see only the rows this run creates.
  await db.delete(notificationDeliveries);
  await db.delete(telegramSubscriptions);
});

afterAll(async () => {
  await closeTestDb();
});

const arm = async (mode: "STANDARD" | "DRILL_HIGH_SENSITIVITY") => {
  await disarmPolicy(db, POSITION_ID);
  await setSafeWalletConfig(db, SAFE_WALLET);
  return armPolicy({ env: ENV, db, positionId: POSITION_ID, mode, publicClient: createFakeRpc(), keeperHubClient: createFakeKeeperHub(), now });
};

describe("policy evaluation", () => {
  it.skipIf(!dbAvailable)("healthy STANDARD market stays WATCHING", async () => {
    now = () => new Date("2026-08-12T12:00:00.000Z");
    await seedStandardHealthy(now().getTime());
    await arm("STANDARD");
    const view = await evaluateProtectionPolicy({ env: ENV, db, positionId: POSITION_ID, now });
    expect(view.state).toBe("WATCHING");
    expect(view.matchedCount).toBe(0);
    expect(view.readyForSimulation).toBe(false);
  });

  it.skipIf(!dbAvailable)("one matched family moves to ELEVATED", async () => {
    now = () => new Date("2026-08-12T12:00:00.000Z");
    await seedStandardHealthy(now().getTime());
    // Move the oracle price out of the STANDARD band (only oracle matches).
    await seedObservation("AAVE_USDC_ORACLE_PRICE", "ORACLE_PRICE_STATE", "90000000", ORACLE, new Date(now().getTime() - 30_000), "1500");
    await arm("STANDARD");
    const view = await evaluateProtectionPolicy({ env: ENV, db, positionId: POSITION_ID, now });
    expect(view.state).toBe("ELEVATED");
    expect(view.matchedCount).toBe(1);
    expect(view.matchedFamilies.filter((m) => m.matched)[0]?.family).toBe("ORACLE_PRICE_STATE");
    expect(view.readyForSimulation).toBe(false);
  });

  it.skipIf(!dbAvailable)("two distinct families reach CONFIRMING with fresh re-read", async () => {
    now = () => new Date("2026-08-12T12:00:00.000Z");
    await seedStandardHealthy(now().getTime());
    // Oracle out of band AND position drop 20% (two DISTINCT families).
    await seedObservation("AAVE_USDC_ORACLE_PRICE", "ORACLE_PRICE_STATE", "90000000", ORACLE, new Date(now().getTime() - 30_000), "1500");
    await seedObservation("POSITION_AUSDC_BALANCE", "POSITION_STATE", "4000000", ATK, new Date(now().getTime() - 30_000), "1500", { owner: WALLET });
    await arm("STANDARD");
    const view = await evaluateProtectionPolicy({
      env: ENV, db, positionId: POSITION_ID, now,
      collect: makePassingReRead("2000") as typeof collectLiveSignalObservations,
    });
    expect(view.state).toBe("CONFIRMING");
    expect(view.matchedCount).toBe(2);
    expect(view.readyForSimulation).toBe(true);
    expect(view.confirmedAt).not.toBeNull();
  });

  it.skipIf(!dbAvailable)("same-family metrics count as one distinct family", async () => {
    now = () => new Date("2026-08-12T12:00:00.000Z");
    await clearSignals();
    // A second live family (in-band oracle) so the arm gate (>= 2 LIVE families) passes.
    await seedObservation("AAVE_USDC_ORACLE_PRICE", "ORACLE_PRICE_STATE", "100000000", ORACLE, new Date(now().getTime() - 60_000), "1000");
    // RESERVE family matched via BOTH frozen and a supply drop — still one family.
    await seedObservation("AAVE_RESERVE_TOTAL_ATOKEN", "AAVE_RESERVE_STATE", "9052688315567", ATK, new Date(now().getTime() - 120_000), "500", { booleans: { isFrozen: true } });
    await seedObservation("AAVE_RESERVE_TOTAL_ATOKEN", "AAVE_RESERVE_STATE", "7000000000000", ATK, new Date(now().getTime() - 30_000), "1500", { booleans: { isFrozen: true } });
    await arm("STANDARD");
    const view = await evaluateProtectionPolicy({ env: ENV, db, positionId: POSITION_ID, now });
    const reserveMatches = view.matchedFamilies.filter((m) => m.family === "AAVE_RESERVE_STATE" && m.matched);
    expect(reserveMatches).toHaveLength(1);
    expect(view.matchedCount).toBe(1);
    expect(view.state).toBe("ELEVATED");
  });

  it.skipIf(!dbAvailable)("stale and wrong-chain observations are excluded", async () => {
    now = () => new Date("2026-08-12T12:00:00.000Z");
    await clearSignals();
    // DRILL-matching values but 2 hours old (stale) and on the wrong chain.
    await seedObservation("AAVE_USDC_ORACLE_PRICE", "ORACLE_PRICE_STATE", "99979128", ORACLE, new Date(now().getTime() - 2 * 3600 * 1000), "1");
    await seedObservation("AAVE_RESERVE_TOTAL_VARIABLE_DEBT", "AAVE_RESERVE_STATE", "999", VDEBT, new Date(now().getTime() - 2 * 3600 * 1000), "1", {}, 1);
    await seedObservation("POSITION_AUSDC_BALANCE", "POSITION_STATE", "5000000", ATK, new Date(now().getTime() - 2 * 3600 * 1000), "1");
    await arm("DRILL_HIGH_SENSITIVITY");
    const view = await evaluateProtectionPolicy({ env: ENV, db, positionId: POSITION_ID, now });
    expect(view.matchedCount).toBe(0);
    expect(view.state).toBe("WATCHING");
  });

  it.skipIf(!dbAvailable)("DRILL uses real M4 observations only", async () => {
    now = () => new Date("2026-08-12T12:00:00.000Z");
    await seedDrillBaseline(now().getTime());
    await arm("DRILL_HIGH_SENSITIVITY");
    const view = await evaluateProtectionPolicy({
      env: ENV, db, positionId: POSITION_ID, now,
      collect: makePassingReRead("2000") as typeof collectLiveSignalObservations,
    });
    expect(view.drill).toBe(true);
    expect(view.drillLabel).toContain("PROTECTION DRILL");
    const oracle = view.matchedFamilies.find((m) => m.family === "ORACLE_PRICE_STATE");
    expect(oracle?.values.raw).toBe("99979128");
    const reserve = view.matchedFamilies.find((m) => m.family === "AAVE_RESERVE_STATE");
    expect(reserve?.values.raw).toBe("6154634874505");
    expect(view.matchedCount).toBe(3);
  });

  it.skipIf(!dbAvailable)("a failed confirmation re-read prevents readyForSimulation", async () => {
    now = () => new Date("2026-08-12T12:00:00.000Z");
    await seedDrillBaseline(now().getTime());
    await arm("DRILL_HIGH_SENSITIVITY");
    const failingCollect = (async () => ({
      outcome: "FAILED" as const,
      chainId: 84532,
      blockNumber: "3000",
      blockTimestamp: null,
      observedAt: "2026-08-12T00:00:20.000Z",
      rpcSource: "Base Sepolia",
      positionId: POSITION_ID,
      familiesCollected: [],
      observations: [],
      persistedCount: 0,
      duplicateCount: 0,
      diagnostics: ["confirmation re-read failed"],
    })) as typeof collectLiveSignalObservations;
    const view = await evaluateProtectionPolicy({
      env: ENV, db, positionId: POSITION_ID, now, collect: failingCollect,
    });
    expect(view.state).toBe("ELEVATED");
    expect(view.readyForSimulation).toBe(false);
    expect(view.reRead?.outcome).toBe("failed");
    const events = await getAuditEvents(db, POSITION_ID, 20);
    expect(events.map((e) => e.eventType)).toContain("CONFIRMATION_FAILED");
  });

  it.skipIf(!dbAvailable)("a safe-wallet mismatch fails the confirmation re-read", async () => {
    now = () => new Date("2026-08-12T12:00:00.000Z");
    await seedDrillBaseline(now().getTime());
    await arm("DRILL_HIGH_SENSITIVITY");
    // Change the safe wallet AFTER arming.
    await setSafeWalletConfig(db, "0x3333333333333333333333333333333333333333");
    const view = await evaluateProtectionPolicy({
      env: ENV, db, positionId: POSITION_ID, now,
      collect: makePassingReRead("2000") as typeof collectLiveSignalObservations,
    });
    expect(view.state).toBe("ELEVATED");
    expect(view.readyForSimulation).toBe(false);
    expect(view.reRead?.reason ?? "").toContain("safe wallet");
  });

  it.skipIf(!dbAvailable)("an armed policy blocks safe-wallet changes", async () => {
    now = () => new Date("2026-08-12T12:00:00.000Z");
    await seedDrillBaseline(now().getTime());
    await arm("DRILL_HIGH_SENSITIVITY");
    await expect(assertSafeWalletChangeAllowed(db, POSITION_ID)).rejects.toMatchObject({
      code: "POLICY_ARMED_RECONFIGURE_REQUIRED",
    });
  });

  it.skipIf(!dbAvailable)("repeated evaluation is idempotent", async () => {
    now = () => new Date("2026-08-12T12:00:00.000Z");
    await seedDrillBaseline(now().getTime());
    await arm("DRILL_HIGH_SENSITIVITY");
    const { threatDecisions } = await import("../../db/schema");
    const collect = makePassingReRead("2000") as typeof collectLiveSignalObservations;
    const first = await evaluateProtectionPolicy({ env: ENV, db, positionId: POSITION_ID, now, collect });
    const rowsBefore = (await db.select().from(threatDecisions)).length;
    const second = await evaluateProtectionPolicy({ env: ENV, db, positionId: POSITION_ID, now, collect });
    const rowsAfter = (await db.select().from(threatDecisions)).length;
    expect(second.decisionId).toBe(first.decisionId);
    expect(second.state).toBe(first.state);
    expect(rowsAfter).toBe(rowsBefore);
  });
});

describe("boundaries", () => {
  it("the policy service has no KeeperHub or onchain write capability", async () => {
    const source = await import("fs/promises").then((fs) =>
      fs.readFile("lib/vindex/policy-service.ts", "utf8"),
    );
    expect(source).not.toContain("executeContractCall");
    expect(source).not.toContain("walletClient");
  });

  it.skipIf(!dbAvailable)("evaluation views contain no threat claims or secrets", async () => {
    now = () => new Date("2026-08-12T12:00:00.000Z");
    await seedDrillBaseline(now().getTime());
    await arm("DRILL_HIGH_SENSITIVITY");
    const view = await evaluateProtectionPolicy({
      env: ENV, db, positionId: POSITION_ID, now,
      collect: makePassingReRead("2000") as typeof collectLiveSignalObservations,
    });
    const serialized = JSON.stringify(view);
    expect(serialized).not.toContain("kh_test_key_123456");
    expect(serialized.toLowerCase()).not.toContain("authorization");
    expect(serialized).not.toContain("shouldEvacuate");
    const source = await import("fs/promises").then((fs) =>
      fs.readFile("lib/vindex/policy-service.ts", "utf8"),
    );
    expect(source).not.toContain("threatScore");
  });
});

describe("P1 risk alert hook", () => {
  // The hook is intentionally fire-and-forget (`void notifyRiskAlert(...)`),
  // so after the state-machine call we poll until the in-flight delivery has
  // been written (or the deadline passes) before asserting.
  const waitForRiskDeliveries = async (
    expected: number,
    deadlineMs = 2000,
  ): Promise<void> => {
    const deadline = Date.now() + deadlineMs;
    let count = 0;
    while (Date.now() < deadline) {
      const rows = await db.select().from(notificationDeliveries);
      count = rows.filter((r) => r.eventType === "RISK_ALERT").length;
      if (count >= expected) return;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  };

  it.skipIf(!dbAvailable)("a fresh confirmation sends exactly one risk alert", async () => {
    now = () => new Date("2026-08-12T12:00:00.000Z");
    await db.delete(notificationDeliveries);
    await db.delete(telegramSubscriptions);
    await db
      .insert(protectedPositions)
      .values({
        id: POSITION_ID,
        chainId: 84532,
        protocol: "aave-v3",
        poolAddress: `0x${"11".repeat(20)}`,
        assetAddress: `0x${"22".repeat(20)}`,
        assetSymbol: "USDC",
        assetDecimals: 6,
        positionTokenAddress: `0x${"33".repeat(20)}`,
        executionWallet: WALLET,
        safeWallet: SAFE_WALLET,
        latestPositionAmount: "5000077",
        latestUnderlyingWalletBalance: "0",
        latestNativeBalanceWei: "20000000000000000",
        latestAllowance: "0",
        latestBlockNumber: "45384000",
        latestBlockTimestamp: new Date(),
        observedAt: new Date(),
        createdAt: new Date(),
        updatedAt: new Date(),
      })
      .onConflictDoNothing();
    await db.insert(telegramSubscriptions).values({
      positionId: POSITION_ID,
      chatId: "42424242",
      telegramUsername: "vindex_user",
      riskAlertsEnabled: true,
      withdrawalAlertsEnabled: true,
    });
    await arm("DRILL_HIGH_SENSITIVITY");
    const nowMs = now().getTime();
    await seedDrillBaseline(nowMs);
    const first = await evaluateProtectionPolicy({
      env: ENV,
      db,
      positionId: POSITION_ID,
      collect: makePassingReRead(),
      publicClient: createFakeRpc(),
      keeperHubClient: createFakeKeeperHub(),
      now,
    });
    expect(first.state).toBe("CONFIRMING");
    await waitForRiskDeliveries(1);
    let rows = await db.select().from(notificationDeliveries);
    expect(rows.filter((r) => r.eventType === "RISK_ALERT")).toHaveLength(1);
    expect(rows.filter((r) => r.eventType === "RISK_ALERT")[0]?.status).toBe("SENT");

    // A repeated evaluation is idempotent (returns the same CONFIRMING
    // decision) and must not alert again.
    const second = await evaluateProtectionPolicy({
      env: ENV,
      db,
      positionId: POSITION_ID,
      collect: makePassingReRead("2001"),
      publicClient: createFakeRpc(),
      keeperHubClient: createFakeKeeperHub(),
      now,
    });
    expect(second.state).toBe("CONFIRMING");
    // Give any (unexpected) in-flight second delivery time to land, then
    // assert the dedup held.
    await new Promise((resolve) => setTimeout(resolve, 100));
    rows = await db.select().from(notificationDeliveries);
    expect(rows.filter((r) => r.eventType === "RISK_ALERT")).toHaveLength(1);
  });
});
