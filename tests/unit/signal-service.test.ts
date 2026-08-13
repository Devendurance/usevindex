// M4 signal service tests: chain gating, provenance, normalization, previous/
// delta, dedup, family failures, stale freshness, no-threat/no-secret, and the
// no-write-capability invariant. Uses the isolated test database; chain and
// KeeperHub interaction is faked — no network, no real transactions.

import { describe, expect, it, afterAll, beforeAll } from "vitest";
import { eq } from "drizzle-orm";

import { signalObservations } from "../../db/schema";
import { AAVE_V3_BASE_SEPOLIA, KEEPERHUB_QUICKSTART_USDC_BASE_SEPOLIA } from "../../lib/vindex/aave-registry";
import { canonicalPositionId } from "../../lib/vindex/position-service";
import {
  collectLiveSignalObservations,
  getLatestSignalObservations,
  getSignalHistory,
  SIGNAL_FAMILIES,
} from "../../lib/vindex/signal-service";
import { setSafeWalletConfig } from "../../lib/vindex/safe-wallet";
import type { KeeperHubClient, KeeperHubWallet } from "../../lib/vindex/keeperhub";
import type { CanonicalReadClient } from "../../lib/vindex/public-client";
import type { VindexEnv } from "../../lib/vindex/env";
import { closeTestDb, getTestDb } from "./helpers/test-db";

const ENV: VindexEnv = {
  baseSepoliaRpcUrl: "https://sepolia.base.org",
  keeperhubApiKey: "kh_test_key_123456",
  keeperhubApiBaseUrl: "https://app.keeperhub.com",
};

const WALLET = "0x675638ddbbf8b70b906d68e3485da72c6c63d130";
const USDC = AAVE_V3_BASE_SEPOLIA.usdcUnderlying;
void USDC;
void KEEPERHUB_QUICKSTART_USDC_BASE_SEPOLIA;
const POOL = AAVE_V3_BASE_SEPOLIA.pool;
const ATK = AAVE_V3_BASE_SEPOLIA.usdcAToken;
const ORACLE = AAVE_V3_BASE_SEPOLIA.aaveOracle;
const VDEBT = `0x${"77".repeat(20)}`;
const SAFE_WALLET = "0x2222222222222222222222222222222222222222";

const makeWallet = (overrides: Partial<KeeperHubWallet> = {}): KeeperHubWallet => ({
  hasWallet: true,
  walletAddress: WALLET,
  walletId: "wal_1",
  isActive: true,
  invalidAddress: false,
  error: null,
  ...overrides,
});

