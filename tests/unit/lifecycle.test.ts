// D1 task 1: post-PROTECTED lifecycle settlement. After a protection event
// reaches PROTECTED the armed policy is settled (disarmed) so a future
// protection session starts clean, while every historical row stays
// immutable. Isolated test DB; chain reads faked — no network, no real
// KeeperHub or onchain writes.

import { describe, expect, it, afterAll, beforeAll } from "vitest";
import { eq } from "drizzle-orm";

import {
  auditEvents,
  executions,
  protectionPolicies,
  rescueReceipts,
  signalObservations,
  threatDecisions,
  verificationChecks,
} from "../../db/schema";
import { verifyEvacuationDestination } from "../../lib/vindex/verification-service";
import {
  armPolicy,
  assertSafeWalletChangeAllowed,
  disarmPolicy,
  getArmedPolicy,
  getAuditEvents,
  isPolicyArmed,
  settleCompletedProtection,
} from "../../lib/vindex/policy-service";
import { getSafeWalletConfig, setSafeWalletConfig } from "../../lib/vindex/safe-wallet";
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
const NEXT_SAFE_WALLET = "0x3333333333333333333333333333333333333333";
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

// Arms a DRILL policy, creates a live CONFIRMING decision, and persists an M7
// execution in EXECUTED_VERIFYING_DESTINATION with its Withdraw evidence —
// the exact preconditions a real PROTECTED transition needs.
const seedProtectedSession = async (): Promise<{
  executionId: string;
  policyId: string;
  decisionId: string;
  policyVersion: number;
}> => {
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
      actualWithdrawAmount: "5000123",
    }),
    blockNumber: "45399100",
  });
  return { executionId, policyId: policy.id, decisionId, policyVersion: policy.version };
};

beforeAll(async () => {
  if (!dbAvailable) return;
  db = await getTestDb();
  await db.delete(rescueReceipts);
  await db.delete(verificationChecks);
  await db.delete(auditEvents);
  await db.delete(executions);
  await db.delete(threatDecisions);
  await db.delete(protectionPolicies);
  await db.delete(signalObservations);
  await setSafeWalletConfig(db, SAFE_WALLET);
});

afterAll(async () => {
  await closeTestDb();
});

const verify = (executionId: string) =>
  verifyEvacuationDestination({
    env: ENV,
    db,
    executionId,
    publicClient: createFakeRpc(),
    now,
  });

const auditTypes = async () =>
  (await getAuditEvents(db, POSITION_ID, 200)).map((e) => e.eventType);

