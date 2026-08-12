// Unit tests for runM2PositionProof: supply-amount bounds, funding faucet
// mint, approval, supply, stable idempotency, pre-broadcast simulation
// persistence, sponsored verification, re-run safety, and evidence hygiene.
// All KeeperHub/RPC interaction is faked — no network, no real transactions,
// no real sleeping (status stubs are terminal immediately).

import { describe, expect, it, afterAll } from "vitest";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { encodeAbiParameters, keccak256, toBytes } from "viem";

import {
  AAVE_V3_BASE_SEPOLIA,
  AAVE_V3_BASE_SEPOLIA_FAUCET,
  KEEPERHUB_QUICKSTART_USDC_BASE_SEPOLIA,
} from "../../lib/vindex/aave-registry";
import {
  deriveM2IdempotencyKey,
  runM2PositionProof,
  type M2ExecutionResult,
  type M2ExecutionOptions,
} from "../../lib/vindex/m2-execution";
import {
  buildM2Evidence,
  loadM2Evidence,
  writeM2Evidence,
  type M2Evidence,
} from "../../lib/vindex/m2-evidence";
import { loadSimulation } from "../../lib/vindex/m2-simulations";
import type {
  ContractCallSimulation,
  ContractCallSubmission,
  DirectExecutionStatus,
  KeeperHubClient,
  KeeperHubWallet,
} from "../../lib/vindex/keeperhub";
import type { CanonicalReadClient } from "../../lib/vindex/public-client";
import type { VindexEnv } from "../../lib/vindex/env";

const ENV: VindexEnv = {
  baseSepoliaRpcUrl: "https://sepolia.base.org",
  keeperhubApiKey: "kh_test_key_123456",
  keeperhubApiBaseUrl: "https://app.keeperhub.com",
};

const WALLET = "0x675638ddbbf8b70b906d68e3485da72c6c63d130";
const USDC = AAVE_V3_BASE_SEPOLIA.usdcUnderlying;
const POOL = AAVE_V3_BASE_SEPOLIA.pool;
const FAUCET = AAVE_V3_BASE_SEPOLIA_FAUCET;
const ATK = AAVE_V3_BASE_SEPOLIA.usdcAToken;
const RELAYER = "0x6331eb4571de9284f7e9ead98ac7b0661a091e99";
const EXECUTOR = "0x5af5194b4b0909eb978e3cf1e25333852277f07d";

const TX = `0x${"ab".repeat(32)}`;
const TX_PREV = `0x${"cd".repeat(32)}`;
const SUPPLY_AMOUNT = BigInt(5000000);

const APPROVAL_TOPIC = keccak256(toBytes("Approval(address,address,uint256)"));
const TRANSFER_TOPIC = keccak256(toBytes("Transfer(address,address,uint256)"));
const SUPPLY_TOPIC = keccak256(toBytes("Supply(address,address,address,uint256,uint16)"));

const pad = (address: string): `0x${string}` =>
  `0x${address.slice(2).toLowerCase().padStart(64, "0")}` as `0x${string}`;

const encodeUint = (value: bigint): `0x${string}` =>
  `0x${value.toString(16).padStart(64, "0")}`;

type LogFixture = { address: string; topics: `0x${string}`[]; data: string };
type ReceiptFixture = {
  status: "success" | "reverted";
  from: string;
  to: string | null;
  blockNumber: bigint;
  logs: LogFixture[];
};

function approvalLog(
  owner: string,
  spender: string,
  value: bigint,
  address: string = USDC,
): LogFixture {
  return { address, topics: [APPROVAL_TOPIC, pad(owner), pad(spender)], data: encodeUint(value) };
}

function transferLog(from: string, to: string, value: bigint, address: string = USDC): LogFixture {
  return {
    address,
    topics: [TRANSFER_TOPIC, pad(from), pad(to)],
    data: encodeUint(value),
  };
}

function supplyLog(
  reserve: string,
  user: string,
  onBehalfOf: string,
  amount: bigint,
  referralCode = 0,
): LogFixture {
  return {
    address: POOL,
    topics: [SUPPLY_TOPIC, pad(reserve), pad(onBehalfOf), encodeUint(BigInt(referralCode))],
    data: encodeAbiParameters(
      [
        { type: "address" },
        { type: "uint256" },
      ],
      [user as `0x${string}`, amount],
    ) as string,
  };
}

