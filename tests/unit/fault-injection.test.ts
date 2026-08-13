// M9 fault-injection tests: KeeperHub unreachable/unauthenticated before
// broadcast, simulation transport failure, polling timeout, and concurrency
// convergence (one decision / one execution / one broadcast). Faked clients
// only — no real network, no blockchain writes.

import { eq } from "drizzle-orm";
import { describe, expect, it, afterAll, beforeAll } from "vitest";

import {
  executions,
  signalObservations,
  simulations,
  threatDecisions,
} from "../../db/schema";
import { executeEvacuation } from "../../lib/vindex/execution-service";
import { prepareEvacuation } from "../../lib/vindex/evacuation-service";
import { evaluateProtectionPolicy } from "../../lib/vindex/policy-service";
import { armPolicy, disarmPolicy } from "../../lib/vindex/policy-service";
import { setSafeWalletConfig } from "../../lib/vindex/safe-wallet";
import type { ContractCallSimulation, ContractCallSubmission, DirectExecutionStatus, KeeperHubClient, KeeperHubWallet } from "../../lib/vindex/keeperhub";
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

const dbAvailable = Boolean(process.env.DATABASE_URL?.trim());
let db: Awaited<ReturnType<typeof getTestDb>>;
let now: () => Date;

type FaultConfig = {
  health?: "healthy" | "unreachable" | "unauthenticated";
  simulateThrows?: boolean;
  finalSimulation?: Partial<ContractCallSimulation>;
  submitThrows?: boolean;
  statusThrows?: boolean;
  statusQueue?: Partial<DirectExecutionStatus>[];
};

function createFakeKeeperHub(config: FaultConfig = {}) {
  const calls = { executeCount: 0, idempotencyKeys: [] as string[] };
  const statusQueue = [...(config.statusQueue ?? [])];
  const client = {
    healthCheck: async () => {
      if (config.health === "unreachable") throw new Error("network unreachable");
      if (config.health === "unauthenticated") {
        return { reachable: true, authenticated: false, keyShape: "kh_org" as const, statusCode: 401, errorCategory: "unauthorized" as const, checkedAt: "" };
      }
      return { reachable: true, authenticated: true, keyShape: "kh_org" as const, statusCode: 200, errorCategory: null, checkedAt: "" };
    },
    getOrganizationWallet: async (): Promise<KeeperHubWallet> => ({
      hasWallet: true,
      walletAddress: WALLET,
      walletId: "wal_1",
      isActive: true,
      invalidAddress: false,
      error: null,
    }),
    simulateContractCall: async (): Promise<ContractCallSimulation> => {
      if (config.simulateThrows) throw new Error("simulation transport failure");
      return {
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
        ...config.finalSimulation,
      };
    },
    executeContractCall: async (_request: unknown, idempotencyKey: string): Promise<ContractCallSubmission> => {
      if (config.submitThrows) throw new Error("network drop after request may have left client");
      calls.executeCount += 1;
      calls.idempotencyKeys.push(idempotencyKey);
      return {
        httpStatus: 202,
        executionId: "direct_fault_1",
        status: "completed",
        transactionHash: null,
        transactionLink: null,
        error: null,
        code: null,
        retryable: null,
        originalExecutionId: null,
        idempotentReplay: null,
      };
    },
    getExecutionStatus: async (executionId: string): Promise<DirectExecutionStatus> => {
      if (config.statusThrows) throw new Error("status polling timeout");
      const next = statusQueue.shift();
      return {
        httpStatus: 200,
        executionId,
        status: "completed",
        transactionHash: `0x${"ab".repeat(32)}`,
        transactionLink: `https://sepolia.basescan.org/tx/${"0xab".repeat(32)}`,
        sponsored: true,
        gasUsedWei: "95603",
        receipts: [],
        error: null,
        pollIntervalHintSec: 2,
        isTerminal: true,
        ...next,
      };
    },
  } as unknown as KeeperHubClient;
  return { calls, client };
}

