// M7 execution tests: authorization revalidation, final simulation gate,
// atomic claim, stable idempotency, ambiguous-outcome rules, status polling,
// onchain Withdraw proof, and the no-PROTECTED invariant. Isolated test DB;
// all chain/KeeperHub interaction faked — no real network or transactions.

import { describe, expect, it, afterAll, beforeAll } from "vitest";
import { keccak256, toBytes } from "viem";

import { executions, signalObservations, simulations, threatDecisions } from "../../db/schema";
import { executeEvacuation, m7IdempotencyKey } from "../../lib/vindex/execution-service";
import { prepareEvacuation } from "../../lib/vindex/evacuation-service";
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
const USDC = "0xba50Cd2A20f6DA35D788639E581bca8d0B5d4D5f";
const ATK = "0x10F1A9D11CDf50041f3f8cB7191CBE2f31750ACC";
const ORACLE = "0x943b0dE18d4abf4eF02A85912F8fc07684C141dF";
const SAFE_WALLET = "0x2222222222222222222222222222222222222222";
const POSITION_ID = `base-sepolia:aave-v3:usdc:${WALLET.toLowerCase()}`;
const RELAYER = "0x6331eb4571de9284f7e9ead98ac7b0661a091e99";
const EXECUTOR = "0x5af5194b4b0909eb978e3cf1e25333852277f07d";
const WITHDRAW_TOPIC = keccak256(toBytes("Withdraw(address,address,address,uint256)"));

const dbAvailable = Boolean(process.env.DATABASE_URL?.trim());
let db: Awaited<ReturnType<typeof getTestDb>>;
let now: () => Date;

const pad = (address: string): `0x${string}` =>
  `0x${address.slice(2).toLowerCase().padStart(64, "0")}` as `0x${string}`;

const encodeUint = (value: bigint): `0x${string}` =>
  `0x${value.toString(16).padStart(64, "0")}` as `0x${string}`;

const makeWithdrawLog = (reserve: string, user: string, to: string, amount: bigint) => ({
  address: POOL,
  topics: [WITHDRAW_TOPIC, pad(reserve), pad(user), pad(to)] as `0x${string}`[],
  data: encodeUint(amount),
});

type FakeConfig = {
  finalSimulation?: Partial<ContractCallSimulation>;
  submission?: Partial<ContractCallSubmission>;
  statusQueue?: Partial<DirectExecutionStatus>[];
  aUsdcPre?: bigint;
  aUsdcPost?: bigint;
  receiptLogs?: Array<{ address: string; topics: `0x${string}`[]; data: string }>;
  receiptStatus?: "success" | "reverted";
};

