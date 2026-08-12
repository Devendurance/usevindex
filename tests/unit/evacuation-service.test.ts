// M6 pre-execution validator tests: authorization, allowlist/destination/
// position checks, parameters hash, idempotency, simulation gates, fail-closed
// paths, and the no-broadcast invariant. Isolated test DB; chain/KeeperHub
// interaction faked — no network, no real transactions.

import { describe, expect, it, afterAll, beforeAll } from "vitest";
import { eq } from "drizzle-orm";

import { executions, signalObservations, simulations, threatDecisions } from "../../db/schema";
import {
  prepareEvacuation,
  exitParametersHash,
} from "../../lib/vindex/evacuation-service";
import { armPolicy, disarmPolicy } from "../../lib/vindex/policy-service";
import { setSafeWalletConfig } from "../../lib/vindex/safe-wallet";
import type { ContractCallSimulation, KeeperHubClient, KeeperHubWallet } from "../../lib/vindex/keeperhub";
import type { CanonicalReadClient } from "../../lib/vindex/public-client";
import type { VindexEnv } from "../../lib/vindex/env";
import { closeTestDb, getTestDb } from "./helpers/test-db";

const ENV: VindexEnv = {
  baseSepoliaRpcUrl: "https://sepolia.base.org",
  keeperhubApiKey: "kh_test_key_123456",
  keeperhubApiBaseUrl: "https://app.keeperhub.com",
};

const WALLET = "0x675638ddbbf8b70b906d68e3485da72c6c63d130";
const POOL = "0x8bAB6d1b75f19e9eD9fCe8b9BD338844fF79aE27";
const ATK = "0x10F1A9D11CDf50041f3f8cB7191CBE2f31750ACC";
const SAFE_WALLET = "0x2222222222222222222222222222222222222222";
const POSITION_ID = `base-sepolia:aave-v3:usdc:${WALLET.toLowerCase()}`;
const MAX_UINT = (BigInt(2) ** BigInt(256) - BigInt(1)).toString();

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

function createFakeKeeperHub(
  simulation?: Partial<ContractCallSimulation>,
): KeeperHubClient {
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
    simulateContractCall: async (): Promise<ContractCallSimulation> => ({
      httpStatus: 200,
      success: true,
      status: "simulated",
      from: WALLET,
      to: POOL,
      value: "0",
      gasEstimate: "183705",
      simulatedReturnValue: "5000077",
      wouldRevert: false,
      revertReason: null,
      error: null,
      idempotentReplay: null,
      ...simulation,
    }),
  } as unknown as KeeperHubClient;
  return client;
}

function createFakeRpc(aUsdc = BigInt(5000077)): CanonicalReadClient {
  const client = {
    getChainId: async () => 84532,
    getBlockNumber: async () => BigInt(45392404),
    getBalance: async () => BigInt("20000000000000000"),
    getBytecode: async () => "0x1234" as `0x${string}`,
    readContract: async (args: { address: string; functionName: string }): Promise<unknown> => {
      if (args.functionName === "balanceOf") {
        if (args.address.toLowerCase() === ATK.toLowerCase()) return aUsdc;
        return BigInt(0);
      }
      if (args.functionName === "allowance") return BigInt(0);
      if (args.functionName === "decimals") return BigInt(6);
      if (args.functionName === "symbol") return "USDC";
      if (args.functionName === "getReserveConfigurationData") {
        return [BigInt(6), BigInt(8250), BigInt(8600), BigInt(0), BigInt(2000), true, true, false, true, false];
      }
      if (args.functionName === "getReserveTokensAddresses") {
        return [ATK, `0x${"33".repeat(20)}`, `0x${"44".repeat(20)}`];
      }
      if (args.functionName === "getPool") return POOL;
      throw new Error(`Unexpected readContract call: ${args.functionName}`);
    },
    getTransactionReceipt: async () => {
      throw new Error("unexpected receipt read");
    },
    getBlock: async () => ({ timestamp: BigInt(Math.floor(Date.now() / 1000)) }),
  } as unknown as CanonicalReadClient;
  return client;
}