function createFakeRpc(): CanonicalReadClient {
  let walletATokenReads = 0;
  const client = {
    getChainId: async () => 84532,
    getBlockNumber: async () => BigInt(45393000),
    getBalance: async () => BigInt("20000000000000000"),
    getBytecode: async () => "0x1234" as `0x${string}`,
    readContract: async (args: { address: string; functionName: string; args?: string[] }): Promise<unknown> => {
      const owner = (args.args ?? [])[0] ?? "";
      if (args.functionName === "balanceOf") {
        if (args.address.toLowerCase() === ATK.toLowerCase() && owner.toLowerCase() === WALLET.toLowerCase()) {
          walletATokenReads += 1;
          return walletATokenReads === 1 ? BigInt(5000077) : BigInt(0);
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
      if (args.functionName === "getPool") return POOL;
      throw new Error(`Unexpected readContract call: ${args.functionName}`);
    },
    getTransactionReceipt: async () => ({
      status: "success" as const,
      from: `0x${"99".repeat(20)}` as `0x${string}`,
      to: `0x${"88".repeat(20)}` as `0x${string}`,
      blockNumber: BigInt(45393010),
      logs: [
        {
          address: POOL,
          topics: [
            "0x3115d1449a7b732c986cba18244e897a450f61e1bb8d589cd2e69e6c8924f9f7" as `0x${string}`,
            `0x${"00".repeat(12)}${"ba50cd2a20f6da35d788639e581bca8d0b5d4d5f"}` as `0x${string}`,
            `0x${"00".repeat(12)}${WALLET.slice(2).toLowerCase()}` as `0x${string}`,
            `0x${"00".repeat(12)}${SAFE_WALLET.slice(2).toLowerCase()}` as `0x${string}`,
          ],
          data: `0x${BigInt(5000077).toString(16).padStart(64, "0")}`,
        },
      ],
    }),
    getBlock: async () => ({ timestamp: BigInt(Math.floor(Date.now() / 1000)) }),
  } as unknown as CanonicalReadClient;
  return client;
}

beforeAll(async () => {
  if (!dbAvailable) return;
  db = await getTestDb();
  await db.delete(executions);
  await db.delete(simulations);
  await db.delete(threatDecisions);
  await db.delete(signalObservations);
  await setSafeWalletConfig(db, SAFE_WALLET);
});

afterAll(async () => {
  await closeTestDb();
});

const seedReadyState = async (): Promise<{ executionId: string; decisionId: string }> => {
  now = () => new Date("2026-08-12T12:00:00.000Z");
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
      contractAddress: "0xba50Cd2A20f6DA35D788639E581bca8d0B5d4D5f", blockNumber: "1",
      blockTimestamp: recent, observedAt: recent, rpcSource: "Base Sepolia", metadataJson: "{}",
    },
  ]);
  const policy = await armPolicy({
    env: ENV, db, positionId: POSITION_ID, mode: "DRILL_HIGH_SENSITIVITY",
    publicClient: createFakeRpc(), keeperHubClient: createFakeKeeperHub().client, now,
  });
  const decisionRows = await db
    .insert(threatDecisions)
    .values({
      positionId: POSITION_ID,
      policyId: policy.id,
      policyVersion: policy.version,
      state: "CONFIRMING",
      matchedCount: 2,
      contributingSignalIds: "[]",
      matchedFamiliesJson: '["ORACLE_PRICE_STATE","AAVE_RESERVE_STATE"]',
      reasonJson: "{}",
      windowStartedAt: now(),
      confirmedAt: now(),
      expiresAt: new Date(now().getTime() + 3600 * 1000),
    })
    .returning({ id: threatDecisions.id });
  const decisionId = decisionRows[0].id;
  const prepared = await prepareEvacuation({
    env: ENV, db, decisionId,
    keeperHubClient: createFakeKeeperHub().client, publicClient: createFakeRpc(), now,
  });
  return { executionId: prepared.executionId, decisionId };
};

describe("KeeperHub unavailability before broadcast", () => {
  it.skipIf(!dbAvailable)("an unreachable KeeperHub fails closed with ZERO broadcast", async () => {
    const { executionId } = await seedReadyState();
    const f = createFakeKeeperHub({ health: "unreachable" });
    await expect(
      executeEvacuation({ env: ENV, db, executionId, keeperHubClient: f.client, publicClient: createFakeRpc(), now }),
    ).rejects.toMatchObject({ code: "KEEPERHUB_UNAVAILABLE" });
    expect(f.calls.executeCount).toBe(0);
  });

  it.skipIf(!dbAvailable)("an unauthenticated KeeperHub fails closed with ZERO broadcast", async () => {
    const { executionId } = await seedReadyState();
    const f = createFakeKeeperHub({ health: "unauthenticated" });
    await expect(
      executeEvacuation({ env: ENV, db, executionId, keeperHubClient: f.client, publicClient: createFakeRpc(), now }),
    ).rejects.toMatchObject({ code: "KEEPERHUB_UNAVAILABLE" });
    expect(f.calls.executeCount).toBe(0);
  });
});

