// Unit tests for runM1ExecutionProof: wallet gating, gas buffer, simulation
// gates, broadcast/polling, onchain verification, sponsored execution, and
// re-run safety. All KeeperHub/RPC interaction is faked — no network, no real
// transactions, no real sleeping (status stubs are terminal immediately or
// use pollIntervalHintSec 0).

import { describe, expect, it, afterAll } from "vitest";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { keccak256, toBytes } from "viem";

import { AAVE_V3_BASE_SEPOLIA } from "../../lib/vindex/aave-registry";
import { readAaveUsdcAllowance } from "../../lib/vindex/aave-reads";
import {
  M1_IDEMPOTENCY_PREFIX,
  M1_MIN_GAS_WEI,
  runM1ExecutionProof,
  type M1ExecutionResult,
} from "../../lib/vindex/m1-execution";
import {
  buildM1Evidence,
  loadM1Evidence,
  writeM1Evidence,
  type M1Evidence,
} from "../../lib/vindex/m1-evidence";
import type {
  ContractCallSimulation,
  ContractCallSubmission,
  DirectExecutionStatus,
  KeeperHubClient,
  KeeperHubWallet,
} from "../../lib/vindex/keeperhub";
import type { CanonicalReadClient } from "../../lib/vindex/public-client";
import type { VindexEnv } from "../../lib/vindex/env";

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------

const ENV: VindexEnv = {
  baseSepoliaRpcUrl: "https://sepolia.base.org",
  keeperhubApiKey: "kh_test_key_123456",
  keeperhubApiBaseUrl: "https://app.keeperhub.com",
};

const WALLET = "0x675638ddbbf8b70b906d68e3485da72c6c63d130";
const USDC = AAVE_V3_BASE_SEPOLIA.usdcUnderlying;
const POOL = AAVE_V3_BASE_SEPOLIA.pool;
const TX = `0x${"ab".repeat(32)}`;
const TX_PREV = `0x${"cd".repeat(32)}`;

const APPROVAL_TOPIC = keccak256(toBytes("Approval(address,address,uint256)"));

/** Left-pads an address to a 32-byte indexed-event topic. */
const pad = (address: string): `0x${string}` =>
  (`0x${address.slice(2).toLowerCase().padStart(64, "0")}`) as `0x${string}`;

/** Encodes a uint256 value as 32-byte hex data (non-indexed event input). */
const encodeUint = (value: bigint): string =>
  `0x${value.toString(16).padStart(64, "0")}`;

type ReceiptFixture = {
  status: "success" | "reverted";
  from: string;
  to: string | null;
  blockNumber: bigint;
  logs: { address: string; topics: `0x${string}`[]; data: string }[];
};

function makeApprovalLog(
  owner: string,
  spender: string,
  value: bigint,
): { address: string; topics: `0x${string}`[]; data: string } {
  return {
    address: USDC,
    topics: [APPROVAL_TOPIC, pad(owner), pad(spender)],
    data: encodeUint(value),
  };
}

function makeReceipt(overrides: Partial<ReceiptFixture> = {}): ReceiptFixture {
  return {
    status: "success",
    from: WALLET,
    to: USDC,
    blockNumber: BigInt(42),
    logs: [makeApprovalLog(WALLET, POOL, BigInt(1))],
    ...overrides,
  };
}

function makeWallet(overrides: Partial<KeeperHubWallet> = {}): KeeperHubWallet {
  return {
    hasWallet: true,
    walletAddress: WALLET,
    walletId: "wal_1",
    isActive: true,
    invalidAddress: false,
    error: null,
    ...overrides,
  };
}

function makeSimulation(
  overrides: Partial<ContractCallSimulation> = {},
): ContractCallSimulation {
  return {
    httpStatus: 200,
    success: true,
    status: "simulated",
    from: WALLET,
    to: USDC,
    value: "0",
    gasEstimate: "65000",
    simulatedReturnValue: true,
    wouldRevert: false,
    revertReason: null,
    error: null,
    idempotentReplay: null,
    ...overrides,
  };
}

function makeSubmission(
  overrides: Partial<ContractCallSubmission> = {},
): ContractCallSubmission {
  return {
    httpStatus: 202,
    executionId: "direct_m1_1",
    status: "completed",
    transactionHash: null,
    transactionLink: null,
    error: null,
    code: null,
    retryable: null,
    originalExecutionId: null,
    idempotentReplay: null,
    ...overrides,
  };
}