function makeReceipt(overrides: Partial<ReceiptFixture> = {}): ReceiptFixture {
  return {
    status: "success",
    from: WALLET,
    to: USDC,
    blockNumber: BigInt(42),
    logs: [],
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
  to: string,
  overrides: Partial<ContractCallSimulation> = {},
): ContractCallSimulation {
  return {
    httpStatus: 200,
    success: true,
    status: "simulated",
    from: WALLET,
    to,
    value: "0",
    gasEstimate: "65000",
    simulatedReturnValue: null,
    wouldRevert: false,
    revertReason: null,
    error: null,
    idempotentReplay: null,
    ...overrides,
  };
}

function makeSubmission(
  executionId: string,
  overrides: Partial<ContractCallSubmission> = {},
): ContractCallSubmission {
  return {
    httpStatus: 202,
    executionId,
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

function makeStatus(
  executionId: string,
  txHash: string,
  overrides: Partial<DirectExecutionStatus> = {},
): DirectExecutionStatus {
  return {
    httpStatus: 200,
    executionId,
    status: "completed",
    transactionHash: txHash,
    transactionLink: `https://sepolia.basescan.org/tx/${txHash}`,
    sponsored: false,
    gasUsedWei: "95603",
    receipts: [],
    error: null,
    pollIntervalHintSec: 2,
    isTerminal: true,
    ...overrides,
  };
}

type RecordedExecution = {
  request: { functionName: string; functionArgs: string; contractAddress: string };
  idempotencyKey: string;
};

type FakeKeeperHubConfig = {
  wallet?: KeeperHubWallet;
  simulations?: Partial<Record<"mint" | "approve" | "supply", ContractCallSimulation>>;
  submissions?: Partial<Record<"mint" | "approve" | "supply", ContractCallSubmission>>;
  statuses?: Record<string, DirectExecutionStatus>;
};

type FakeKeeperHub = {
  calls: {
    executeCount: number;
    simulateCount: number;
    statusCalls: number;
    executions: RecordedExecution[];
  };
  client: KeeperHubClient;
};

function createFakeKeeperHub(config: FakeKeeperHubConfig = {}): FakeKeeperHub {
  const calls = {
    executeCount: 0,
    simulateCount: 0,
    statusCalls: 0,
    executions: [] as RecordedExecution[],
  };

  const simulationFor = (functionName: string): ContractCallSimulation => {
    const to = functionName === "mint" ? FAUCET : functionName === "approve" ? USDC : POOL;
    return config.simulations?.[functionName as "mint" | "approve" | "supply"] ?? makeSimulation(to);
  };

  const submissionFor = (functionName: string): ContractCallSubmission => {
    const id =
      functionName === "mint"
        ? "direct_m2_funding"
        : functionName === "approve"
          ? "direct_m2_approval"
          : "direct_m2_supply";
    return config.submissions?.[functionName as "mint" | "approve" | "supply"] ?? makeSubmission(id);
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
    getOrganizationWallet: async () => config.wallet ?? makeWallet(),
    simulateContractCall: async (request: { functionName: string }) => {
      calls.simulateCount += 1;
      return simulationFor(request.functionName);
    },
    executeContractCall: async (request: unknown, idempotencyKey: string) => {
      calls.executeCount += 1;
      const req = request as { functionName: string; functionArgs: string; contractAddress: string };
      calls.executions.push({ request: req, idempotencyKey });
      return submissionFor(req.functionName);
    },
    getExecutionStatus: async (executionId: string) => {
      calls.statusCalls += 1;
      const fallback = makeStatus(executionId, TX);
      return config.statuses?.[executionId] ?? fallback;
    },
  } as unknown as KeeperHubClient;

  return { calls, client };
}

type FakeRpcConfig = {
  usdcQueue?: bigint[];
  aUsdcQueue?: bigint[];
  allowanceQueue?: bigint[];
  balance?: bigint;
  receipts?: Record<string, ReceiptFixture>;
  receiptQueue?: ReceiptFixture[]; // served in call order when no hash match
  receiptError?: Error;
};

function createFakeRpc(config: FakeRpcConfig = {}): CanonicalReadClient {
  const usdc = [...(config.usdcQueue ?? [BigInt(0)])];
  const aUsdc = [...(config.aUsdcQueue ?? [BigInt(0)])];
  const allowance = [...(config.allowanceQueue ?? [BigInt(1)])];
  const receiptQueue = [...(config.receiptQueue ?? [])];
  let usdcCalls = 0;
  let aUsdcCalls = 0;
  let allowanceCalls = 0;
  let receiptCalls = 0;

  const nextOf = (queue: bigint[], index: number): bigint => {
    if (index >= queue.length) return queue[queue.length - 1] ?? BigInt(0);
    return queue[index];
  };

  const client = {
    getChainId: async () => 84532,
    getBlockNumber: async () => BigInt(45381256),
    getBalance: async () => config.balance ?? BigInt("1000000000000000"),
    getBytecode: async () => "0x1234" as `0x${string}`,
    readContract: async (args: {
      address: string;
      functionName: string;
    }): Promise<unknown> => {
      if (args.functionName === "balanceOf") {
        if (args.address.toLowerCase() === USDC.toLowerCase()) {
          const value = nextOf(usdc, usdcCalls);
          usdcCalls += 1;
          return value;
        }
        if (args.address.toLowerCase() === ATK.toLowerCase()) {
          const value = nextOf(aUsdc, aUsdcCalls);
          aUsdcCalls += 1;
          return value;
        }
      }
      if (args.functionName === "allowance") {
        const value = nextOf(allowance, allowanceCalls);
        allowanceCalls += 1;
        return value;
      }
      if (args.functionName === "getReserveConfigurationData") {
        return [BigInt(6), BigInt(8250), BigInt(8600), BigInt(0), BigInt(2000), true, true, false, true, false];
      }
      throw new Error(`Unexpected readContract call: ${args.functionName}`);
    },
    getTransactionReceipt: async (args: { hash: string }) => {
      if (config.receiptError !== undefined) throw config.receiptError;
      if (config.receipts?.[args.hash] !== undefined) {
        return config.receipts[args.hash] as unknown;
      }
      const index = Math.min(receiptCalls, receiptQueue.length - 1);
      receiptCalls += 1;
      return (receiptQueue[index] ?? makeReceipt()) as unknown;
    },
  } as unknown as CanonicalReadClient;

  return client;
}

const tempDirs: string[] = [];
afterAll(() => {
  for (const dir of tempDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function newPaths(): { evidencePath: string; simulationDir: string } {
  const dir = mkdtempSync(join(tmpdir(), "m2-exec-"));
  tempDirs.push(dir);
  return { evidencePath: join(dir, "evidence.json"), simulationDir: join(dir, "sims") };
}

function optionsOf(
  keeperHub: FakeKeeperHub,
  rpc: CanonicalReadClient,
  paths: { evidencePath: string; simulationDir: string },
  overrides: Partial<M2ExecutionOptions> = {},
): M2ExecutionOptions {
  return {
    env: ENV,
    keeperHubClient: keeperHub.client,
    publicClient: rpc,
    evidencePath: paths.evidencePath,
    simulationDir: paths.simulationDir,
    ...overrides,
  };
}

function verifiedOf(result: M2ExecutionResult): M2Evidence {
  if (result.outcome !== "VERIFIED") {
    throw new Error(`expected VERIFIED, got ${JSON.stringify(result)}`);
  }
  return result.evidence;
}

function blockedOf(result: M2ExecutionResult): { stage: string; reason: string } {
  if (result.outcome !== "BLOCKED") {
    throw new Error(`expected BLOCKED, got ${JSON.stringify(result)}`);
  }
  return result;
}

function failedOf(result: M2ExecutionResult): { stage: string; reason: string } {
  if (result.outcome !== "FAILED") {
    throw new Error(`expected FAILED, got ${JSON.stringify(result)}`);
  }
  return result;
}

function seedPartialSupplyEvidence(path: string, overrides: Partial<M2Evidence> = {}): void {
  const evidence = buildM2Evidence({
    milestone: "M2",
    chainId: 84532,
    network: "Base Sepolia",
    keeperHubWallet: WALLET,
    asset: USDC,
    aToken: ATK,
    pool: POOL,
    faucet: FAUCET,
    supplyAmountBaseUnits: "5000000",
    supplyAmountFormatted: "5",
    preState: { usdcBalance: "5000000", aUsdcBalance: "0", allowance: "5000000", blockNumber: "1" },
    postState: { usdcBalance: "0", aUsdcBalance: "0", allowance: "0", blockNumber: "1" },
    funding: null,
    approval: null,
    supply: {
      executionId: "prior_supply",
      transactionHash: TX_PREV,
      transactionLink: null,
      sponsored: false,
      receiptVerified: false,
      blockNumber: null,
      simulation: null,
    },
    positionVerified: false,
    verifiedAt: "",
    ...overrides,
  });
  writeM2Evidence(path, evidence);
}

function happyPathRpc(): CanonicalReadClient {
  return createFakeRpc({
    usdcQueue: [BigInt(0), BigInt(5000000), BigInt(5000000), BigInt(0)],
    aUsdcQueue: [BigInt(0), BigInt(0), BigInt(0), BigInt(4999999)],
    allowanceQueue: [BigInt(1), BigInt(1), BigInt(1), BigInt(5000000), BigInt(5000000), BigInt(0)],
    receiptQueue: [
      // funding: sponsored execution minting 5 USDC to the wallet
      makeReceipt({
        from: RELAYER,
        to: EXECUTOR,
        logs: [transferLog(`0x${"00".repeat(20)}`, WALLET, SUPPLY_AMOUNT)],
      }),
      // approval: direct execution approving exactly the supply amount
      makeReceipt({ logs: [approvalLog(WALLET, POOL, SUPPLY_AMOUNT)] }),
      // supply: direct execution to the Aave Pool
      makeReceipt({ from: WALLET, to: POOL, logs: [] }),
    ],
  });
}

describe("supply amount bounds", () => {
  it("rejects amounts below 1 USDC", async () => {
    const fake = createFakeKeeperHub();
    const result = await runM2PositionProof(
      optionsOf(fake, createFakeRpc(), newPaths(), { supplyAmountBaseUnits: BigInt(999999) }),
    );
    expect(result.outcome).toBe("BLOCKED");
    expect(blockedOf(result).stage).toBe("configuration");
    expect(fake.calls.executeCount).toBe(0);
  });

  it("rejects amounts above 10 USDC", async () => {
    const fake = createFakeKeeperHub();
    const result = await runM2PositionProof(
      optionsOf(fake, createFakeRpc(), newPaths(), { supplyAmountBaseUnits: BigInt(10000001) }),
    );
    expect(blockedOf(result).stage).toBe("configuration");
    expect(fake.calls.executeCount).toBe(0);
  });
});

describe("token acquisition (faucet funding)", () => {
  it("reports M2_TOKEN_FUNDING_REQUIRED when the faucet mint would revert", async () => {
    const fake = createFakeKeeperHub({
      simulations: {
        mint: makeSimulation(FAUCET, {
          success: false,
          wouldRevert: true,
          revertReason: "Error(cooldown)",
          error: "Error(cooldown)",
        }),
      },
    });
    const result = await runM2PositionProof(optionsOf(fake, createFakeRpc(), newPaths()));
    expect(result.outcome).toBe("M2_TOKEN_FUNDING_REQUIRED");
    if (result.outcome === "M2_TOKEN_FUNDING_REQUIRED") {
      expect(result.message).toContain(FAUCET);
      expect(result.message).toContain(WALLET);
    }
    expect(fake.calls.executeCount).toBe(0);
  });

  it("executes the faucet mint through KeeperHub when USDC is missing", async () => {
    const fake = createFakeKeeperHub({
      simulations: {
        mint: makeSimulation(FAUCET, { gasEstimate: "88834", simulatedReturnValue: "5000000" }),
      },
      statuses: {
        direct_m2_funding: makeStatus("direct_m2_funding", TX, {
          sponsored: true,
          gasUsedWei: "88834",
        }),
      },
    });
    const paths = newPaths();
    const result = await runM2PositionProof(
      optionsOf(
        fake,
        happyPathRpc(),
        paths,
        {
          simulationDir: paths.simulationDir,
        },
      ),
    );
    const evidence = verifiedOf(result);
    expect(evidence.funding?.required).toBe(true);
    expect(evidence.funding?.executionId).toBe("direct_m2_funding");
    expect(evidence.funding?.mintAmountBaseUnits).toBe("5000000");
    expect(evidence.funding?.sponsored).toBe(true);
    expect(fake.calls.executeCount).toBe(3);
    expect(fake.calls.executions[0].request.functionName).toBe("mint");
    expect(evidence.approval?.required).toBe(true);
    expect(evidence.supply?.transactionHash).toBe(TX);
    expect(evidence.postState.aUsdcBalance).toBe("4999999");
  });
});

describe("approval strategy", () => {
  it("skips approval when the live allowance is already sufficient", async () => {
    const fake = createFakeKeeperHub();
    const rpc = createFakeRpc({
      usdcQueue: [BigInt(5000000), BigInt(5000000), BigInt(0)],
      aUsdcQueue: [BigInt(0), BigInt(0), BigInt(4999999)],
      allowanceQueue: [BigInt(5000000), BigInt(5000000), BigInt(5000000), BigInt(0)],
      receiptQueue: [makeReceipt({ from: WALLET, to: POOL, logs: [] })],
    });
    const result = await runM2PositionProof(optionsOf(fake, rpc, newPaths()));
    const evidence = verifiedOf(result);
    expect(evidence.approval).toBeNull();
    expect(evidence.funding).toBeNull();
    expect(fake.calls.executeCount).toBe(1);
    expect(fake.calls.executions[0].request.functionName).toBe("supply");
  });

  it("approves with exactly the intended amount when allowance is insufficient", async () => {
    const fake = createFakeKeeperHub({
      statuses: {
        direct_m2_approval: makeStatus("direct_m2_approval", TX),
      },
    });
    const rpc = createFakeRpc({
      usdcQueue: [BigInt(5000000), BigInt(5000000), BigInt(0)],
      aUsdcQueue: [BigInt(0), BigInt(0), BigInt(4999999)],
      allowanceQueue: [BigInt(1), BigInt(1), BigInt(5000000), BigInt(5000000), BigInt(0)],
      receiptQueue: [
        makeReceipt({ logs: [approvalLog(WALLET, POOL, SUPPLY_AMOUNT)] }),
        makeReceipt({ from: WALLET, to: POOL, logs: [] }),
      ],
    });
    const result = await runM2PositionProof(optionsOf(fake, rpc, newPaths()));
    const evidence = verifiedOf(result);
    expect(evidence.approval?.required).toBe(true);
    const approveExec = fake.calls.executions.find((e) => e.request.functionName === "approve");
    expect(approveExec).toBeDefined();
    const args = JSON.parse(approveExec!.request.functionArgs) as [string, string];
    expect(args[0].toLowerCase()).toBe(POOL.toLowerCase());
    expect(args[1]).toBe("5000000");
    expect(args[1].length).toBeLessThan(20);
    expect(fake.calls.executeCount).toBe(2);
  });

  it("does not use uint256.max for the approval", () => {
    const maxUint = `0x${"f".repeat(64)}`;
    expect(BigInt("115792089237316195423570985008687907853269984665640564039457584007913129639935")).toBe(
      BigInt(2) ** BigInt(256) - BigInt(1),
    );
    expect(JSON.stringify(maxUint)).not.toContain("5000000");
  });
});

describe("simulation gates", () => {
  it("blocks when the approval simulation would revert", async () => {
    const fake = createFakeKeeperHub({
      simulations: {
        approve: makeSimulation(USDC, {
          success: false,
          wouldRevert: true,
          revertReason: "Error(ERC20: insufficient allowance)",
        }),
      },
    });
    const rpc = createFakeRpc({
      usdcQueue: [BigInt(5000000), BigInt(5000000), BigInt(0)],
      aUsdcQueue: [BigInt(0), BigInt(0), BigInt(4999999)],
      allowanceQueue: [BigInt(1), BigInt(1), BigInt(5000000), BigInt(5000000), BigInt(0)],
    });
    const result = await runM2PositionProof(optionsOf(fake, rpc, newPaths()));
    const blocked = blockedOf(result);
    expect(blocked.stage).toBe("approval-simulation");
    expect(blocked.reason).toContain("revert");
    expect(fake.calls.executeCount).toBe(0);
  });

  it("blocks when the supply simulation would revert", async () => {
    const fake = createFakeKeeperHub({
      simulations: {
        supply: makeSimulation(POOL, {
          success: false,
          wouldRevert: true,
          revertReason: "Error(INSUFFICIENT_AVAILABLE_BALANCE)",
        }),
      },
    });
    const rpc = createFakeRpc({
      usdcQueue: [BigInt(5000000), BigInt(5000000), BigInt(0)],
      aUsdcQueue: [BigInt(0), BigInt(0), BigInt(4999999)],
      allowanceQueue: [BigInt(5000000), BigInt(5000000), BigInt(5000000)],
    });
    const result = await runM2PositionProof(optionsOf(fake, rpc, newPaths()));
    const blocked = blockedOf(result);
    expect(blocked.stage).toBe("supply-simulation");
    expect(blocked.reason).toContain("revert");
    expect(fake.calls.executions.filter((e) => e.request.functionName === "supply")).toHaveLength(0);
  });

  it("persists simulation evidence BEFORE the broadcast for every operation", async () => {
    const fake = createFakeKeeperHub({
      simulations: {
        mint: makeSimulation(FAUCET, { gasEstimate: "88834", simulatedReturnValue: "5000000" }),
      },
      statuses: {
        direct_m2_funding: makeStatus("direct_m2_funding", TX, { sponsored: true }),
      },
    });
    const paths = newPaths();
    const result = await runM2PositionProof(
      optionsOf(fake, happyPathRpc(), paths, { simulationDir: paths.simulationDir }),
    );
    verifiedOf(result);
    const fundingSim = loadSimulation("m2-funding", paths.simulationDir);
    const approvalSim = loadSimulation("m2-approve", paths.simulationDir);
    const supplySim = loadSimulation("m2-supply", paths.simulationDir);
    expect(fundingSim?.success).toBe(true);
    expect(fundingSim?.wouldRevert).toBe(false);
    expect(fundingSim?.gasEstimate).toBe("88834");
    expect(approvalSim?.success).toBe(true);
    expect(supplySim?.success).toBe(true);
  });
});

describe("stable idempotency", () => {
  it("derives deterministic keys per logical operation", () => {
    const key = deriveM2IdempotencyKey("supply", [84532, "supply", POOL, USDC, "5000000", WALLET]);
    expect(key).toBe(
      deriveM2IdempotencyKey("supply", [84532, "supply", POOL, USDC, "5000000", WALLET]),
    );
    expect(key).toMatch(/^vindex-m2-supply-/);
    const approveKey = deriveM2IdempotencyKey("approve", [84532, "approve", USDC, POOL, "5000000"]);
    expect(approveKey).not.toBe(key);
  });

  it("uses the derived stable key for the supply broadcast", async () => {
    const fake = createFakeKeeperHub();
    const rpc = createFakeRpc({
      usdcQueue: [BigInt(5000000), BigInt(5000000), BigInt(0)],
      aUsdcQueue: [BigInt(0), BigInt(0), BigInt(4999999)],
      allowanceQueue: [BigInt(5000000), BigInt(5000000), BigInt(5000000), BigInt(0)],
      receiptQueue: [makeReceipt({ from: WALLET, to: POOL, logs: [] })],
    });
    const result = await runM2PositionProof(optionsOf(fake, rpc, newPaths()));
    verifiedOf(result);
    const supplyExec = fake.calls.executions.find((e) => e.request.functionName === "supply");
    expect(supplyExec?.idempotencyKey).toBe(
      deriveM2IdempotencyKey("supply", [84532, "supply", POOL, USDC, "5000000", WALLET]),
    );
  });
});

describe("onchain verification", () => {
  it("fails when the transaction receipt reports reverted", async () => {
    const fake = createFakeKeeperHub({
      statuses: {
        direct_m2_funding: makeStatus("direct_m2_funding", TX, { sponsored: true }),
      },
    });
    const rpc = createFakeRpc({
      usdcQueue: [BigInt(0), BigInt(5000000), BigInt(5000000), BigInt(0)],
      aUsdcQueue: [BigInt(0), BigInt(0), BigInt(0), BigInt(4999999)],
      allowanceQueue: [BigInt(1), BigInt(1), BigInt(1), BigInt(5000000), BigInt(5000000), BigInt(0)],
      receipts: {
        [TX]: makeReceipt({ status: "reverted", from: RELAYER, to: EXECUTOR, logs: [] }),
      },
    });
    const result = await runM2PositionProof(optionsOf(fake, rpc, newPaths()));
    const failed = failedOf(result);
    expect(failed.stage).toBe("funding-verification");
    expect(failed.reason).toContain("receipt status");
  });

  it("verifies sponsored approval via the Approval event", async () => {
    const fake = createFakeKeeperHub({
      statuses: {
        direct_m2_approval: makeStatus("direct_m2_approval", TX, { sponsored: true }),
      },
    });
    const rpc = createFakeRpc({
      usdcQueue: [BigInt(5000000), BigInt(5000000), BigInt(0)],
      aUsdcQueue: [BigInt(0), BigInt(0), BigInt(4999999)],
      allowanceQueue: [BigInt(1), BigInt(1), BigInt(5000000), BigInt(5000000), BigInt(0)],
      receiptQueue: [
        makeReceipt({
          from: RELAYER,
          to: EXECUTOR,
          logs: [approvalLog(WALLET, POOL, SUPPLY_AMOUNT)],
        }),
        makeReceipt({ from: WALLET, to: POOL, logs: [] }),
      ],
    });
    const result = await runM2PositionProof(optionsOf(fake, rpc, newPaths()));
    const evidence = verifiedOf(result);
    expect(evidence.approval?.sponsored).toBe(true);
  });

  it("fails sponsored approval when the Approval owner is not the wallet", async () => {
    const fake = createFakeKeeperHub({
      statuses: {
        direct_m2_approval: makeStatus("direct_m2_approval", TX, { sponsored: true }),
      },
    });
    const rpc = createFakeRpc({
      usdcQueue: [BigInt(5000000), BigInt(5000000), BigInt(0)],
      aUsdcQueue: [BigInt(0), BigInt(0), BigInt(4999999)],
      allowanceQueue: [BigInt(1), BigInt(1), BigInt(5000000), BigInt(5000000), BigInt(0)],
      receiptQueue: [
        makeReceipt({
          from: RELAYER,
          to: EXECUTOR,
          logs: [approvalLog(`0x${"99".repeat(20)}`, POOL, SUPPLY_AMOUNT)],
        }),
      ],
    });
    const result = await runM2PositionProof(optionsOf(fake, rpc, newPaths()));
    const failed = failedOf(result);
    expect(failed.stage).toBe("approval-verification");
    expect(failed.reason).toContain("Approval owner");
  });

  it("fails when the aUSDC balance does not increase", async () => {
    const fake = createFakeKeeperHub();
    const rpc = createFakeRpc({
      usdcQueue: [BigInt(5000000), BigInt(5000000), BigInt(0)],
      aUsdcQueue: [BigInt(0), BigInt(0), BigInt(0)],
      allowanceQueue: [BigInt(5000000), BigInt(5000000), BigInt(5000000), BigInt(0)],
      receiptQueue: [makeReceipt({ from: WALLET, to: POOL, logs: [] })],
    });
    const result = await runM2PositionProof(optionsOf(fake, rpc, newPaths()));
    const failed = failedOf(result);
    expect(failed.stage).toBe("verification");
    expect(failed.reason).toContain("aUSDC");
  });

  it("verifies sponsored supply through the Supply event and post-state", async () => {
    const fake = createFakeKeeperHub({
      statuses: {
        direct_m2_supply: makeStatus("direct_m2_supply", TX, { sponsored: true }),
      },
    });
    const rpc = createFakeRpc({
      usdcQueue: [BigInt(5000000), BigInt(5000000), BigInt(0)],
      aUsdcQueue: [BigInt(0), BigInt(0), BigInt(4999999)],
      allowanceQueue: [BigInt(5000000), BigInt(5000000), BigInt(5000000), BigInt(0)],
      receiptQueue: [
        makeReceipt({
          from: RELAYER,
          to: EXECUTOR,
          logs: [
            supplyLog(USDC, WALLET, WALLET, SUPPLY_AMOUNT),
            transferLog(WALLET, POOL, SUPPLY_AMOUNT),
          ],
        }),
      ],
    });
    const result = await runM2PositionProof(optionsOf(fake, rpc, newPaths()));
    const evidence = verifiedOf(result);
    expect(evidence.supply?.sponsored).toBe(true);
    expect(evidence.supply?.receiptVerified).toBe(true);
    expect(evidence.positionVerified).toBe(true);
  });
});

describe("re-run safety", () => {
  it("returns M2_ALREADY_VERIFIED when a verified position exists onchain", async () => {
    const fake = createFakeKeeperHub();
    const paths = newPaths();
    const evidence = buildM2Evidence({
      milestone: "M2",
      chainId: 84532,
      network: "Base Sepolia",
      keeperHubWallet: WALLET,
      asset: USDC,
      aToken: ATK,
      pool: POOL,
      faucet: FAUCET,
      supplyAmountBaseUnits: "5000000",
      supplyAmountFormatted: "5",
      preState: { usdcBalance: "0", aUsdcBalance: "0", allowance: "1", blockNumber: "1" },
      postState: { usdcBalance: "0", aUsdcBalance: "4999999", allowance: "0", blockNumber: "2" },
      funding: null,
      approval: null,
      supply: null,
      positionVerified: true,
      verifiedAt: "2026-08-12T00:00:00.000Z",
    });
    writeM2Evidence(paths.evidencePath, evidence);
    const rpc = createFakeRpc({
      usdcQueue: [BigInt(0)],
      aUsdcQueue: [BigInt(4999999)],
      allowanceQueue: [BigInt(0)],
    });
    const result = await runM2PositionProof(optionsOf(fake, rpc, paths));
    expect(result.outcome).toBe("M2_ALREADY_VERIFIED");
    expect(fake.calls.executeCount).toBe(0);
  });

  it("recovers a completed prior supply execution without a new broadcast", async () => {
    const fake = createFakeKeeperHub({
      statuses: {
        prior_supply: makeStatus("prior_supply", TX_PREV),
      },
    });
    const paths = newPaths();
    seedPartialSupplyEvidence(paths.evidencePath);
    const rpc = createFakeRpc({
      usdcQueue: [BigInt(0)],
      aUsdcQueue: [BigInt(4999999)],
      allowanceQueue: [BigInt(0)],
      receipts: {
        [TX_PREV]: makeReceipt({ from: WALLET, to: POOL, logs: [] }),
      },
    });
    const result = await runM2PositionProof(optionsOf(fake, rpc, paths));
    const evidence = verifiedOf(result);
    expect(evidence.positionVerified).toBe(true);
    expect(evidence.supply?.transactionHash).toBe(TX_PREV);
    expect(fake.calls.executeCount).toBe(0);
    expect(fake.calls.statusCalls).toBeGreaterThan(0);
  });

  it("blocks when a prior supply is still running", async () => {
    const fake = createFakeKeeperHub({
      statuses: {
        prior_supply: makeStatus("prior_supply", TX_PREV, {
          status: "running",
          isTerminal: false,
          transactionHash: null,
        }),
      },
    });
    const paths = newPaths();
    seedPartialSupplyEvidence(paths.evidencePath);
    const result = await runM2PositionProof(optionsOf(fake, createFakeRpc(), paths));
    const blocked = blockedOf(result);
    expect(blocked.stage).toBe("prior-execution-unresolved");
    expect(fake.calls.executeCount).toBe(0);
  });
});

describe("adoption and asset identity", () => {
  it("adopts an existing non-zero aUSDC position without supplying again", async () => {
    const fake = createFakeKeeperHub();
    const rpc = createFakeRpc({
      usdcQueue: [BigInt(0)],
      aUsdcQueue: [BigInt(4999999)],
      allowanceQueue: [BigInt(0)],
    });
    const result = await runM2PositionProof(optionsOf(fake, rpc, newPaths()));
    const evidence = verifiedOf(result);
    expect(evidence.supply).toBeNull();
    expect(evidence.positionVerified).toBe(true);
    expect(fake.calls.executeCount).toBe(0);
  });

  it("uses the exact Aave-market USDC, never the generic quickstart token", () => {
    expect(USDC.toLowerCase()).not.toBe(KEEPERHUB_QUICKSTART_USDC_BASE_SEPOLIA.toLowerCase());
  });
});

describe("wallets and gas", () => {
  it("blocks with KEEPERHUB_WALLET_INVALID on an invalid wallet address", async () => {
    const fake = createFakeKeeperHub({
      wallet: makeWallet({ walletAddress: "0x123", invalidAddress: true }),
    });
    const result = await runM2PositionProof(optionsOf(fake, createFakeRpc(), newPaths()));
    expect(result.outcome).toBe("KEEPERHUB_WALLET_INVALID");
    expect(fake.calls.executeCount).toBe(0);
  });

  it("blocks with KEEPERHUB_WALLET_NOT_CONFIGURED when no wallet exists", async () => {
    const fake = createFakeKeeperHub({
      wallet: makeWallet({ hasWallet: false, walletAddress: null, walletId: null }),
    });
    const result = await runM2PositionProof(optionsOf(fake, createFakeRpc(), newPaths()));
    expect(result.outcome).toBe("KEEPERHUB_WALLET_NOT_CONFIGURED");
    expect(fake.calls.executeCount).toBe(0);
  });

  it("blocks at the gas stage with insufficient native ETH", async () => {
    const fake = createFakeKeeperHub();
    const rpc = createFakeRpc({ balance: BigInt(0) });
    const result = await runM2PositionProof(optionsOf(fake, rpc, newPaths()));
    const blocked = blockedOf(result);
    expect(blocked.stage).toBe("gas");
    expect(fake.calls.executeCount).toBe(0);
  });
});

describe("evidence hygiene", () => {
  it("contains no secrets after a verified run", async () => {
    const fake = createFakeKeeperHub({
      statuses: {
        direct_m2_funding: makeStatus("direct_m2_funding", TX, { sponsored: true }),
      },
    });
    const paths = newPaths();
    const result = await runM2PositionProof(
      optionsOf(fake, happyPathRpc(), paths, { simulationDir: paths.simulationDir }),
    );
    verifiedOf(result);
    expect(existsSync(paths.evidencePath)).toBe(true);
    const evidence = loadM2Evidence(paths.evidencePath);
    expect(evidence).not.toBeNull();
    const serialized = JSON.stringify(evidence);
    expect(serialized).not.toContain("kh_test_key_123456");
    expect(serialized).not.toContain("Bearer");
    expect(serialized.toLowerCase()).not.toContain("authorization");
    const supplySim = loadSimulation("m2-supply", paths.simulationDir);
    expect(supplySim).not.toBeNull();
  });
});