describe("simulation transport failures", () => {
  it.skipIf(!dbAvailable)("a simulation transport failure blocks execution with ZERO broadcast", async () => {
    const { executionId } = await seedReadyState();
    const f = createFakeKeeperHub({ simulateThrows: true });
    await expect(
      executeEvacuation({ env: ENV, db, executionId, keeperHubClient: f.client, publicClient: createFakeRpc(), now }),
    ).rejects.toMatchObject({ code: "LIVE_READ_FAILED" });
    expect(f.calls.executeCount).toBe(0);
  });

  it.skipIf(!dbAvailable)("a polling timeout leaves EXECUTION_PENDING with no second broadcast", async () => {
    const { executionId } = await seedReadyState();
    const f = createFakeKeeperHub({ statusThrows: true });
    const result = await executeEvacuation({ env: ENV, db, executionId, keeperHubClient: f.client, publicClient: createFakeRpc(), now });
    expect(result.outcome).toBe("EXECUTION_PENDING");
    expect(f.calls.executeCount).toBe(1);
  });
});

describe("concurrency convergence", () => {
  it.skipIf(!dbAvailable)("concurrent evaluates converge on one active decision", async () => {
    const { decisionId } = await seedReadyState();
    const [a, b] = await Promise.all([
      evaluateProtectionPolicy({ env: ENV, db, positionId: POSITION_ID, now }),
      evaluateProtectionPolicy({ env: ENV, db, positionId: POSITION_ID, now }),
    ]);
    expect(a.decisionId).toBe(b.decisionId);
    expect(a.decisionId).toBe(decisionId);
    const rows = await db.select().from(threatDecisions).where(eq(threatDecisions.id, decisionId));
    expect(rows).toHaveLength(1);
  });

  it.skipIf(!dbAvailable)("concurrent prepares converge on one execution row", async () => {
    const { decisionId } = await seedReadyState();
    const f = createFakeKeeperHub();
    const [a, b] = await Promise.all([
      prepareEvacuation({ env: ENV, db, decisionId, keeperHubClient: f.client, publicClient: createFakeRpc(), now }),
      prepareEvacuation({ env: ENV, db, decisionId, keeperHubClient: f.client, publicClient: createFakeRpc(), now }),
    ]);
    expect(a.executionId).toBe(b.executionId);
    const rows = await db.select().from(executions).where(eq(executions.decisionId, decisionId));
    expect(rows).toHaveLength(1);
  });

  it.skipIf(!dbAvailable)("concurrent executes produce exactly one broadcast", async () => {
    const { executionId } = await seedReadyState();
    const f = createFakeKeeperHub();
    const [a, b] = await Promise.all([
      executeEvacuation({ env: ENV, db, executionId, keeperHubClient: f.client, publicClient: createFakeRpc(), now }),
      executeEvacuation({ env: ENV, db, executionId, keeperHubClient: f.client, publicClient: createFakeRpc(), now }),
    ]);
    // Exactly one logical broadcast; the loser recovers without broadcasting.
    expect(f.calls.executeCount).toBe(1);
    const validOutcomes = new Set(["EXECUTED_VERIFYING_DESTINATION", "SUBMISSION_PENDING", "M7_ALREADY_EXECUTED"]);
    expect(validOutcomes.has(a.outcome)).toBe(true);
    expect(validOutcomes.has(b.outcome)).toBe(true);
    expect([a.outcome, b.outcome]).toContain("EXECUTED_VERIFYING_DESTINATION");
    // The DB row converges on the single KeeperHub execution id.
    const rows = await db.select().from(executions).where(eq(executions.id, executionId));
    expect(rows[0]?.keeperhubExecutionId).toBe("direct_fault_1");
    expect(new Set([a.keeperhubExecutionId, b.keeperhubExecutionId, rows[0]?.keeperhubExecutionId].filter(Boolean)).size).toBe(1);
    // A subsequent call converges on the terminal verified state.
    const final = await executeEvacuation({ env: ENV, db, executionId, keeperHubClient: f.client, publicClient: createFakeRpc(), now });
    expect(final.outcome).toBe("M7_ALREADY_EXECUTED");
    expect(f.calls.executeCount).toBe(1);
  });
});