function createFakes(config: FakeConfig = {}) {
  const calls = { executeCount: 0, simulateCount: 0, idempotencyKeys: [] as string[], walletATokenReads: 0 };
  const statusQueue = [...(config.statusQueue ?? [])];

  const keeperHub: KeeperHubClient = {
    healthCheck: async () => ({
      reachable: true,
      authenticated: true,
      keyShape: "kh_org" as const,
      statusCode: 200,
      errorCategory: null,
      checkedAt: "",
    }),
    getOrganizationWallet: async (): Promise<KeeperHubWallet> => ({
      hasWallet: true,
      walletAddress: WALLET,
      walletId: "wal_1",
      isActive: true,
      invalidAddress: false,
      error: null,
    }),
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
      ...config.finalSimulation,
    }),
    executeContractCall: async (_request: unknown, idempotencyKey: string): Promise<ContractCallSubmission> => {
      calls.executeCount += 1;
      calls.idempotencyKeys.push(idempotencyKey);
      if (config.submission?.httpStatus === 0) {
        throw new Error("network timeout");
      }
      return {
        httpStatus: 202,
        executionId: "direct_m7_1",
        status: "completed",
        transactionHash: null,
        transactionLink: null,
        error: null,
        code: null,
        retryable: null,
        originalExecutionId: null,
        idempotentReplay: null,
        ...config.submission,
      };
    },
    getExecutionStatus: async (executionId: string): Promise<DirectExecutionStatus> => {
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

  const rpc: CanonicalReadClient = {
    getChainId: async () => 84532,
    getBlockNumber: async () => BigInt(45393000),
    getBalance: async () => BigInt("20000000000000000"),
    getBytecode: async () => "0x1234" as `0x${string}`,
    readContract: async (args: { address: string; functionName: string }): Promise<unknown> => {
      if (args.functionName === "balanceOf") {
        if (args.address.toLowerCase() === ATK.toLowerCase()) {
          const owner = (args as { args?: string[] }).args?.[0] ?? "";
          if (owner.toLowerCase() === WALLET.toLowerCase()) {
            calls.walletATokenReads += 1;
            return calls.walletATokenReads === 1 ? (config.aUsdcPre ?? BigInt(5000077)) : (config.aUsdcPost ?? BigInt(0));
          }
          return config.aUsdcPre ?? BigInt(5000077);
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
      status: config.receiptStatus ?? "success",
      from: RELAYER,
      to: EXECUTOR,
      blockNumber: BigInt(45393010),
      logs: config.receiptLogs ?? [makeWithdrawLog(USDC, WALLET, SAFE_WALLET, BigInt(5000077))],
    }),
    getBlock: async () => ({ timestamp: BigInt(Math.floor(Date.now() / 1000)) }),
  } as unknown as CanonicalReadClient;

  return { calls, keeperHub, rpc };
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

const seedLiveFamilies = async (): Promise<void> => {
  await db.delete(signalObservations);
  const recent = new Date();
  await db.insert(signalObservations).values([
    {
      positionId: POSITION_ID, chainId: 84532, protocol: "Aave V3",
      sourceFamily: "ORACLE_PRICE_STATE", metric: "AAVE_USDC_ORACLE_PRICE",
      rawValue: "99979128", normalizedValue: "99979128", severity: null,
      contractAddress: ORACLE, blockNumber: "1", blockTimestamp: recent, observedAt: recent,
      rpcSource: "Base Sepolia", metadataJson: "{}",
    },
    {
      positionId: POSITION_ID, chainId: 84532, protocol: "Aave V3",
      sourceFamily: "AAVE_RESERVE_STATE", metric: "AAVE_RESERVE_TOTAL_VARIABLE_DEBT",
      rawValue: "6154634874505", normalizedValue: "6154634874505", severity: null,
      contractAddress: USDC, blockNumber: "1", blockTimestamp: recent, observedAt: recent,
      rpcSource: "Base Sepolia", metadataJson: "{}",
    },
  ]);
};

const seedPreparedExecution = async (): Promise<{ executionId: string; decisionId: string }> => {
  now = () => new Date("2026-08-12T12:00:00.000Z");
  await disarmPolicy(db, POSITION_ID);
  await setSafeWalletConfig(db, SAFE_WALLET);
  await seedLiveFamilies();
  const policy = await armPolicy({
    env: ENV, db, positionId: POSITION_ID, mode: "DRILL_HIGH_SENSITIVITY",
    publicClient: createFakes().rpc, keeperHubClient: createFakes().keeperHub, now,
  });
  const inserted = await db
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
  const decisionId = inserted[0].id;
  const prepared = await prepareEvacuation({
    env: ENV, db, decisionId,
    keeperHubClient: createFakes().keeperHub, publicClient: createFakes().rpc, now,
  });
  return { executionId: prepared.executionId, decisionId };
};

const execute = (
  executionId: string,
  config: FakeConfig = {},
  overrides: { pollMaxMs?: number } = {},
) => {
  const fakes = createFakes(config);
  return {
    ...fakes,
    result: executeEvacuation({
      env: ENV,
      db,
      executionId,
      keeperHubClient: fakes.keeperHub,
      publicClient: fakes.rpc,
      now,
      pollMaxMs: overrides.pollMaxMs ?? 5000,
    }),
  };
};

describe("authorization blocks", () => {
  it.skipIf(!dbAvailable)("an expired decision blocks the write", async () => {
    const { executionId } = await seedPreparedExecution();
    now = () => new Date("2026-08-12T13:30:00.000Z");
    const f = execute(executionId);
    await expect(f.result).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(f.calls.executeCount).toBe(0);
  });

  it.skipIf(!dbAvailable)("a disarmed policy blocks the write", async () => {
    const { executionId, decisionId } = await seedPreparedExecution();
    await disarmPolicy(db, POSITION_ID);
    const f = execute(executionId);
    await expect(f.result).rejects.toMatchObject({ code: "POLICY_ARMED_RECONFIGURE_REQUIRED" });
    expect(f.calls.executeCount).toBe(0);
    await armPolicy({
      env: ENV, db, positionId: POSITION_ID, mode: "DRILL_HIGH_SENSITIVITY",
      publicClient: createFakes().rpc, keeperHubClient: createFakes().keeperHub, now,
    });
    void decisionId;
  });

  it.skipIf(!dbAvailable)("a changed safe wallet blocks the write", async () => {
    const { executionId } = await seedPreparedExecution();
    await setSafeWalletConfig(db, "0x3333333333333333333333333333333333333333");
    const f = execute(executionId);
    await expect(f.result).rejects.toMatchObject({ code: "INVALID_SAFE_WALLET" });
    expect(f.calls.executeCount).toBe(0);
  });

  it.skipIf(!dbAvailable)("a zero position blocks the write", async () => {
    const { executionId } = await seedPreparedExecution();
    const f = execute(executionId, { aUsdcPre: BigInt(0) });
    await expect(f.result).rejects.toMatchObject({ code: "POSITION_ZERO" });
    expect(f.calls.executeCount).toBe(0);
  });
});

describe("final simulation gate", () => {
  it.skipIf(!dbAvailable)("a would-revert final simulation blocks the broadcast", async () => {
    const { executionId } = await seedPreparedExecution();
    const f = execute(executionId, {
      finalSimulation: { success: false, wouldRevert: true, revertReason: "Error(INSUFFICIENT_AVAILABLE_BALANCE)" },
    });
    const result = await f.result;
    expect(result.outcome).toBe("EXECUTION_FAILED");
    expect(result.errorCode).toBe("FINAL_SIMULATION_FAILED");
    expect(f.calls.executeCount).toBe(0);
  });

  it.skipIf(!dbAvailable)("a final simulation sender mismatch blocks the broadcast", async () => {
    const { executionId } = await seedPreparedExecution();
    const f = execute(executionId, { finalSimulation: { from: `0x${"99".repeat(20)}` } });
    const result = await f.result;
    expect(result.outcome).toBe("EXECUTION_FAILED");
    expect(f.calls.executeCount).toBe(0);
  });
});

describe("atomic claim and idempotency", () => {
  it.skipIf(!dbAvailable)("the stable idempotency key is used and survives a retry after ambiguity", async () => {
    const { executionId } = await seedPreparedExecution();
    // First attempt: network ambiguity after submission -> SUBMISSION_UNKNOWN.
    const first = execute(executionId, { submission: { httpStatus: 0 } });
    const result1 = await first.result;
    expect(result1.outcome).toBe("SUBMISSION_UNKNOWN");

    // Rerun: recovers with the SAME key (replay semantics), no new key.
    const second = execute(executionId);
    const result2 = await second.result;
    expect(result2.outcome).toBe("EXECUTED_VERIFYING_DESTINATION");
    const key1 = first.calls.idempotencyKeys[0];
    const key2 = second.calls.idempotencyKeys[0];
    expect(key1).toBe(key2);
    expect(key1).toMatch(new RegExp(`^vindex-m7-${executionId}-`));
  });

  it.skipIf(!dbAvailable)("an idempotency replay adopts the original execution without a new write", async () => {
    const { executionId } = await seedPreparedExecution();
    const f = execute(executionId, {
      submission: { httpStatus: 409, executionId: "direct_original", idempotentReplay: true, status: "completed" },
    });
    const result = await f.result;
    expect(f.calls.executeCount).toBe(1);
    expect(result.keeperhubExecutionId).toBe("direct_original");
  });

  it.skipIf(!dbAvailable)("a repeated execute after success returns M7_ALREADY_EXECUTED with zero writes", async () => {
    const { executionId } = await seedPreparedExecution();
    const first = execute(executionId);
    const result1 = await first.result;
    expect(result1.outcome).toBe("EXECUTED_VERIFYING_DESTINATION");
    const second = execute(executionId);
    const result2 = await second.result;
    expect(result2.outcome).toBe("M7_ALREADY_EXECUTED");
    expect(second.calls.executeCount).toBe(0);
  });
});

describe("status and onchain proof", () => {
  it.skipIf(!dbAvailable)("a failed KeeperHub status fails closed", async () => {
    const { executionId } = await seedPreparedExecution();
    const f = execute(executionId, {
      statusQueue: [{ status: "failed", isTerminal: true, transactionHash: null, error: "execution reverted" }],
    });
    const result = await f.result;
    expect(result.outcome).toBe("EXECUTION_FAILED");
    expect(result.errorCode).toBe("KEEPERHUB_EXECUTION_FAILED");
  });

  it.skipIf(!dbAvailable)("completed without a transaction hash fails", async () => {
    const { executionId } = await seedPreparedExecution();
    const f = execute(executionId, {
      statusQueue: [{ status: "completed", isTerminal: true, transactionHash: null }],
    });
    const result = await f.result;
    expect(result.outcome).toBe("EXECUTION_FAILED");
    expect(result.errorCode).toBe("MISSING_TRANSACTION_HASH");
  });

  it.skipIf(!dbAvailable)("a reverted receipt fails", async () => {
    const { executionId } = await seedPreparedExecution();
    const f = execute(executionId, { receiptStatus: "reverted" });
    const result = await f.result;
    expect(result.outcome).toBe("EXECUTION_FAILED");
    expect(result.errorCode).toBe("RECEIPT_REVERTED");
  });

  it.skipIf(!dbAvailable)("a wrong Withdraw reserve/user/to is rejected", async () => {
    const { executionId } = await seedPreparedExecution();
    const f = execute(executionId, {
      receiptLogs: [makeWithdrawLog(`0x${"77".repeat(20)}`, WALLET, SAFE_WALLET, BigInt(5000077))],
    });
    const result = await f.result;
    expect(result.outcome).toBe("EXECUTION_FAILED");
    expect(result.errorCode).toBe("WITHDRAW_EVENT_MISMATCH");
  });

  it.skipIf(!dbAvailable)("a sponsored execution with a valid Withdraw event passes", async () => {
    const { executionId } = await seedPreparedExecution();
    const f = execute(executionId, {
      statusQueue: [{ status: "completed", isTerminal: true, sponsored: true }],
      aUsdcPost: BigInt(0),
    });
    const result = await f.result;
    expect(result.outcome).toBe("EXECUTED_VERIFYING_DESTINATION");
    expect(result.actualWithdrawAmount).toBe("5000077");
    expect(result.transactionHash).toBe(`0x${"ab".repeat(32)}`);
    expect(result.sponsored).toBe(true);
    expect(result.readyForDestinationVerification).toBe(true);
  });

  it.skipIf(!dbAvailable)("a non-decreasing aUSDC fails verification", async () => {
    const { executionId } = await seedPreparedExecution();
    const f = execute(executionId, { aUsdcPost: BigInt(5000077) });
    const result = await f.result;
    expect(result.outcome).toBe("EXECUTION_FAILED");
    expect(result.errorCode).toBe("POSITION_NOT_DECREASED");
  });
});

describe("boundaries", () => {
  it("the state machine never sets PROTECTED", async () => {
    const source = await import("fs/promises").then((fs) =>
      fs.readFile("lib/vindex/execution-service.ts", "utf8"),
    );
    expect(source).not.toContain('"PROTECTED"');
    expect(source).not.toContain("RESCUE_COMPLETE");
  });

  it("no private keys or secrets in the service", async () => {
    const source = await import("fs/promises").then((fs) =>
      fs.readFile("lib/vindex/execution-service.ts", "utf8"),
    );
    expect(source).not.toContain("privateKey");
    expect(source).not.toContain("walletClient");
  });

  it("m7 idempotency keys are stable per execution", () => {
    const key = m7IdempotencyKey("e1", "abcdef1234567890");
    expect(key).toBe(m7IdempotencyKey("e1", "abcdef1234567890"));
    expect(key).not.toBe(m7IdempotencyKey("e2", "abcdef1234567890"));
  });
});