const seedConfirmedDecision = async (
  policyId: string,
  policyVersion: number,
  overrides: Partial<typeof threatDecisions.$inferInsert> = {},
): Promise<string> => {
  const inserted = await db
    .insert(threatDecisions)
    .values({
      positionId: POSITION_ID,
      policyId,
      policyVersion,
      state: "CONFIRMING",
      matchedCount: 2,
      contributingSignalIds: "[]",
      matchedFamiliesJson: '["ORACLE_PRICE_STATE","AAVE_RESERVE_STATE"]',
      reasonJson: "{}",
      windowStartedAt: now(),
      confirmedAt: now(),
      expiresAt: new Date(now().getTime() + 3600 * 1000),
      ...overrides,
    })
    .returning({ id: threatDecisions.id });
  return inserted[0].id;
};

const armDrill = async () => {
  await disarmPolicy(db, POSITION_ID);
  await setSafeWalletConfig(db, SAFE_WALLET);
  return armPolicy({
    env: ENV,
    db,
    positionId: POSITION_ID,
    mode: "DRILL_HIGH_SENSITIVITY",
    publicClient: createFakeRpc(),
    keeperHubClient: createFakeKeeperHub(),
    now,
  });
};

beforeAll(async () => {
  if (!dbAvailable) return;
  db = await getTestDb();
  await db.delete(executions);
  await db.delete(simulations);
  await db.delete(threatDecisions);
  await db.delete(signalObservations);
  await setSafeWalletConfig(db, SAFE_WALLET);
  // Two LIVE families so the arm gate (>= 2) passes.
  const recent = new Date();
  await db.insert(signalObservations).values({
    positionId: POSITION_ID,
    chainId: 84532,
    protocol: "Aave V3",
    sourceFamily: "ORACLE_PRICE_STATE",
    metric: "AAVE_USDC_ORACLE_PRICE",
    rawValue: "99979128",
    normalizedValue: "99979128",
    severity: null,
    contractAddress: "0x943b0dE18d4abf4eF02A85912F8fc07684C141dF",
    blockNumber: "1",
    blockTimestamp: recent,
    observedAt: recent,
    rpcSource: "Base Sepolia",
    metadataJson: "{}",
  });
  await db.insert(signalObservations).values({
    positionId: POSITION_ID,
    chainId: 84532,
    protocol: "Aave V3",
    sourceFamily: "AAVE_RESERVE_STATE",
    metric: "AAVE_RESERVE_TOTAL_VARIABLE_DEBT",
    rawValue: "6154634874505",
    normalizedValue: "6154634874505",
    severity: null,
    contractAddress: "0xba50Cd2A20f6DA35D788639E581bca8d0B5d4D5f",
    blockNumber: "1",
    blockTimestamp: recent,
    observedAt: recent,
    rpcSource: "Base Sepolia",
    metadataJson: "{}",
  });
});

afterAll(async () => {
  await closeTestDb();
});

const prepare = (decisionId: string, simulation?: Partial<ContractCallSimulation>, aUsdc?: bigint) =>
  prepareEvacuation({
    env: ENV,
    db,
    decisionId,
    keeperHubClient: createFakeKeeperHub(simulation),
    publicClient: createFakeRpc(aUsdc),
    now,
  });

