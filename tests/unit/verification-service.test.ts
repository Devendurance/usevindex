// M8 destination verification tests: execution gating, reconciliation rules,
// receipt idempotency/concurrency, drill labeling, and the zero-write
// invariant. Isolated test DB; chain reads faked — no network, no writes.

import { describe, expect, it, afterAll, beforeAll } from "vitest";
import { eq } from "drizzle-orm";

import {
  auditEvents,
  executions,
  rescueReceipts,
  signalObservations,
  simulations,
  threatDecisions,
  verificationChecks,
} from "../../db/schema";
import {
  verifyEvacuationDestination,
  getRescueReceipt,
} from "../../lib/vindex/verification-service";
import { armPolicy, disarmPolicy } from "../../lib/vindex/policy-service";
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
const USDC = "0xba50Cd2A20f6DA35D788639E581bca8d0B5d4D5f";
const ATK = "0x10F1A9D11CDf50041f3f8cB7191CBE2f31750ACC";
const SAFE_WALLET = "0x2222222222222222222222222222222222222222";
const POSITION_ID = `base-sepolia:aave-v3:usdc:${WALLET.toLowerCase()}`;
const TX = `0x${"ab".repeat(32)}`;

const dbAvailable = Boolean(process.env.DATABASE_URL?.trim());
let db: Awaited<ReturnType<typeof getTestDb>>;
let now: () => Date;

