// Shared fake KeeperHub + Base Sepolia RPC clients for the D1 demo service
// tests. The KeeperHub fake records every simulate/broadcast/status call so
// tests can assert exactly-once semantics; the RPC fake emulates the Aave
// contracts the services read plus the Transfer/Approval/Supply/Withdraw logs
// the onchain effect verifiers search for. Zero real network or chain writes.

import type {
  KeeperHubClient,
  KeeperHubWallet,
  ContractCallSimulation,
  ContractCallSubmission,
  DirectExecutionStatus,
} from "../../../lib/vindex/keeperhub";
import type { CanonicalReadClient } from "../../../lib/vindex/public-client";
import type { FailoverCanonicalClient } from "../../../lib/vindex/rpc-failover";
import { AAVE_V3_BASE_SEPOLIA } from "../../../lib/vindex/aave-registry";

export const WALLET = "0x675638ddbbf8b70b906d68e3485da72c6c63d130";
export const SAFE_WALLET = "0x2222222222222222222222222222222222222222";
export const USDC = AAVE_V3_BASE_SEPOLIA.usdcUnderlying;
export const ATK = AAVE_V3_BASE_SEPOLIA.usdcAToken;
export const POOL = AAVE_V3_BASE_SEPOLIA.pool;
export const ORACLE = AAVE_V3_BASE_SEPOLIA.aaveOracle;
export const DEBT_TOKEN = `0x${"55".repeat(20)}`;
export const POSITION_ID = `base-sepolia:aave-v3:usdc:${WALLET.toLowerCase()}`;

export const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
export const APPROVAL_TOPIC = "0x8c5be1e5ebec7d5bd14f71427d1e84f3dd0314c0f7b2291e5b200ac8c7c3b925";
export const SUPPLY_TOPIC = "0x2b627736bca15cd5381dcf80b0bf11fd197d01a037c52b927a881a10fb73ba61";
export const WITHDRAW_TOPIC = "0x3115d1449a7b732c986cba18244e897a450f61e1bb8d589cd2e69e6c8924f9f7";

const padAddress = (address: string) => `0x${"00".repeat(12)}${address.slice(2).toLowerCase()}`;
const amountData = (amount: bigint) => `0x${amount.toString(16).padStart(64, "0")}`;

export type DemoChainState = {
  walletAUsdc: bigint;
  safeUsdc: bigint;
  walletUsdc: bigint;
  allowanceToPool: bigint;
  withdrawTxHash: string | null;
  flipOnWithdraw: { wallet: boolean; safe: boolean };
  blockNumber: { value: bigint };
};

export const freshChainState = (overrides: Partial<DemoChainState> = {}): DemoChainState => ({
  walletAUsdc: BigInt(0),
  safeUsdc: BigInt(0),
  walletUsdc: BigInt(0),
  allowanceToPool: BigInt(0),
  withdrawTxHash: null,
  flipOnWithdraw: { wallet: true, safe: true },
  blockNumber: { value: BigInt(45400000) },
  ...overrides,
});

type ReceiptLog = { address: string; topics: string[]; data: string };

