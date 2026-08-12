// Position service: readiness flags, lossless serialization, 6-decimal
// formatting, stale handling, and the no-write-capability invariant. Uses the
// isolated test database for persistence; all chain/KeeperHub interaction is
// faked — no network, no real transactions.

import { describe, expect, it, afterAll } from "vitest";
import { keccak256, toBytes } from "viem";

import { AAVE_V3_BASE_SEPOLIA, KEEPERHUB_QUICKSTART_USDC_BASE_SEPOLIA } from "../../lib/vindex/aave-registry";
import { canonicalPositionId, refreshCurrentProtectedPosition } from "../../lib/vindex/position-service";
import { setSafeWalletConfig } from "../../lib/vindex/safe-wallet";
import { vindexConfig } from "../../db/schema";
import type { KeeperHubClient, KeeperHubWallet } from "../../lib/vindex/keeperhub";
import type { CanonicalReadClient } from "../../lib/vindex/public-client";
import type { VindexEnv } from "../../lib/vindex/env";
import { closeTestDb, getTestDb, hasDatabaseUrl } from "./helpers/test-db";

const ENV: VindexEnv = {
  baseSepoliaRpcUrl: "https://sepolia.base.org",
  keeperhubApiKey: "kh_test_key_123456",
  keeperhubApiBaseUrl: "https://app.keeperhub.com",
};

const WALLET = "0x675638ddbbf8b70b906d68e3485da72c6c63d130";
const USDC = AAVE_V3_BASE_SEPOLIA.usdcUnderlying;
const POOL = AAVE_V3_BASE_SEPOLIA.pool;
const ATK = AAVE_V3_BASE_SEPOLIA.usdcAToken;

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
  aUsdc?: bigint;
  usdc?: bigint;
  native?: bigint;
  allowance?: bigint;
  throwOnPosition?: boolean;
};