function createFakeKeeperHub(wallet: KeeperHubWallet = makeWallet()): KeeperHubClient {
  const client = {
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
  return client;
}

type FakeRpcConfig = {
  chainId?: number;
  blockNumber?: bigint;
  oraclePrice?: bigint;
  aTokenSupply?: bigint;
  vDebtSupply?: bigint;
  aUsdc?: bigint;
  failOracle?: boolean;
  failAll?: boolean;
};

function createFakeRpc(config: FakeRpcConfig = {}): CanonicalReadClient {
  const client = {
    getChainId: async () => config.chainId ?? 84532,
    getBlockNumber: async () => config.blockNumber ?? BigInt(45390000),
    getBalance: async () => BigInt("20000000000000000"),
    getBytecode: async () => "0x1234" as `0x${string}`,
    readContract: async (args: { address: string; functionName: string }): Promise<unknown> => {
      if (config.failAll) throw new Error("rpc down");
      if (args.functionName === "getAssetPrice") {
        if (config.failOracle) throw new Error("oracle down");
        return config.oraclePrice ?? BigInt(99979128);
      }
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
      if (args.functionName === "totalSupply") {
        if (args.address.toLowerCase() === ATK.toLowerCase()) return config.aTokenSupply ?? BigInt(9052688315567);
        return config.vDebtSupply ?? BigInt(6154616603108);
      }
      if (args.functionName === "balanceOf") {
        if (args.address.toLowerCase() === ATK.toLowerCase()) return config.aUsdc ?? BigInt(5000056);
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

// Evaluated at collection time (before beforeAll runs), so it must be module-scope.
const dbAvailable = Boolean(process.env.DATABASE_URL?.trim());

let db: Awaited<ReturnType<typeof getTestDb>>;

beforeAll(async () => {
  if (!dbAvailable) return;
  db = await getTestDb();
  await db.delete(signalObservations);
  await setSafeWalletConfig(db, SAFE_WALLET);
});

afterAll(async () => {
  await closeTestDb();
});

const collect = (rpc: CanonicalReadClient, now?: () => Date) =>
  collectLiveSignalObservations({
    env: ENV,
    db,
    publicClient: rpc,
    keeperHubClient: createFakeKeeperHub(),
    now,
  });

const POSITION_ID = canonicalPositionId(WALLET);

describe("signal collection", () => {
  it.skipIf(!dbAvailable)("wrong chain blocks collection", async () => {
    const result = await collect(createFakeRpc({ chainId: 1 }));
    expect(result.outcome).toBe("FAILED");
    expect(result.diagnostics.join(" ")).toContain("chain");
    expect(result.observations).toHaveLength(0);
  });

  it.skipIf(!dbAvailable)("observations carry block provenance", async () => {
    const result = await collect(createFakeRpc());
    expect(result.outcome).toBe("COMPLETE");
    expect(result.familiesCollected.sort()).toEqual([...SIGNAL_FAMILIES].sort());
    for (const observation of result.observations) {
      expect(observation.blockNumber).toBe("45390000");
      expect(observation.blockTimestamp).not.toBeNull();
      expect(observation.rpcSource).toBe("Base Sepolia");
    }
  });

  it.skipIf(!dbAvailable)("oracle input is not hardcoded", async () => {
    const result = await collect(createFakeRpc({ oraclePrice: BigInt(123456789) }));
    const oracle = result.observations.find((o) => o.metric === "AAVE_USDC_ORACLE_PRICE");
    expect(oracle?.rawValue).toBe("123456789");
    expect(oracle?.contractAddress.toLowerCase()).toBe(ORACLE.toLowerCase());
  });

  it.skipIf(!dbAvailable)("first sample has no invented previous value", async () => {
    await db.delete(signalObservations);
    const first = await collect(createFakeRpc());
    const oracle = first.observations.find((o) => o.metric === "AAVE_USDC_ORACLE_PRICE");
    expect(oracle?.metadata.previousValue).toBeUndefined();
    expect(oracle?.metadata.delta).toBeUndefined();
  });

  it.skipIf(!dbAvailable)("second sample carries real previous value and lossless delta", async () => {
    const second = await collect(createFakeRpc({ aTokenSupply: BigInt(9052688315567 + 518277) }));
    const total = second.observations.find((o) => o.metric === "AAVE_RESERVE_TOTAL_ATOKEN");
    expect(total?.metadata.previousValue).toBe("9052688315567");
    expect(total?.metadata.delta).toBe("518277");
    expect(total?.metadata.formatted).toBe("9052688.833844");
  });

  it.skipIf(!dbAvailable)("position uses the live service read, not artifacts", async () => {
    const result = await collect(createFakeRpc({ aUsdc: BigInt(7770001) }));
    const position = result.observations.find((o) => o.metric === "POSITION_AUSDC_BALANCE");
    expect(position?.rawValue).toBe("7770001");
    expect(position?.metadata.owner).toBe(WALLET);
    const source = await import("fs/promises").then((fs) =>
      fs.readFile("lib/vindex/signal-service.ts", "utf8"),
    );
    expect(source).not.toContain("m2-aave-position");
    expect(source).not.toContain("m3-live-dashboard");
  });

  it.skipIf(!dbAvailable)("same metric+block never duplicates", async () => {
    await db.delete(signalObservations);
    await collect(createFakeRpc());
    const count1 = await db.select().from(signalObservations);
    await collect(createFakeRpc(), () => new Date("2026-08-12T00:00:01.000Z"));
    const count2 = await db.select().from(signalObservations);
    expect(count2.length).toBe(count1.length);
    const uniqueBlocks = new Set(count2.map((row) => `${row.metric}|${row.blockNumber}`));
    expect(uniqueBlocks.size).toBe(count2.length);
  });

  it.skipIf(!dbAvailable)("different blocks persist new rows", async () => {
    await db.delete(signalObservations);
    await collect(createFakeRpc(), () => new Date("2026-08-12T00:00:00.000Z"));
    const advanced = createFakeRpc({ blockNumber: BigInt(45390001) });
    await collect(advanced, () => new Date("2026-08-12T00:05:00.000Z"));
    const rows = await db.select().from(signalObservations);
    expect(rows.length).toBe(12);
    expect(new Set(rows.map((row) => row.blockNumber)).size).toBe(2);
  });

  it.skipIf(!dbAvailable)("family failure returns PARTIAL without fabricating zeros", async () => {
    await db.delete(signalObservations);
    const result = await collect(createFakeRpc({ failOracle: true }));
    expect(result.outcome).toBe("PARTIAL");
    expect(result.familiesCollected).not.toContain("ORACLE_PRICE_STATE");
    const persisted = await db.select().from(signalObservations);
    expect(persisted.some((row) => row.metric === "AAVE_USDC_ORACLE_PRICE" && row.rawValue === "0")).toBe(false);
  });

  it.skipIf(!dbAvailable)("total read failure returns FAILED with no persisted rows", async () => {
    await db.delete(signalObservations);
    const result = await collect(createFakeRpc({ failAll: true }));
    expect(result.outcome).toBe("FAILED");
    const rows = await db.select().from(signalObservations);
    expect(rows).toHaveLength(0);
  });
});

describe("history and freshness", () => {
  it.skipIf(!dbAvailable)("stale observations remain STALE", async () => {
    await db.delete(signalObservations);
    const hourAgo = new Date(Date.now() - 60 * 60 * 1000);
    await db.insert(signalObservations).values({
      positionId: POSITION_ID,
      chainId: 84532,
      protocol: "Aave V3",
      sourceFamily: "ORACLE_PRICE_STATE",
      metric: "AAVE_USDC_ORACLE_PRICE",
      rawValue: "99979128",
      normalizedValue: "99979128",
      severity: null,
      contractAddress: ORACLE,
      blockNumber: "100",
      blockTimestamp: hourAgo,
      observedAt: hourAgo,
      rpcSource: "Base Sepolia",
      metadataJson: "{}",
    });
    const latest = await getLatestSignalObservations(db, POSITION_ID, () => new Date());
    expect(latest.freshness).toBe("STALE");
    expect(latest.latest[0].blockNumber).toBe("100");
  });

  it.skipIf(!dbAvailable)("history is ordered and filterable by family", async () => {
    await db.delete(signalObservations);
    await collect(createFakeRpc());
    const history = await getSignalHistory(db, POSITION_ID, { family: "ORACLE_PRICE_STATE" });
    expect(history.length).toBeGreaterThan(0);
    expect(history.every((o) => o.sourceFamily === "ORACLE_PRICE_STATE")).toBe(true);
  });
});

describe("boundaries", () => {
  it("collect cannot call KeeperHub or write onchain", async () => {
    const source = await import("fs/promises").then((fs) =>
      fs.readFile("lib/vindex/signal-service.ts", "utf8"),
    );
    expect(source).not.toContain("executeContractCall");
    expect(source).not.toContain("walletClient");
  });

  it("observations contain no threat classification or secrets", async () => {
    const source = await import("fs/promises").then((fs) =>
      fs.readFile("lib/vindex/signal-service.ts", "utf8"),
    );
    for (const forbidden of ["threatScore", "isDangerous", "matchedPolicy", "shouldEvacuate"]) {
      expect(source).not.toContain(forbidden);
    }
    const result = await collect(createFakeRpc());
    const serialized = JSON.stringify(result.observations);
    expect(serialized).not.toContain("kh_test_key_123456");
    expect(serialized.toLowerCase()).not.toContain("authorization");
  });
});

void eq;