export function createFakeRpc(state: DemoChainState): FailoverCanonicalClient & CanonicalReadClient {
  const receiptLogs = (hash: string): ReceiptLog[] => {
    if (state.withdrawTxHash !== null && hash.toLowerCase() === state.withdrawTxHash.toLowerCase()) {
      // The withdrawal drained the execution-wallet position and funded the
      // safe wallet — flip the live balances when the M7 receipt is observed.
      if (state.flipOnWithdraw.wallet) state.walletAUsdc = BigInt(0);
      if (state.flipOnWithdraw.safe) state.safeUsdc = BigInt(5000123);
      return [
        {
          address: POOL,
          topics: [WITHDRAW_TOPIC, padAddress(USDC), padAddress(WALLET), padAddress(SAFE_WALLET)],
          data: amountData(BigInt(5000123)),
        },
      ];
    }
    // A funded/supplied position: once a stage receipt is observed the
    // execution wallet holds 5,000,123 aUSDC (matching the supply amount).
    state.walletAUsdc = BigInt(5000123);
    return [
      {
        address: USDC,
        topics: [TRANSFER_TOPIC, `0x${"00".repeat(32)}`, padAddress(WALLET)],
        data: amountData(BigInt(5000000)),
      },
      {
        address: USDC,
        topics: [APPROVAL_TOPIC, padAddress(WALLET), padAddress(POOL)],
        data: amountData(BigInt(5000000)),
      },
      {
        address: POOL,
        topics: [SUPPLY_TOPIC, padAddress(USDC), padAddress(WALLET)],
        data: amountData(BigInt(5000000)),
      },
    ];
  };

  const client = {
    getChainId: async () => 84532,
    getBlockNumber: async () => state.blockNumber.value++,
    getBytecode: async () => "0x1234" as `0x${string}`,
    getBalance: async () => BigInt(0),
    readContract: async (args: { address: string; functionName: string; args?: string[] }): Promise<unknown> => {
      const owner = (args.args ?? [])[0] ?? "";
      if (args.functionName === "balanceOf") {
        if (args.address.toLowerCase() === USDC.toLowerCase() && owner.toLowerCase() === SAFE_WALLET.toLowerCase()) {
          return state.safeUsdc;
        }
        if (args.address.toLowerCase() === USDC.toLowerCase() && owner.toLowerCase() === WALLET.toLowerCase()) {
          return state.walletUsdc;
        }
        if (args.address.toLowerCase() === ATK.toLowerCase() && owner.toLowerCase() === WALLET.toLowerCase()) {
          return state.walletAUsdc;
        }
        return BigInt(0);
      }
      if (args.functionName === "allowance") return state.allowanceToPool;
      if (args.functionName === "decimals") return BigInt(6);
      if (args.functionName === "symbol") return "USDC";
      if (args.functionName === "totalSupply") {
        if (args.address.toLowerCase() === ATK.toLowerCase()) return BigInt(5000123);
        if (args.address.toLowerCase() === DEBT_TOKEN.toLowerCase()) return BigInt(6154634874505);
        return BigInt(0);
      }
      if (args.functionName === "getAssetPrice") return BigInt(100000000);
      if (args.functionName === "getReserveData") {
        return [
          BigInt(0),
          BigInt(1_000_000_000_000_000_000_000_000_000), // liquidityIndex
          BigInt(1_000_000_000_000_000_000_000_000_000), // currentLiquidityRate
          BigInt(1_000_000_000_000_000_000_000_000_000), // variableBorrowIndex
          BigInt(0), BigInt(0), BigInt(0), BigInt(0),
          ATK,
          `0x${"33".repeat(20)}`,
          DEBT_TOKEN, // variableDebtTokenAddress
          `0x${"44".repeat(20)}`,
          BigInt(0), BigInt(0), BigInt(0),
        ];
      }
      if (args.functionName === "getReserveConfigurationData") {
        return [BigInt(6), BigInt(8250), BigInt(8600), BigInt(0), BigInt(2000), true, true, false, true, false];
      }
      if (args.functionName === "getReserveTokensAddresses") {
        return [ATK, `0x${"33".repeat(20)}`, DEBT_TOKEN];
      }
      if (args.functionName === "getPool") return POOL;
      throw new Error(`Unexpected readContract call: ${args.functionName}`);
    },
    getTransactionReceipt: async ({ hash }: { hash: `0x${string}` }) => ({
      status: "success",
      from: WALLET as `0x${string}`,
      to: POOL as `0x${string}`,
      blockNumber: BigInt(45399100),
      logs: receiptLogs(hash),
    }),
    getBlock: async () => ({ timestamp: BigInt(1784000000) }),
  } as unknown as FailoverCanonicalClient & CanonicalReadClient;
  return client;
}

export type DemoKeeperHubCalls = {
  simulate: Array<{ functionName: string; functionArgs: string }>;
  execute: Array<{ functionName: string; idempotencyKey: string; executionId: string }>;
  status: string[];
};

export function createFakeKeeperHub(options: { withdrawTxHash?: string } = {}): {
  client: KeeperHubClient;
  calls: DemoKeeperHubCalls;
} {
  const calls: DemoKeeperHubCalls = { simulate: [], execute: [], status: [] };
  let counter = 0;
  const wallet: KeeperHubWallet = {
    hasWallet: true,
    walletAddress: WALLET,
    walletId: "wal_1",
    isActive: true,
    invalidAddress: false,
    error: null,
  };
  const txHashFor = (executionId: string) =>
    `0x${executionId.replace(/[^0-9a-f]/gi, "").padEnd(64, "f").slice(0, 64)}` as `0x${string}`;

  const client: KeeperHubClient = {
    healthCheck: async () => ({
      reachable: true,
      authenticated: true,
      keyShape: "kh_org" as const,
      statusCode: 200,
      errorCategory: null,
      checkedAt: "",
    }),
    getOrganizationWallet: async () => wallet,
    simulateContractCall: async (request) => {
      calls.simulate.push({ functionName: request.functionName, functionArgs: request.functionArgs });
      const simulation: ContractCallSimulation = {
        httpStatus: 200,
        success: true,
        status: "simulated",
        from: WALLET,
        to: request.contractAddress,
        value: null,
        gasEstimate: "120000",
        simulatedReturnValue: request.functionName === "withdraw" ? "5000123" : null,
        wouldRevert: false,
        revertReason: null,
        error: null,
        idempotentReplay: null,
      };
      return simulation;
    },
    executeContractCall: async (request, idempotencyKey) => {
      const executionId = `kh_${request.functionName}_${++counter}`;
      calls.execute.push({ functionName: request.functionName, idempotencyKey, executionId });
      const submission: ContractCallSubmission = {
        httpStatus: 202,
        executionId,
        status: "accepted",
        transactionHash: null,
        transactionLink: null,
        error: null,
        code: null,
        retryable: null,
        originalExecutionId: null,
        idempotentReplay: null,
      };
      return submission;
    },
    getExecutionStatus: async (executionId) => {
      calls.status.push(executionId);
      const txHash = options.withdrawTxHash ?? txHashFor(executionId);
      const status: DirectExecutionStatus = {
        httpStatus: 200,
        executionId,
        status: "completed",
        transactionHash: txHash,
        transactionLink: `https://sepolia.basescan.org/tx/${txHash}`,
        sponsored: true,
        gasUsedWei: "100000",
        receipts: [],
        error: null,
        pollIntervalHintSec: 1,
        isTerminal: true,
      };
      return status;
    },
  };
  return { client, calls };
}