function createFakeRpc(config: FakeRpcConfig = {}): CanonicalReadClient {
  const client = {
    getChainId: async () => 84532,
    getBlockNumber: async () => BigInt(45380000),
    getBalance: async () => config.native ?? BigInt("20000000000000000"),
    getBytecode: async () => "0x1234" as `0x${string}`,
    readContract: async (args: { address: string; functionName: string }): Promise<unknown> => {
      if (config.throwOnPosition) throw new Error("rpc down");
      if (args.functionName === "balanceOf") {
        if (args.address.toLowerCase() === USDC.toLowerCase()) return config.usdc ?? BigInt(0);
        if (args.address.toLowerCase() === ATK.toLowerCase()) return config.aUsdc ?? BigInt(0);
        return BigInt(0);
      }
      if (args.functionName === "allowance") return config.allowance ?? BigInt(0);
      if (args.functionName === "getReserveConfigurationData") {
        return [BigInt(6), BigInt(8250), BigInt(8600), BigInt(0), BigInt(2000), true, true, false, true, false];
      }
      if (args.functionName === "decimals") return BigInt(6);
      if (args.functionName === "symbol") return "USDC";
      if (args.functionName === "getPool") return POOL;
      if (args.functionName === "getReserveTokensAddresses") {
        return [ATK, `0x${"33".repeat(20)}`, `0x${"44".repeat(20)}`];
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

const APPROVAL_TOPIC = keccak256(toBytes("Approval(address,address,uint256)"));

describe("position service invariants", () => {
  it("canonical position id is stable per execution wallet", () => {
    expect(canonicalPositionId(WALLET)).toBe(`base-sepolia:aave-v3:usdc:${WALLET.toLowerCase()}`);
    expect(canonicalPositionId(WALLET)).toBe(canonicalPositionId(WALLET));
  });

  it("uses the exact Aave-market USDC, never the generic quickstart token", () => {
    expect(USDC.toLowerCase()).not.toBe(KEEPERHUB_QUICKSTART_USDC_BASE_SEPOLIA.toLowerCase());
  });

  it("the service module has no KeeperHub write capability", async () => {
    const source = await import("fs/promises").then((fs) =>
      fs.readFile("lib/vindex/position-service.ts", "utf8"),
    );
    expect(source).not.toContain("executeContractCall");
    expect(source).not.toContain("walletClient");
  });
});

describe("readiness and serialization", () => {
  it("zero aUSDC means positionExists false and readyForMonitoring false", async () => {
    const db = await getTestDb();
    const result = await refreshCurrentProtectedPosition({
      env: ENV,
      db,
      keeperHubClient: createFakeKeeperHub(),
      publicClient: createFakeRpc({ aUsdc: BigInt(0) }),
    });
    expect(result.readiness.positionExists).toBe(false);
    expect(result.readiness.readyForMonitoring).toBe(false);
    expect(result.position.suppliedBalance.baseUnits).toBe("0");
  });

  it("non-zero aUSDC means positionExists true; amounts serialize losslessly", async () => {
    const db = await getTestDb();
    const result = await refreshCurrentProtectedPosition({
      env: ENV,
      db,
      keeperHubClient: createFakeKeeperHub(),
      publicClient: createFakeRpc({ aUsdc: BigInt("12345678901234567890") }),
    });
    expect(result.readiness.positionExists).toBe(true);
    expect(result.position.suppliedBalance.baseUnits).toBe("12345678901234567890");
    expect(result.position.suppliedBalance.formatted).toBe("12345678901234.56789");
    expect(result.position.blockNumber).toBe("45380000");
    expect(result.position.observedAt).not.toBe("");
  });

  it("formats 6-decimal amounts correctly", async () => {
    const db = await getTestDb();
    const result = await refreshCurrentProtectedPosition({
      env: ENV,
      db,
      keeperHubClient: createFakeKeeperHub(),
      publicClient: createFakeRpc({ aUsdc: BigInt(5000001) }),
    });
    expect(result.position.suppliedBalance.formatted).toBe("5.000001");
  });

  it("block provenance is included", async () => {
    const db = await getTestDb();
    const result = await refreshCurrentProtectedPosition({
      env: ENV,
      db,
      keeperHubClient: createFakeKeeperHub(),
      publicClient: createFakeRpc({ aUsdc: BigInt(5000001) }),
    });
    expect(result.position.blockNumber).toMatch(/^\d+$/);
    expect(result.position.blockTimestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("missing safe wallet means readyForMonitoring false even with a position", async () => {
    const db = await getTestDb();
    await db.delete(vindexConfig);
    const result = await refreshCurrentProtectedPosition({
      env: ENV,
      db,
      keeperHubClient: createFakeKeeperHub(),
      publicClient: createFakeRpc({ aUsdc: BigInt(5000001) }),
    });
    expect(result.readiness.positionExists).toBe(true);
    expect(result.readiness.safeWalletConfigured).toBe(false);
    expect(result.readiness.readyForMonitoring).toBe(false);
    expect(result.position.safeWallet).toBeNull();
  });

  it("valid safe wallet + position means readiness can pass", async () => {
    const db = await getTestDb();
    const SAFE = "0x2222222222222222222222222222222222222222";
    await setSafeWalletConfig(db, SAFE);
    const result = await refreshCurrentProtectedPosition({
      env: ENV,
      db,
      keeperHubClient: createFakeKeeperHub(),
      publicClient: createFakeRpc({ aUsdc: BigInt(5000001) }),
    });
    expect(result.readiness.safeWalletConfigured).toBe(true);
    expect(result.readiness.safeWalletValid).toBe(true);
    expect(result.readiness.positionExists).toBe(true);
    expect(result.readiness.networkValid).toBe(true);
    expect(result.readiness.contractsValid).toBe(true);
    expect(result.readiness.keeperHubHealthy).toBe(true);
    expect(result.readiness.readyForMonitoring).toBe(true);
    expect(result.position.safeWallet).toBe(SAFE);
  });
});

describe("stale handling", () => {
  it("failed live reads do not replace the last snapshot with fake zeros", async () => {
    const db = await getTestDb();
    // First a healthy refresh persists a real snapshot.
    await refreshCurrentProtectedPosition({
      env: ENV,
      db,
      keeperHubClient: createFakeKeeperHub(),
      publicClient: createFakeRpc({ aUsdc: BigInt(5000001) }),
    });
    // Then the RPC dies.
    const result = await refreshCurrentProtectedPosition({
      env: ENV,
      db,
      keeperHubClient: createFakeKeeperHub(),
      publicClient: createFakeRpc({ throwOnPosition: true }),
    });
    expect(result.freshness).toBe("stale");
    expect(result.position.suppliedBalance.baseUnits).toBe("5000001");
    expect(result.diagnostics.length).toBeGreaterThan(0);
  });

  it("the M2 artifact is not treated as the live balance source", async () => {
    const source = await import("fs/promises").then((fs) =>
      fs.readFile("lib/vindex/position-service.ts", "utf8"),
    );
    expect(source).not.toContain("m2-aave-position");
    expect(source).not.toContain("artifacts");
  });
});

describe("secrets", () => {
  it("API model serialization contains no secrets", async () => {
    const db = await getTestDb();
    const result = await refreshCurrentProtectedPosition({
      env: ENV,
      db,
      keeperHubClient: createFakeKeeperHub(),
      publicClient: createFakeRpc({ aUsdc: BigInt(5000001) }),
    });
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain("kh_test_key_123456");
    expect(serialized).not.toContain("Bearer");
    expect(serialized.toLowerCase()).not.toContain("authorization");
  });
});

afterAll(async () => {
  await closeTestDb();
});

void APPROVAL_TOPIC;
void hasDatabaseUrl;