describe("authorization gates", () => {
  it.skipIf(!dbAvailable)("rejects a decision that does not exist", async () => {
    await expect(prepare("00000000-0000-0000-0000-000000000000")).rejects.toMatchObject({
      code: "BAD_REQUEST",
    });
  });

  it.skipIf(!dbAvailable)("rejects when the policy is disarmed", async () => {
    now = () => new Date("2026-08-12T12:00:00.000Z");
    const policy = await armDrill();
    await disarmPolicy(db, POSITION_ID);
    const decisionId = await seedConfirmedDecision(policy.id, policy.version);
    await expect(prepare(decisionId)).rejects.toMatchObject({
      code: "POLICY_ARMED_RECONFIGURE_REQUIRED",
    });
  });

  it.skipIf(!dbAvailable)("rejects an unconfirmed decision", async () => {
    now = () => new Date("2026-08-12T12:00:00.000Z");
    const policy = await armDrill();
    const decisionId = await seedConfirmedDecision(policy.id, policy.version, { state: "ELEVATED", confirmedAt: null });
    await expect(prepare(decisionId)).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it.skipIf(!dbAvailable)("rejects an expired decision", async () => {
    now = () => new Date("2026-08-12T12:00:00.000Z");
    const policy = await armDrill();
    const decisionId = await seedConfirmedDecision(policy.id, policy.version, {
      expiresAt: new Date(now().getTime() - 1000),
    });
    await expect(prepare(decisionId)).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it.skipIf(!dbAvailable)("rejects a decision from a different policy version", async () => {
    now = () => new Date("2026-08-12T12:00:00.000Z");
    const policy = await armDrill();
    const decisionId = await seedConfirmedDecision(policy.id, policy.version + 5);
    await expect(prepare(decisionId)).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });
});

describe("validation checks", () => {
  it.skipIf(!dbAvailable)("rejects when the safe wallet was changed after confirmation", async () => {
    now = () => new Date("2026-08-12T12:00:00.000Z");
    const policy = await armDrill();
    const decisionId = await seedConfirmedDecision(policy.id, policy.version);
    await setSafeWalletConfig(db, "0x3333333333333333333333333333333333333333");
    await expect(prepare(decisionId)).rejects.toMatchObject({ code: "INVALID_SAFE_WALLET" });
  });

  it.skipIf(!dbAvailable)("rejects a zero position", async () => {
    now = () => new Date("2026-08-12T12:00:00.000Z");
    const policy = await armDrill();
    const decisionId = await seedConfirmedDecision(policy.id, policy.version);
    await expect(prepare(decisionId, undefined, BigInt(0))).rejects.toMatchObject({ code: "POSITION_ZERO" });
  });
});

describe("simulation gates", () => {
  const happy = async () => {
    now = () => new Date("2026-08-12T12:00:00.000Z");
    const policy = await armDrill();
    return seedConfirmedDecision(policy.id, policy.version);
  };

  it.skipIf(!dbAvailable)("a would-revert simulation produces BLOCKED without broadcast", async () => {
    const decisionId = await happy();
    const view = await prepare(decisionId, {
      success: false,
      wouldRevert: true,
      revertReason: "Error(INSUFFICIENT_AVAILABLE_BALANCE)",
    });
    expect(view.state).toBe("BLOCKED");
    expect(view.readyForExecution).toBe(false);
    const row = (await db.select().from(executions).where(eq(executions.decisionId, decisionId)))[0];
    expect(row?.txHash).toBeNull();
    expect(row?.keeperhubExecutionId).toBeNull();
  });

  it.skipIf(!dbAvailable)("a simulation sender mismatch is rejected", async () => {
    const decisionId = await happy();
    const view = await prepare(decisionId, { from: `0x${"99".repeat(20)}` });
    expect(view.state).toBe("BLOCKED");
    expect(view.readyForExecution).toBe(false);
  });

  it.skipIf(!dbAvailable)("a simulation target mismatch is rejected", async () => {
    const decisionId = await happy();
    const view = await prepare(decisionId, { to: `0x${"88".repeat(20)}` });
    expect(view.state).toBe("BLOCKED");
    expect(view.readyForExecution).toBe(false);
  });

  it.skipIf(!dbAvailable)("a missing gas estimate is rejected", async () => {
    const decisionId = await happy();
    const view = await prepare(decisionId, { gasEstimate: null });
    expect(view.state).toBe("BLOCKED");
    expect(view.readyForExecution).toBe(false);
  });

  it.skipIf(!dbAvailable)("a successful simulation yields readyForExecution with no broadcast metadata", async () => {
    const decisionId = await happy();
    const view = await prepare(decisionId);
    expect(view.state).toBe("SIMULATION_PASSED");
    expect(view.readyForExecution).toBe(true);
    expect(view.expectedWithdrawAmount).toBe("5000077");
    expect(view.gasEstimate).toBe("183705");
    expect(view.amountMode).toBe("FULL_POSITION");
    expect(view.amountBaseUnits).toBe(MAX_UINT);
    expect(view.safeWallet).toBe(SAFE_WALLET);
    const row = (await db.select().from(executions).where(eq(executions.decisionId, decisionId)))[0];
    expect(row?.txHash).toBeNull();
    expect(row?.keeperhubExecutionId).toBeNull();
    expect(row?.submittedAt).toBeNull();
    const sim = (await db.select().from(simulations).where(eq(simulations.decisionId, decisionId)))[0];
    expect(sim?.success).toBe(true);
    expect(sim?.wouldRevert).toBe(false);
    expect(sim?.simulatedReturnValue).toBe("5000077");
  });
});

describe("idempotency and parameters", () => {
  it.skipIf(!dbAvailable)("re-preparing the same decision reuses the existing preparation", async () => {
    now = () => new Date("2026-08-12T12:00:00.000Z");
    const policy = await armDrill();
    const decisionId = await seedConfirmedDecision(policy.id, policy.version);
    const first = await prepare(decisionId);
    const rowsBefore = (await db.select().from(executions).where(eq(executions.decisionId, decisionId))).length;
    const second = await prepare(decisionId);
    const rowsAfter = (await db.select().from(executions).where(eq(executions.decisionId, decisionId))).length;
    expect(second.executionId).toBe(first.executionId);
    expect(second.readyForExecution).toBe(true);
    expect(rowsAfter).toBe(rowsBefore);
  });

  it.skipIf(!dbAvailable)("the parameters hash is deterministic and canonical", () => {
    const base = {
      chainId: 84532,
      pool: POOL,
      asset: "0xba50Cd2A20f6DA35D788639E581bca8d0B5d4D5f",
      amount: MAX_UINT,
      safeWallet: SAFE_WALLET,
      decisionId: "d1",
      policyVersion: 1,
    };
    expect(exitParametersHash(base)).toBe(exitParametersHash(base));
    expect(exitParametersHash(base)).not.toBe(
      exitParametersHash({ ...base, safeWallet: "0x3333333333333333333333333333333333333333" }),
    );
    expect(exitParametersHash(base)).not.toBe(
      exitParametersHash({ ...base, policyVersion: 2 }),
    );
    expect(exitParametersHash(base)).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("boundaries", () => {
  it("the evacuation service cannot broadcast or write onchain", async () => {
    const source = await import("fs/promises").then((fs) =>
      fs.readFile("lib/vindex/evacuation-service.ts", "utf8"),
    );
    expect(source).not.toContain("executeContractCall");
    expect(source).not.toContain("walletClient");
    expect(source).toContain("simulateContractCall");
  });

  it("the M5 artifact cannot authorize preparation (service reads no artifacts)", async () => {
    const source = await import("fs/promises").then((fs) =>
      fs.readFile("lib/vindex/evacuation-service.ts", "utf8"),
    );
    expect(source).not.toContain("m5-consensus");
    expect(source).not.toContain("m6-simulation");
    expect(source).not.toContain("artifacts/");
  });

  it("views contain no secrets", async () => {
    now = () => new Date("2026-08-12T12:00:00.000Z");
    const policy = await armDrill();
    const decisionId = await seedConfirmedDecision(policy.id, policy.version);
    const view = await prepare(decisionId);
    const serialized = JSON.stringify(view);
    expect(serialized).not.toContain("kh_test_key_123456");
    expect(serialized.toLowerCase()).not.toContain("authorization");
  });
});