describe("post-PROTECTED lifecycle settlement", () => {
  it.skipIf(!dbAvailable)("PROTECTED history does not make the current setup claim armed", async () => {
    now = () => new Date("2026-08-12T12:00:00.000Z");
    const seeded = await seedProtectedSession();
    const result = await verify(seeded.executionId);
    expect(result.outcome).toBe("VERIFIED");
    expect(await isPolicyArmed(db, POSITION_ID)).toBe(false);
    expect(await getArmedPolicy(db, POSITION_ID)).toBeNull();
  });

  it.skipIf(!dbAvailable)("a settled policy does not block a new setup", async () => {
    now = () => new Date("2026-08-12T12:00:00.000Z");
    const seeded = await seedProtectedSession();
    const result = await verify(seeded.executionId);
    expect(result.outcome).toBe("VERIFIED");

    // After settlement the safe-wallet PUT is allowed again.
    await expect(assertSafeWalletChangeAllowed(db, POSITION_ID)).resolves.toBeUndefined();
    await setSafeWalletConfig(db, NEXT_SAFE_WALLET);
    expect((await getSafeWalletConfig(db)).safeWallet).toBe(NEXT_SAFE_WALLET);

    // A fresh arm succeeds with a new policy version.
    const rearmed = await armPolicy({
      env: ENV, db, positionId: POSITION_ID, mode: "DRILL_HIGH_SENSITIVITY",
      publicClient: createFakeRpc({ walletAUsdc: BigInt(5000123) }), keeperHubClient: createFakeKeeperHub(), now,
    });
    expect(rearmed.id).not.toBe(seeded.policyId);
    expect(rearmed.version).toBe(seeded.policyVersion + 1);
    expect(rearmed.isArmed).toBe(true);

    // The settled history row is untouched.
    const oldRow = (await db
      .select()
      .from(protectionPolicies)
      .where(eq(protectionPolicies.id, seeded.policyId)))[0];
    expect(oldRow?.isArmed).toBe(false);
    expect(oldRow?.disarmedAt).not.toBeNull();
  });

  it.skipIf(!dbAvailable)("settle is idempotent and appends no duplicate audits", async () => {
    now = () => new Date("2026-08-12T12:00:00.000Z");
    await disarmPolicy(db, POSITION_ID);
    await setSafeWalletConfig(db, SAFE_WALLET);
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
        matchedFamiliesJson: "[]",
        reasonJson: "{}",
        windowStartedAt: now(),
        confirmedAt: now(),
        expiresAt: new Date(now().getTime() + 3600 * 1000),
      })
      .returning({ id: threatDecisions.id });
    const decisionId = decisionRows[0].id;

    const before = await auditTypes();
    const countBefore = (type: string) => before.filter((t) => t === type).length;
    const first = await settleCompletedProtection(db, POSITION_ID, now);
    expect(first.alreadyDisarmed).toBe(false);
    const mid = await auditTypes();
    expect(mid.filter((t) => t === "POLICY_DISARMED")).toHaveLength(countBefore("POLICY_DISARMED") + 1);
    expect(mid.filter((t) => t === "DECISION_RESOLVED")).toHaveLength(countBefore("DECISION_RESOLVED") + 1);

    // The resolution audit documents the snapshot state and links the row.
    const resolvedRows = await db
      .select()
      .from(auditEvents)
      .where(eq(auditEvents.eventType, "DECISION_RESOLVED"));
    const resolved = resolvedRows.find((row) => row.decisionId === decisionId);
    expect(resolved).toBeDefined();
    expect(resolved?.positionId).toBe(POSITION_ID);
    expect((JSON.parse(resolved?.detailsJson ?? "{}") as { state?: string }).state).toBe("CONFIRMING");

    const second = await settleCompletedProtection(db, POSITION_ID, now);
    expect(second.alreadyDisarmed).toBe(true);
    const after = await auditTypes();
    expect(after).toHaveLength(mid.length);
    expect(after.filter((t) => t === "POLICY_DISARMED")).toHaveLength(countBefore("POLICY_DISARMED") + 1);
    expect(after.filter((t) => t === "DECISION_RESOLVED")).toHaveLength(countBefore("DECISION_RESOLVED") + 1);
  });

  it.skipIf(!dbAvailable)("concurrent settles append a single settlement audit set", async () => {
    now = () => new Date("2026-08-12T12:00:00.000Z");
    const seeded = await seedProtectedSession();
    const before = await auditTypes();
    const countBefore = (type: string) => before.filter((t) => t === type).length;

    const [a, b] = await Promise.all([
      settleCompletedProtection(db, POSITION_ID, now),
      settleCompletedProtection(db, POSITION_ID, now),
    ]);
    // Exactly one call wins the disarm; the loser is a no-op.
    expect([a, b].filter((r) => r.alreadyDisarmed === false)).toHaveLength(1);
    expect([a, b].filter((r) => r.alreadyDisarmed === true)).toHaveLength(1);

    const after = await auditTypes();
    expect(after.filter((t) => t === "POLICY_DISARMED")).toHaveLength(countBefore("POLICY_DISARMED") + 1);
    expect(after.filter((t) => t === "DECISION_RESOLVED")).toHaveLength(countBefore("DECISION_RESOLVED") + 1);
    const resolvedRows = await db
      .select()
      .from(auditEvents)
      .where(eq(auditEvents.eventType, "DECISION_RESOLVED"));
    expect(resolvedRows.filter((row) => row.decisionId === seeded.decisionId)).toHaveLength(1);
  });

  it.skipIf(!dbAvailable)("settle preserves every historical row", async () => {
    now = () => new Date("2026-08-12T12:00:00.000Z");
    const before = await auditTypes();
    const countBefore = (type: string) => before.filter((t) => t === type).length;
    const seeded = await seedProtectedSession();
    const result = await verify(seeded.executionId);
    expect(result.outcome).toBe("VERIFIED");

    // A second settle after the in-verify settle must be a no-op.
    const settled = await settleCompletedProtection(db, POSITION_ID, now);
    expect(settled.alreadyDisarmed).toBe(true);

    const policyRows = await db
      .select()
      .from(protectionPolicies)
      .where(eq(protectionPolicies.id, seeded.policyId));
    expect(policyRows).toHaveLength(1);
    expect(policyRows[0]?.positionId).toBe(POSITION_ID);
    expect(policyRows[0]?.isArmed).toBe(false);
    expect(policyRows[0]?.disarmedAt).not.toBeNull();

    const decisionRows = await db
      .select()
      .from(threatDecisions)
      .where(eq(threatDecisions.id, seeded.decisionId));
    expect(decisionRows).toHaveLength(1);
    expect(decisionRows[0]?.state).toBe("RESOLVED");
    expect(decisionRows[0]?.windowStartedAt).not.toBeNull();

    const execRows = await db
      .select()
      .from(executions)
      .where(eq(executions.id, seeded.executionId));
    expect(execRows).toHaveLength(1);
    expect(execRows[0]?.status).toBe("PROTECTED");

    const receiptRows = await db
      .select()
      .from(rescueReceipts)
      .where(eq(rescueReceipts.executionId, seeded.executionId));
    expect(receiptRows).toHaveLength(1);
    expect(receiptRows[0]?.status).toBe("PROTECTED");

    const checkRows = await db
      .select()
      .from(verificationChecks)
      .where(eq(verificationChecks.executionId, seeded.executionId));
    expect(checkRows).toHaveLength(1);
    expect(checkRows[0]?.verified).toBe(true);

    // Every historical audit remains; the settlement events were appended once.
    const types = await auditTypes();
    for (const expected of [
      "WITHDRAW_EVENT_VERIFIED",
      "DESTINATION_VERIFICATION_STARTED",
      "DESTINATION_VERIFICATION_PASSED",
      "RESCUE_RECEIPT_CREATED",
      "POSITION_PROTECTED",
      "POLICY_DISARMED",
      "DECISION_RESOLVED",
    ]) {
      expect(types).toContain(expected);
    }
    expect(types.filter((t) => t === "POLICY_DISARMED")).toHaveLength(countBefore("POLICY_DISARMED") + 1);
    expect(types.filter((t) => t === "DECISION_RESOLVED")).toHaveLength(countBefore("DECISION_RESOLVED") + 1);
  });

  it.skipIf(!dbAvailable)("settle runs when a DRILL policy and CONFIRMING decision still exist after PROTECTED", async () => {
    now = () => new Date("2026-08-12T12:00:00.000Z");
    const seeded = await seedProtectedSession();

    // Preconditions: an armed DRILL policy with a live CONFIRMING decision.
    expect((await getArmedPolicy(db, POSITION_ID))?.id).toBe(seeded.policyId);
    const decisionBefore = (await db
      .select()
      .from(threatDecisions)
      .where(eq(threatDecisions.id, seeded.decisionId)))[0];
    expect(decisionBefore?.state).toBe("CONFIRMING");

    const result = await verify(seeded.executionId);
    expect(result.outcome).toBe("VERIFIED");

    // The hook settled the lifecycle: nothing armed, decision resolved.
    expect(await getArmedPolicy(db, POSITION_ID)).toBeNull();
    expect(await isPolicyArmed(db, POSITION_ID)).toBe(false);
    const decisionAfter = (await db
      .select()
      .from(threatDecisions)
      .where(eq(threatDecisions.id, seeded.decisionId)))[0];
    expect(decisionAfter?.state).toBe("RESOLVED");
  });

  it.skipIf(!dbAvailable)("verifyEvacuationDestination settles the lifecycle on the fresh success path", async () => {
    now = () => new Date("2026-08-12T12:00:00.000Z");
    const seeded = await seedProtectedSession();
    const before = await auditTypes();
    const countBefore = (type: string) => before.filter((t) => t === type).length;

    const result = await verify(seeded.executionId);
    expect(result.outcome).toBe("VERIFIED");
    const afterFirst = await auditTypes();
    expect(afterFirst.filter((t) => t === "POLICY_DISARMED")).toHaveLength(countBefore("POLICY_DISARMED") + 1);
    expect(afterFirst.filter((t) => t === "DECISION_RESOLVED")).toHaveLength(countBefore("DECISION_RESOLVED") + 1);

    // The idempotent already-VERIFIED early return does not re-settle.
    const rerun = await verify(seeded.executionId);
    expect(rerun.outcome).toBe("VERIFIED");
    const afterRerun = await auditTypes();
    expect(afterRerun).toHaveLength(afterFirst.length);
    expect(afterRerun.filter((t) => t === "POLICY_DISARMED")).toHaveLength(countBefore("POLICY_DISARMED") + 1);
    expect(afterRerun.filter((t) => t === "DECISION_RESOLVED")).toHaveLength(countBefore("DECISION_RESOLVED") + 1);
  });
});