function makeStatus(overrides: Partial<DirectExecutionStatus> = {}): DirectExecutionStatus {
  return {
    httpStatus: 200,
    executionId: "direct_m1_1",
    status: "completed",
    transactionHash: TX,
    transactionLink: `https://sepolia.basescan.org/tx/${TX}`,
    sponsored: false,
    gasUsedWei: "95603",
    receipts: [],
    error: null,
    pollIntervalHintSec: 2,
    isTerminal: true,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Fake KeeperHub client
// ---------------------------------------------------------------------------

type FakeKeeperHubConfig = {
  wallet?: KeeperHubWallet;
  simulation?: ContractCallSimulation;
  submission?: ContractCallSubmission;
  statusQueue?: DirectExecutionStatus[]; // served in order; last entry repeats
};

type FakeKeeperHub = {
  config: FakeKeeperHubConfig;
  calls: {
    executeCount: number;
    simulateCount: number;
    statusCalls: number;
    lastIdempotencyKey: string | null;
  };
  client: KeeperHubClient;
};

function createFakeKeeperHub(config: FakeKeeperHubConfig = {}): FakeKeeperHub {
  const calls = {
    executeCount: 0,
    simulateCount: 0,
    statusCalls: 0,
    lastIdempotencyKey: null as string | null,
  };
  const queue = [...(config.statusQueue ?? [])];

  const client = {
    healthCheck: async () => ({
      reachable: true,
      authenticated: true,
      keyShape: "kh_org" as const,
      statusCode: 200,
      errorCategory: null,
      checkedAt: "",
    }),
    getOrganizationWallet: async () => config.wallet ?? makeWallet(),
    simulateContractCall: async () => {
      calls.simulateCount += 1;
      return config.simulation ?? makeSimulation();
    },
    executeContractCall: async (_request: unknown, idempotencyKey: string) => {
      calls.executeCount += 1;
      calls.lastIdempotencyKey = idempotencyKey;
      return config.submission ?? makeSubmission();
    },
    getExecutionStatus: async () => {
      calls.statusCalls += 1;
      if (queue.length === 0) return makeStatus();
      const next = queue.shift();
      return next ?? makeStatus();
    },
  } as unknown as KeeperHubClient;

  return { config, calls, client };
}

// ---------------------------------------------------------------------------
// Fake canonical RPC client
// ---------------------------------------------------------------------------

type FakeRpcConfig = {
  balance?: bigint;
  allowanceQueue?: bigint[]; // served in order; last entry repeats
  receipt?: ReceiptFixture;
  receiptError?: Error;
};

function createFakeRpc(config: FakeRpcConfig = {}): CanonicalReadClient {
  const allowanceValues = [...(config.allowanceQueue ?? [BigInt(0)])];
  let allowanceCalls = 0;

  const client = {
    getChainId: async () => 84532,
    getBlockNumber: async () => BigInt(1000),
    getBalance: async () => config.balance ?? M1_MIN_GAS_WEI,
    getBytecode: async () => "0x1234" as `0x${string}`,
    readContract: async (args: { functionName: string }) => {
      if (args.functionName === "allowance") {
        const index = Math.min(allowanceCalls, allowanceValues.length - 1);
        allowanceCalls += 1;
        return allowanceValues[index];
      }
      if (args.functionName === "decimals") return BigInt(6);
      if (args.functionName === "symbol") return "USDC";
      throw new Error(`Unexpected readContract call: ${args.functionName}`);
    },
    getTransactionReceipt: async () => {
      if (config.receiptError !== undefined) throw config.receiptError;
      return config.receipt ?? makeReceipt();
    },
  } as unknown as CanonicalReadClient;

  return client;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const tempDirs: string[] = [];
afterAll(() => {
  for (const dir of tempDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function newEvidencePath(): string {
  const dir = mkdtempSync(join(tmpdir(), "m1-exec-"));
  tempDirs.push(dir);
  return join(dir, "evidence.json");
}

function verifiedEvidenceOf(result: M1ExecutionResult): M1Evidence {
  if (result.outcome !== "VERIFIED") {
    throw new Error(`expected VERIFIED, got ${JSON.stringify(result)}`);
  }
  return result.evidence;
}

function blockedOf(result: M1ExecutionResult): { stage: string; reason: string } {
  if (result.outcome !== "BLOCKED") {
    throw new Error(`expected BLOCKED, got ${JSON.stringify(result)}`);
  }
  return result;
}

function failedOf(result: M1ExecutionResult): { stage: string; reason: string; executionId?: string } {
  if (result.outcome !== "FAILED") {
    throw new Error(`expected FAILED, got ${JSON.stringify(result)}`);
  }
  return result;
}

// ---------------------------------------------------------------------------
// Wallet gating
// ---------------------------------------------------------------------------

describe("wallet gating", () => {
  it("blocks with KEEPERHUB_WALLET_INVALID when KeeperHub reports an invalid address", async () => {
    const fake = createFakeKeeperHub({
      wallet: makeWallet({ walletAddress: "0x123", invalidAddress: true }),
    });
    const result = await runM1ExecutionProof({
      env: ENV,
      keeperHubClient: fake.client,
      publicClient: createFakeRpc(),
      evidencePath: newEvidencePath(),
    });

    expect(result.outcome).toBe("KEEPERHUB_WALLET_INVALID");
    expect(fake.calls.executeCount).toBe(0);
  });

  it("blocks with KEEPERHUB_WALLET_NOT_CONFIGURED when no wallet exists", async () => {
    const fake = createFakeKeeperHub({
      wallet: makeWallet({ hasWallet: false, walletAddress: null, walletId: null }),
    });
    const result = await runM1ExecutionProof({
      env: ENV,
      keeperHubClient: fake.client,
      publicClient: createFakeRpc(),
      evidencePath: newEvidencePath(),
    });

    expect(result.outcome).toBe("KEEPERHUB_WALLET_NOT_CONFIGURED");
    expect(fake.calls.executeCount).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Gas buffer
// ---------------------------------------------------------------------------

describe("gas buffer", () => {
  it("blocks at the gas stage when the wallet has no native balance", async () => {
    const fake = createFakeKeeperHub();
    const result = await runM1ExecutionProof({
      env: ENV,
      keeperHubClient: fake.client,
      publicClient: createFakeRpc({ balance: BigInt(0) }),
      evidencePath: newEvidencePath(),
    });

    const blocked = blockedOf(result);
    expect(blocked.stage).toBe("gas");
    expect(blocked.reason).toContain("faucet");
    expect(blocked.reason).toContain(WALLET);
    expect(fake.calls.executeCount).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// readAaveUsdcAllowance bigint precision
// ---------------------------------------------------------------------------

describe("readAaveUsdcAllowance bigint handling", () => {
  it("returns 0n when the onchain allowance is 0", async () => {
    const rpc = createFakeRpc({ allowanceQueue: [BigInt(0)] });
    expect(await readAaveUsdcAllowance(rpc, WALLET, POOL)).toBe(BigInt(0));
  });

  it("returns 1n when the onchain allowance is 1", async () => {
    const rpc = createFakeRpc({ allowanceQueue: [BigInt(1)] });
    expect(await readAaveUsdcAllowance(rpc, WALLET, POOL)).toBe(BigInt(1));
  });

  it("preserves full precision for a large bigint allowance", async () => {
    const big = BigInt("12345678901234567890");
    const rpc = createFakeRpc({ allowanceQueue: [big] });
    expect(await readAaveUsdcAllowance(rpc, WALLET, POOL)).toBe(big);
  });
});

// ---------------------------------------------------------------------------
// Simulation gates (nothing may be broadcast)
// ---------------------------------------------------------------------------

describe("simulation gates", () => {
  it("blocks when the simulation would revert", async () => {
    const fake = createFakeKeeperHub({
      simulation: makeSimulation({
        success: false,
        wouldRevert: true,
        revertReason: "Error(INSUFFICIENT_ALLOWANCE)",
      }),
    });
    const result = await runM1ExecutionProof({
      env: ENV,
      keeperHubClient: fake.client,
      publicClient: createFakeRpc(),
      evidencePath: newEvidencePath(),
    });

    const blocked = blockedOf(result);
    expect(blocked.stage).toBe("simulation");
    expect(blocked.reason).toContain("INSUFFICIENT_ALLOWANCE");
    expect(fake.calls.executeCount).toBe(0);
  });

  it("blocks when the simulated sender is not the organization wallet", async () => {
    const fake = createFakeKeeperHub({
      simulation: makeSimulation({ from: "0x1111111111111111111111111111111111111111" }),
    });
    const result = await runM1ExecutionProof({
      env: ENV,
      keeperHubClient: fake.client,
      publicClient: createFakeRpc(),
      evidencePath: newEvidencePath(),
    });

    const blocked = blockedOf(result);
    expect(blocked.stage).toBe("simulation");
    expect(blocked.reason).toContain("sender mismatch");
    expect(fake.calls.executeCount).toBe(0);
  });

  it("blocks when the simulated target is not the canonical USDC", async () => {
    const fake = createFakeKeeperHub({
      simulation: makeSimulation({ from: WALLET, to: "0x2222222222222222222222222222222222222222" }),
    });
    const result = await runM1ExecutionProof({
      env: ENV,
      keeperHubClient: fake.client,
      publicClient: createFakeRpc(),
      evidencePath: newEvidencePath(),
    });

    const blocked = blockedOf(result);
    expect(blocked.stage).toBe("simulation");
    expect(blocked.reason).toContain("target mismatch");
    expect(fake.calls.executeCount).toBe(0);
  });

  it("blocks when the simulation did not succeed", async () => {
    const fake = createFakeKeeperHub({
      simulation: makeSimulation({ success: false, error: "simulation exploded" }),
    });
    const result = await runM1ExecutionProof({
      env: ENV,
      keeperHubClient: fake.client,
      publicClient: createFakeRpc(),
      evidencePath: newEvidencePath(),
    });

    const blocked = blockedOf(result);
    expect(blocked.stage).toBe("simulation");
    expect(blocked.reason).toContain("simulation exploded");
    expect(fake.calls.executeCount).toBe(0);
  });

  it.each([{ gasEstimate: "0" }, { gasEstimate: null }])(
    "blocks when the gas estimate is %j",
    async ({ gasEstimate }) => {
      const fake = createFakeKeeperHub({ simulation: makeSimulation({ gasEstimate }) });
      const result = await runM1ExecutionProof({
        env: ENV,
        keeperHubClient: fake.client,
        publicClient: createFakeRpc(),
        evidencePath: newEvidencePath(),
      });

      const blocked = blockedOf(result);
      expect(blocked.stage).toBe("simulation");
      expect(blocked.reason).toContain("gas estimate");
      expect(fake.calls.executeCount).toBe(0);
    },
  );
});

// ---------------------------------------------------------------------------
// Happy path
// ---------------------------------------------------------------------------

describe("happy path", () => {
  it("broadcasts once and writes verified evidence", async () => {
    const evidencePath = newEvidencePath();
    const fake = createFakeKeeperHub({
      submission: makeSubmission({ executionId: "direct_m1_1" }),
      statusQueue: [makeStatus({ executionId: "direct_m1_1", transactionHash: TX })],
    });
    const rpc = createFakeRpc({ allowanceQueue: [BigInt(0), BigInt(1)] });

    const result = await runM1ExecutionProof({
      env: ENV,
      keeperHubClient: fake.client,
      publicClient: rpc,
      evidencePath,
    });

    const evidence = verifiedEvidenceOf(result);
    expect(evidence.executionId).toBe("direct_m1_1");
    expect(evidence.transactionHash).toBe(TX);
    expect(evidence.allowanceBefore).toBe("0");
    expect(evidence.allowanceAfter).toBe("1");
    expect(evidence.sponsored).toBe(false);
    expect(evidence.blockNumber).toBe(42);
    expect(evidence.keeperHubStatus).toBe("completed");
    expect(evidence.onchainReceiptStatus).toBe("success");
    expect(evidence.simulation).toEqual({
      success: true,
      gasEstimate: "65000",
      from: WALLET,
      to: USDC,
    });

    expect(fake.calls.executeCount).toBe(1);
    expect(fake.calls.lastIdempotencyKey?.startsWith(`${M1_IDEMPOTENCY_PREFIX}-`)).toBe(true);

    expect(existsSync(evidencePath)).toBe(true);
    expect(loadM1Evidence(evidencePath)).toEqual(evidence);

    // No secrets ever reach the evidence artifact.
    const serialized = JSON.stringify(evidence);
    expect(serialized).not.toContain(ENV.keeperhubApiKey);
    expect(serialized).not.toContain("Bearer");
    expect(serialized.toLowerCase()).not.toContain("authorization");
  });
});

// ---------------------------------------------------------------------------
// Broadcast and polling failures
// ---------------------------------------------------------------------------

describe("broadcast and polling failures", () => {
  it("fails at the broadcast stage when no executionId is returned", async () => {
    const fake = createFakeKeeperHub({
      submission: makeSubmission({ httpStatus: 500, executionId: null, error: "upstream exploded" }),
    });
    const result = await runM1ExecutionProof({
      env: ENV,
      keeperHubClient: fake.client,
      publicClient: createFakeRpc(),
      evidencePath: newEvidencePath(),
    });

    const failed = failedOf(result);
    expect(failed.stage).toBe("broadcast");
    expect(failed.reason).toContain("upstream exploded");
  });

  it("fails at the execution stage when the status is a terminal failure", async () => {
    const fake = createFakeKeeperHub({
      statusQueue: [makeStatus({ status: "failed", isTerminal: true, transactionHash: null, error: "onchain reverted" })],
    });
    const result = await runM1ExecutionProof({
      env: ENV,
      keeperHubClient: fake.client,
      publicClient: createFakeRpc(),
      evidencePath: newEvidencePath(),
    });

    const failed = failedOf(result);
    expect(failed.stage).toBe("execution");
    expect(failed.reason).toContain("onchain reverted");
    expect(failed.executionId).toBe("direct_m1_1");
  });

  it("fails at the verification stage when completed but no transaction hash", async () => {
    const fake = createFakeKeeperHub({
      statusQueue: [makeStatus({ status: "completed", isTerminal: true, transactionHash: null })],
    });
    const result = await runM1ExecutionProof({
      env: ENV,
      keeperHubClient: fake.client,
      publicClient: createFakeRpc(),
      evidencePath: newEvidencePath(),
    });

    const failed = failedOf(result);
    expect(failed.stage).toBe("verification");
    expect(failed.reason).toContain("no transaction hash");
  });

  it("polls until a terminal state and stops on the first terminal poll", async () => {
    const fake = createFakeKeeperHub({
      statusQueue: [
        makeStatus({ status: "pending", isTerminal: false, transactionHash: null, pollIntervalHintSec: 0 }),
        makeStatus({ executionId: "direct_m1_1", transactionHash: TX }),
      ],
    });
    const rpc = createFakeRpc({ allowanceQueue: [BigInt(0), BigInt(1)] });

    const result = await runM1ExecutionProof({
      env: ENV,
      keeperHubClient: fake.client,
      publicClient: rpc,
      evidencePath: newEvidencePath(),
    });

    const evidence = verifiedEvidenceOf(result);
    expect(evidence.transactionHash).toBe(TX);
    expect(fake.calls.executeCount).toBe(1);
    expect(fake.calls.statusCalls).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// Chain verification failures
// ---------------------------------------------------------------------------

describe("chain verification failures", () => {
  it("fails when the receipt fetch throws", async () => {
    const fake = createFakeKeeperHub();
    const rpc = createFakeRpc({ receiptError: new Error("rpc went away") });
    const result = await runM1ExecutionProof({
      env: ENV,
      keeperHubClient: fake.client,
      publicClient: rpc,
      evidencePath: newEvidencePath(),
    });

    const failed = failedOf(result);
    expect(failed.stage).toBe("verification");
    expect(failed.reason).toContain("Receipt fetch failed");
  });

  it("fails when the receipt status is not success", async () => {
    const fake = createFakeKeeperHub();
    const rpc = createFakeRpc({ receipt: makeReceipt({ status: "reverted" }) });
    const result = await runM1ExecutionProof({
      env: ENV,
      keeperHubClient: fake.client,
      publicClient: rpc,
      evidencePath: newEvidencePath(),
    });

    const failed = failedOf(result);
    expect(failed.stage).toBe("verification");
    expect(failed.reason).toContain("receipt status");
  });

  it("fails when the receipt sender is not the organization wallet", async () => {
    const fake = createFakeKeeperHub();
    const rpc = createFakeRpc({
      receipt: makeReceipt({ from: "0x1111111111111111111111111111111111111111" }),
    });
    const result = await runM1ExecutionProof({
      env: ENV,
      keeperHubClient: fake.client,
      publicClient: rpc,
      evidencePath: newEvidencePath(),
    });

    const failed = failedOf(result);
    expect(failed.stage).toBe("verification");
    expect(failed.reason).toContain("sender");
    expect(failed.reason).toContain(WALLET);
  });

  it("fails when the receipt target is not the canonical USDC", async () => {
    const fake = createFakeKeeperHub();
    const rpc = createFakeRpc({
      receipt: makeReceipt({ from: WALLET, to: "0x2222222222222222222222222222222222222222" }),
    });
    const result = await runM1ExecutionProof({
      env: ENV,
      keeperHubClient: fake.client,
      publicClient: rpc,
      evidencePath: newEvidencePath(),
    });

    const failed = failedOf(result);
    expect(failed.stage).toBe("verification");
    expect(failed.reason).toContain("target");
  });

  it("fails when the post-execution allowance is not 1 even though KeeperHub completed", async () => {
    const fake = createFakeKeeperHub();
    const rpc = createFakeRpc({ allowanceQueue: [BigInt(0), BigInt(2)] });
    const result = await runM1ExecutionProof({
      env: ENV,
      keeperHubClient: fake.client,
      publicClient: rpc,
      evidencePath: newEvidencePath(),
    });

    const failed = failedOf(result);
    expect(failed.stage).toBe("verification");
    expect(failed.reason).toContain("Allowance after");
    expect(failed.reason).toContain("even though KeeperHub reported completed");
  });
});

// ---------------------------------------------------------------------------
// Sponsored execution path
// ---------------------------------------------------------------------------

describe("sponsored execution path", () => {
  const RELAYER = "0x6331eb4571de9284f7e9ead98ac7b0661a091e99";
  const EXECUTOR = "0x5af5194b4b0909eb978e3cf1e25333852277f07d";

  it("verifies a sponsored execution via the onchain Approval event", async () => {
    const fake = createFakeKeeperHub({
      statusQueue: [makeStatus({ sponsored: true })],
    });
    const rpc = createFakeRpc({
      allowanceQueue: [BigInt(0), BigInt(1)],
      receipt: makeReceipt({ from: RELAYER, to: EXECUTOR }),
    });

    const result = await runM1ExecutionProof({
      env: ENV,
      keeperHubClient: fake.client,
      publicClient: rpc,
      evidencePath: newEvidencePath(),
    });

    const evidence = verifiedEvidenceOf(result);
    expect(evidence.sponsored).toBe(true);
    expect(evidence.executorAddress).toBe(EXECUTOR);
    expect(evidence.approvalLog?.owner.toLowerCase()).toBe(WALLET);
    expect(evidence.approvalLog?.spender.toLowerCase()).toBe(POOL.toLowerCase());
    expect(evidence.approvalLog?.value).toBe("1");
  });

  it("fails when the sponsored Approval event has the wrong owner", async () => {
    const fake = createFakeKeeperHub({
      statusQueue: [makeStatus({ sponsored: true })],
    });
    const rpc = createFakeRpc({
      receipt: makeReceipt({
        from: RELAYER,
        to: EXECUTOR,
        logs: [makeApprovalLog("0x9999999999999999999999999999999999999999", POOL, BigInt(1))],
      }),
    });

    const result = await runM1ExecutionProof({
      env: ENV,
      keeperHubClient: fake.client,
      publicClient: rpc,
      evidencePath: newEvidencePath(),
    });

    const failed = failedOf(result);
    expect(failed.stage).toBe("verification");
    expect(failed.reason).toContain("Approval owner");
    expect(failed.reason).toContain(WALLET);
  });

  it("fails when no Approval event exists for the sponsored execution", async () => {
    const fake = createFakeKeeperHub({
      statusQueue: [makeStatus({ sponsored: true })],
    });
    const rpc = createFakeRpc({
      receipt: makeReceipt({ from: RELAYER, to: EXECUTOR, logs: [] }),
    });

    const result = await runM1ExecutionProof({
      env: ENV,
      keeperHubClient: fake.client,
      publicClient: rpc,
      evidencePath: newEvidencePath(),
    });

    const failed = failedOf(result);
    expect(failed.stage).toBe("verification");
    expect(failed.reason).toContain("No Approval event");
  });
});

// ---------------------------------------------------------------------------
// Re-run safety
// ---------------------------------------------------------------------------

describe("re-run safety", () => {
  function partialPrior(overrides: Partial<Record<string, unknown>> = {}): M1Evidence {
    return buildM1Evidence({
      milestone: "M1",
      chainId: 84532,
      network: "Base Sepolia",
      keeperHubWallet: WALLET,
      executionId: "direct_m1_prev",
      transactionHash: TX_PREV,
      transactionLink: `https://sepolia.basescan.org/tx/${TX_PREV}`,
      blockNumber: 40,
      contractAddress: USDC,
      functionName: "approve",
      spender: POOL,
      amountBaseUnits: "1",
      allowanceBefore: "0",
      allowanceAfter: "0",
      gasUsedWei: "90000",
      keeperHubStatus: "completed",
      onchainReceiptStatus: "success",
      executedAt: "2026-01-01T00:00:00.000Z",
      verifiedAt: "2026-01-01T00:00:00.000Z",
      approvalLog: null,
      sponsored: false,
      executorAddress: null,
      ...overrides,
    });
  }

  it("never broadcasts again when evidence is already verified", async () => {
    const evidencePath = newEvidencePath();
    const prior = partialPrior({
      allowanceAfter: "1",
      transactionHash: TX,
      executionId: "direct_m1_1",
    });
    writeM1Evidence(evidencePath, prior);

    const fake = createFakeKeeperHub();
    const result = await runM1ExecutionProof({
      env: ENV,
      keeperHubClient: fake.client,
      publicClient: createFakeRpc(),
      evidencePath,
    });

    expect(result.outcome).toBe("M1_ALREADY_VERIFIED");
    if (result.outcome === "M1_ALREADY_VERIFIED") {
      expect(result.evidence).toEqual(prior);
    }
    expect(fake.calls.executeCount).toBe(0);
    expect(fake.calls.statusCalls).toBe(0);
  });

  it("recovers a prior execution without broadcasting when it is verifiable onchain", async () => {
    const evidencePath = newEvidencePath();
    const priorVerifiedAt = "2026-01-01T00:00:00.000Z";
    writeM1Evidence(evidencePath, partialPrior({ verifiedAt: priorVerifiedAt }));

    const fake = createFakeKeeperHub({
      statusQueue: [makeStatus({ executionId: "direct_m1_prev", transactionHash: TX_PREV })],
    });
    const rpc = createFakeRpc({ allowanceQueue: [BigInt(1)] });

    const result = await runM1ExecutionProof({
      env: ENV,
      keeperHubClient: fake.client,
      publicClient: rpc,
      evidencePath,
    });

    const evidence = verifiedEvidenceOf(result);
    expect(fake.calls.executeCount).toBe(0);
    expect(fake.calls.statusCalls).toBe(1);
    expect(evidence.executionId).toBe("direct_m1_prev");
    expect(evidence.transactionHash).toBe(TX_PREV);
    expect(evidence.allowanceAfter).toBe("1");
    expect(evidence.verifiedAt).not.toBe(priorVerifiedAt);

    const reloaded = loadM1Evidence(evidencePath);
    expect(reloaded).toEqual(evidence);
  });

  it("blocks when the prior execution is still unresolved", async () => {
    const evidencePath = newEvidencePath();
    writeM1Evidence(evidencePath, partialPrior());

    const fake = createFakeKeeperHub({
      statusQueue: [makeStatus({ status: "pending", isTerminal: false, transactionHash: null, pollIntervalHintSec: 0 })],
    });

    const result = await runM1ExecutionProof({
      env: ENV,
      keeperHubClient: fake.client,
      publicClient: createFakeRpc(),
      evidencePath,
    });

    const blocked = blockedOf(result);
    expect(blocked.stage).toBe("prior-execution-unresolved");
    expect(fake.calls.executeCount).toBe(0);
  });

  it("falls through to a fresh flow when the prior execution terminally failed", async () => {
    const evidencePath = newEvidencePath();
    writeM1Evidence(evidencePath, partialPrior());

    const fake = createFakeKeeperHub({
      statusQueue: [
        makeStatus({ status: "failed", isTerminal: true, transactionHash: null, error: "prior attempt failed" }),
        makeStatus({ executionId: "direct_m1_1", transactionHash: TX }),
      ],
    });
    const rpc = createFakeRpc({ allowanceQueue: [BigInt(0), BigInt(1)] });

    const result = await runM1ExecutionProof({
      env: ENV,
      keeperHubClient: fake.client,
      publicClient: rpc,
      evidencePath,
    });

    const evidence = verifiedEvidenceOf(result);
    expect(fake.calls.executeCount).toBe(1);
    expect(fake.calls.statusCalls).toBe(2);
    expect(evidence.executionId).toBe("direct_m1_1");
    expect(evidence.transactionHash).toBe(TX);
  });
});