function createFakeKeeperHub(): KeeperHubClient {
  const wallet: KeeperHubWallet = {
    hasWallet: true,
    walletAddress: WALLET,
    walletId: "wal_1",
    isActive: true,
    invalidAddress: false,
    error: null,
  };
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

function createFakeRpc(config: { safeUsdc?: bigint; walletAUsdc?: bigint; receiptStatus?: "success" | "reverted" } = {}): CanonicalReadClient {
  const client = {
    getChainId: async () => 84532,
    getBlockNumber: async () => BigInt(45400000),
    getBalance: async () => BigInt(0),
    getBytecode: async () => "0x1234" as `0x${string}`,
    readContract: async (args: { address: string; functionName: string; args?: string[] }): Promise<unknown> => {
      const owner = (args.args ?? [])[0] ?? "";
      if (args.functionName === "balanceOf") {
        if (args.address.toLowerCase() === USDC.toLowerCase() && owner.toLowerCase() === SAFE_WALLET.toLowerCase()) {
          return config.safeUsdc ?? BigInt(5000123);
        }
        if (args.address.toLowerCase() === ATK.toLowerCase() && owner.toLowerCase() === WALLET.toLowerCase()) {
          return config.walletAUsdc ?? BigInt(0);
        }
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
      if (args.functionName === "getPool") return "0x8bAB6d1b75f19e9eD9fCe8b9BD338844fF79aE27";
      throw new Error(`Unexpected readContract call: ${args.functionName}`);
    },
    getTransactionReceipt: async () => ({
      status: config.receiptStatus ?? "success",
      from: `0x${"99".repeat(20)}`,
      to: `0x${"88".repeat(20)}`,
      blockNumber: BigInt(45399100),
      logs: [],
    }),
    getBlock: async () => ({ timestamp: BigInt(Math.floor(Date.now() / 1000)) }),
  } as unknown as CanonicalReadClient;
  return client;
}

const seedM7Execution = async (
  overrides: Partial<typeof executions.$inferInsert> = {},
  withdrawAmount = "5000123",
): Promise<string> => {
  await disarmPolicy(db, POSITION_ID);
  await setSafeWalletConfig(db, SAFE_WALLET);
  await db.delete(signalObservations);
  const recent = new Date();
  await db.insert(signalObservations).values([
    {
      positionId: POSITION_ID, chainId: 84532, protocol: "Aave V3",
      sourceFamily: "ORACLE_PRICE_STATE", metric: "AAVE_USDC_ORACLE_PRICE",
      rawValue: "99979128", normalizedValue: "99979128", severity: null,
      contractAddress: "0x943b0dE18d4abf4eF02A85912F8fc07684C141dF", blockNumber: "1",
      blockTimestamp: recent, observedAt: recent, rpcSource: "Base Sepolia", metadataJson: "{}",
    },
    {
      positionId: POSITION_ID, chainId: 84532, protocol: "Aave V3",
      sourceFamily: "AAVE_RESERVE_STATE", metric: "AAVE_RESERVE_TOTAL_VARIABLE_DEBT",
      rawValue: "6154634874505", normalizedValue: "6154634874505", severity: null,
      contractAddress: USDC, blockNumber: "1",
      blockTimestamp: recent, observedAt: recent, rpcSource: "Base Sepolia", metadataJson: "{}",
    },
  ]);
  const policy = await armPolicy({
    env: ENV, db, positionId: POSITION_ID, mode: "DRILL_HIGH_SENSITIVITY",
    publicClient: createFakeRpc({ walletAUsdc: BigInt(5000123) }), keeperHubClient: createFakeKeeperHub(), now,
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
      windowStartedAt: now(),
      confirmedAt: now(),
      expiresAt: new Date(now().getTime() + 3600 * 1000),
    })
    .returning({ id: threatDecisions.id });
  const decisionId = decisionRows[0].id;

  const execRows = await db
    .insert(executions)
    .values({
      decisionId,
      status: "EXECUTED_VERIFYING_DESTINATION",
      chainId: 84532,
      target: "0x8bAB6d1b75f19e9eD9fCe8b9BD338844fF79aE27",
      function: "withdraw",
      parametersHash: "a".repeat(64),
      requestedAmount: (BigInt(2) ** BigInt(256) - BigInt(1)).toString(),
      safeWallet: SAFE_WALLET,
      keeperhubExecutionId: "direct_m7_1",
      txHash: TX,
      transactionLink: `https://sepolia.basescan.org/tx/${TX}`,
      sponsored: true,
      prePositionAmount: "5000123",
      preSafeWalletBalance: "0",
      preBlockNumber: "45399096",
      lastKeeperHubStatus: "completed",
      ...overrides,
    })
    .returning({ id: executions.id });
  const executionId = execRows[0].id;

  // The M7 Withdraw audit evidence the service derives the actual amount from.
  await db.insert(auditEvents).values({
    positionId: POSITION_ID,
    decisionId,
    eventType: "WITHDRAW_EVENT_VERIFIED",
    detailsJson: JSON.stringify({
      executionId,
      transactionHash: TX,
      actualWithdrawAmount: withdrawAmount,
    }),
    blockNumber: "45399100",
  });
  return executionId;
};

beforeAll(async () => {
  if (!dbAvailable) return;
  db = await getTestDb();
  await db.delete(rescueReceipts);
  await db.delete(verificationChecks);
  await db.delete(auditEvents);
  await db.delete(executions);
  await db.delete(simulations);
  await db.delete(threatDecisions);
  await db.delete(signalObservations);
  await setSafeWalletConfig(db, SAFE_WALLET);
});

afterAll(async () => {
  await closeTestDb();
});

const verify = (executionId: string, config: Parameters<typeof createFakeRpc>[0] = {}) =>
  verifyEvacuationDestination({
    env: ENV,
    db,
    executionId,
    publicClient: createFakeRpc(config),
    now,
  });

const interventionOf = (result: Awaited<ReturnType<typeof verify>>) => {
  if (result.outcome !== "INTERVENTION_REQUIRED") throw new Error("expected INTERVENTION_REQUIRED");
  return result;
};

const verifiedOf = (result: Awaited<ReturnType<typeof verify>>) => {
  if (result.outcome !== "VERIFIED") throw new Error("expected VERIFIED");
  return result;
};

describe("execution gating", () => {
  it.skipIf(!dbAvailable)("rejects a non-M7 execution", async () => {
    now = () => new Date("2026-08-12T12:00:00.000Z");
    const executionId = await seedM7Execution({ status: "SIMULATION_PASSED" });
    await expect(verify(executionId)).rejects.toBeTruthy();
  });

  it.skipIf(!dbAvailable)("rejects a missing pre-balance", async () => {
    now = () => new Date("2026-08-12T12:00:00.000Z");
    const executionId = await seedM7Execution({ preSafeWalletBalance: null });
    await expect(verify(executionId)).rejects.toBeTruthy();
  });

  it.skipIf(!dbAvailable)("rejects an invalid persisted destination", async () => {
    now = () => new Date("2026-08-12T12:00:00.000Z");
    const executionId = await seedM7Execution({ safeWallet: "0x0000000000000000000000000000000000000000" });
    await expect(verify(executionId)).rejects.toBeTruthy();
  });
});

describe("reconciliation", () => {
  it.skipIf(!dbAvailable)("post < pre fails with INTERVENTION_REQUIRED", async () => {
    now = () => new Date("2026-08-12T12:00:00.000Z");
    const executionId = await seedM7Execution({ preSafeWalletBalance: "1000" });
    const result = interventionOf(await verify(executionId, { safeUsdc: BigInt(500) }));
    expect(result.verified).toBe(false);
    const receipts = await db.select().from(rescueReceipts).where(eq(rescueReceipts.executionId, executionId));
    expect(receipts).toHaveLength(0);
    const exec = (await db.select().from(executions).where(eq(executions.id, executionId)))[0];
    expect(exec?.status).toBe("INTERVENTION_REQUIRED");
  });

  it.skipIf(!dbAvailable)("zero delta fails with INTERVENTION_REQUIRED", async () => {
    now = () => new Date("2026-08-12T12:00:00.000Z");
    const executionId = await seedM7Execution();
    const result = interventionOf(await verify(executionId, { safeUsdc: BigInt(0) }));
    expect(result.failureReason).toContain("did not increase");
  });

  it.skipIf(!dbAvailable)("delta mismatch fails with INTERVENTION_REQUIRED", async () => {
    now = () => new Date("2026-08-12T12:00:00.000Z");
    const executionId = await seedM7Execution();
    const result = interventionOf(await verify(executionId, { safeUsdc: BigInt(4999123) }));
    expect(result.failureReason).toContain("does not equal");
    const receipts = await db.select().from(rescueReceipts).where(eq(rescueReceipts.executionId, executionId));
    expect(receipts).toHaveLength(0);
  });

  it.skipIf(!dbAvailable)("residual aUSDC beyond dust fails verification", async () => {
    now = () => new Date("2026-08-12T12:00:00.000Z");
    const executionId = await seedM7Execution();
    const result = interventionOf(await verify(executionId, { safeUsdc: BigInt(5000123), walletAUsdc: BigInt(5000) }));
    expect(result.failureReason).toContain("residual");
  });
});

describe("success path", () => {
  it.skipIf(!dbAvailable)("an exact delta match creates the receipt and sets PROTECTED", async () => {
    now = () => new Date("2026-08-12T12:00:00.000Z");
    const executionId = await seedM7Execution();
    const result = verifiedOf(await verify(executionId));
    expect(result.verified).toBe(true);
    expect(result.delta).toBe("5000123");
    expect(result.expectedAmount).toBe("5000123");
    expect(result.receipt.status).toBe("PROTECTED");
    expect(result.receipt.verifiedAmount).toBe("5000123");
    expect(result.receipt.destination).toBe(SAFE_WALLET);
    expect(result.receipt.policyMode).toBe("DRILL_HIGH_SENSITIVITY");
    expect(result.receipt.receipt.drillLabel).toContain("PROTECTION DRILL");
    expect(result.receipt.receipt.withdrawn).toBe("5000123");
    expect(result.receipt.receipt.verifiedReceived).toBe("5000123");
    const exec = (await db.select().from(executions).where(eq(executions.id, executionId)))[0];
    expect(exec?.status).toBe("PROTECTED");
    const checks = await db.select().from(verificationChecks).where(eq(verificationChecks.executionId, executionId));
    expect(checks).toHaveLength(1);
    expect(checks[0]?.verified).toBe(true);
    const receipts = await db.select().from(rescueReceipts).where(eq(rescueReceipts.executionId, executionId));
    expect(receipts).toHaveLength(1);
  });

  it.skipIf(!dbAvailable)("a prior safe-wallet balance is handled using delta, not absolute final balance", async () => {
    // The safe wallet already holds the first rescue's 5,000,123 USDC. The M10
    // evacuation adds ~5,000,000 more. Verification must reconcile the DELTA
    // against the Withdraw amount, never the absolute final balance.
    now = () => new Date("2026-08-12T12:00:00.000Z");
    const executionId = await seedM7Execution({ preSafeWalletBalance: "5000123", prePositionAmount: "5000023" }, "5000023");
    const result = verifiedOf(await verify(executionId, { safeUsdc: BigInt(10000146) }));
    expect(result.delta).toBe("5000023");
    expect(result.expectedAmount).toBe("5000023");
    expect(result.outcome).toBe("VERIFIED");
  });

  it.skipIf(!dbAvailable)("a receipt is only created after verification passes", async () => {
    now = () => new Date("2026-08-12T12:00:00.000Z");
    const executionId = await seedM7Execution();
    await verify(executionId, { safeUsdc: BigInt(0) });
    const receipts = await db.select().from(rescueReceipts).where(eq(rescueReceipts.executionId, executionId));
    expect(receipts).toHaveLength(0);
    const checks = await db.select().from(verificationChecks).where(eq(verificationChecks.executionId, executionId));
    expect(checks[0]?.verified).toBe(false);
  });
});

describe("idempotency and concurrency", () => {
  it.skipIf(!dbAvailable)("a duplicate verification returns the same receipt", async () => {
    now = () => new Date("2026-08-12T12:00:00.000Z");
    const executionId = await seedM7Execution();
    const first = verifiedOf(await verify(executionId));
    const second = verifiedOf(await verify(executionId));
    expect(second.receipt.id).toBe(first.receipt.id);
    const receipts = await db.select().from(rescueReceipts).where(eq(rescueReceipts.executionId, executionId));
    expect(receipts).toHaveLength(1);
  });

  it.skipIf(!dbAvailable)("concurrent verification calls create a single receipt", async () => {
    now = () => new Date("2026-08-12T12:00:00.000Z");
    const executionId = await seedM7Execution();
    const [a, b] = await Promise.all([verify(executionId), verify(executionId)]);
    const ids = [a, b].filter((r): r is Extract<typeof r, { outcome: "VERIFIED" }> => r.outcome === "VERIFIED").map((r) => r.receipt.id);
    expect(new Set(ids).size).toBe(1);
    const receipts = await db.select().from(rescueReceipts).where(eq(rescueReceipts.executionId, executionId));
    expect(receipts).toHaveLength(1);
  });

  it.skipIf(!dbAvailable)("the receipt queries back identically", async () => {
    now = () => new Date("2026-08-12T12:00:00.000Z");
    const executionId = await seedM7Execution();
    const result = verifiedOf(await verify(executionId));
    const queried = await getRescueReceipt(db, result.receipt.id);
    expect(queried?.id).toBe(result.receipt.id);
    expect(queried?.verifiedAmount).toBe("5000123");
  });
});

describe("boundaries", () => {
  it("the verification service has no KeeperHub or onchain write capability", async () => {
    const source = await import("fs/promises").then((fs) =>
      fs.readFile("lib/vindex/verification-service.ts", "utf8"),
    );
    expect(source).not.toContain("executeContractCall");
    expect(source).not.toContain("walletClient");
  });

  it("bigint amounts serialize losslessly as decimal strings", async () => {
    now = () => new Date("2026-08-12T12:00:00.000Z");
    const executionId = await seedM7Execution({ preSafeWalletBalance: "0" });
    const result = verifiedOf(await verify(executionId));
    const serialized = JSON.stringify(result.receipt.receipt);
    expect(serialized).toContain('"verifiedReceived":"5000123"');
    for (const field of ["withdrawn", "verifiedReceived", "expectedWithdraw"]) {
      const value = result.receipt.receipt[field as keyof typeof result.receipt.receipt];
      if (typeof value === "string") {
        expect(value).toMatch(/^\d+$/);
      }
    }
  });

  it("views contain no secrets and never claim a real exploit", async () => {
    now = () => new Date("2026-08-12T12:00:00.000Z");
    const executionId = await seedM7Execution();
    const result = verifiedOf(await verify(executionId));
    const serialized = JSON.stringify(result.receipt.receipt);
    expect(serialized).not.toContain("kh_test_key_123456");
    expect(serialized.toLowerCase()).not.toContain("authorization");
    expect(serialized).not.toContain("Aave is being hacked");
    expect(result.receipt.receipt.drillExplanation).toContain("not evidence of an Aave exploit");
  });
});
