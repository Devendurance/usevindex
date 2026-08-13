// M2 Aave position orchestrator — fail-closed funding -> approval -> supply.
// Every write goes exclusively through KeeperHub; nothing is mocked; the API
// key is never logged or serialized. Simulation evidence is persisted BEFORE
// each broadcast and is never overwritten afterwards.

import "server-only";

import { createHash } from "node:crypto";
import { decodeEventLog, formatUnits, keccak256, toBytes } from "viem";

import { readAaveUsdcAllowance, readNativeBalance } from "./aave-reads";
import { getAaveUsdcPosition } from "./aave-position";
import {
  AAVE_V3_BASE_SEPOLIA,
  AAVE_V3_BASE_SEPOLIA_FAUCET,
  ERC20_ABI,
  FAUCET_ABI,
  M2_SUPPLY_AMOUNT_BASE,
  M2_SUPPLY_MAX_BASE,
  M2_SUPPLY_MIN_BASE,
  POOL_ABI,
  POOL_SUPPLY_EVENT,
} from "./aave-registry";
import { CANONICAL_CHAIN, VINDEX_CHAIN_ID } from "./chain";
import type { VindexEnv } from "./env";
import {
  createKeeperHubClient,
  type ContractCallRequest,
  type ContractCallSimulation,
  type DirectExecutionStatus,
  type KeeperHubClient,
} from "./keeperhub";
import { M1_MIN_GAS_WEI, isValidGasEstimate, sameAddress } from "./m1-execution";
import {
  M2_EVIDENCE_FILE,
  buildM2Evidence,
  isVerifiedM2Evidence,
  loadM2Evidence,
  writeM2Evidence,
  type M2Evidence,
  type M2SimulationRecord,
} from "./m2-evidence";
import { M2_SIMULATIONS_DIR, writeSimulationBeforeBroadcast } from "./m2-simulations";
import {
  createCanonicalPublicClient,
  readCanonicalChainState,
  type CanonicalReadClient,
} from "./public-client";

export const M2_POLL_TIMEOUT_MS = 180_000;

export type M2ExecutionResult =
  | { outcome: "M2_ALREADY_VERIFIED"; evidence: M2Evidence }
  | { outcome: "M2_TOKEN_FUNDING_REQUIRED"; message: string; keeperHubWallet: string }
  | { outcome: "KEEPERHUB_WALLET_NOT_CONFIGURED"; message: string }
  | { outcome: "KEEPERHUB_WALLET_INVALID"; message: string }
  | { outcome: "BLOCKED"; stage: string; reason: string; keeperHubWallet?: string }
  | {
      outcome: "FAILED";
      stage: string;
      reason: string;
      executionId?: string;
      keeperHubWallet?: string;
    }
  | { outcome: "VERIFIED"; evidence: M2Evidence };

export type M2ExecutionOptions = {
  env: VindexEnv;
  keeperHubClient?: KeeperHubClient;
  publicClient?: CanonicalReadClient;
  evidencePath?: string;
  simulationDir?: string;
  supplyAmountBaseUnits?: bigint;
  minGasWei?: bigint;
  pollMaxMs?: number;
  now?: () => Date;
};

export function deriveM2IdempotencyKey(
  operation: "funding" | "approve" | "supply",
  parts: Array<string | bigint | number>,
): string {
  const canonical = parts.map(String).join("|");
  const digest = createHash("sha256").update(canonical).digest("hex");
  return `vindex-m2-${operation}-${digest}`;
}

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

const TRANSFER_TOPIC = keccak256(toBytes("Transfer(address,address,uint256)"));
const SUPPLY_TOPIC = keccak256(toBytes("Supply(address,address,address,uint256,uint16)"));

const ZERO_ADDRESS_PADDED = `0x${"00".repeat(32)}`;

const padAddress = (address: string): string =>
  `0x${address.slice(2).toLowerCase().padStart(64, "0")}`;

type AbiFunctionEntry = {
  type: "function";
  name: string;
  stateMutability: string;
  inputs: readonly { name?: string; type: string }[];
  outputs: readonly { name?: string; type: string }[];
};

const entryOf = (abi: readonly AbiFunctionEntry[], name: string): AbiFunctionEntry | undefined => {
  const entry = abi.find((item) => item.type === "function" && item.name === name);
  if (entry === undefined) return undefined;
  return {
    type: entry.type,
    name: entry.name,
    stateMutability: entry.stateMutability,
    inputs: entry.inputs,
    outputs: entry.outputs,
  };
};

const assertSimulationOk = (
  sim: ContractCallSimulation,
  expectedFrom: string,
  expectedTo: string,
): string | null => {
  if (sim.wouldRevert) {
    return `Simulation would revert: ${sim.revertReason ?? sim.error ?? "unknown reason"}`;
  }
  if (sim.success !== true) {
    return `Simulation did not succeed: ${sim.error ?? "unknown error"}`;
  }
  if (sim.status !== "simulated") {
    return `Simulation returned unexpected status: ${sim.status ?? "none"}`;
  }
  if (sim.from === null || !sameAddress(sim.from, expectedFrom)) {
    return `Simulation sender mismatch (expected ${expectedFrom}, got ${sim.from ?? "none"})`;
  }
  if (sim.to === null || !sameAddress(sim.to, expectedTo)) {
    return `Simulation target mismatch (expected ${expectedTo}, got ${sim.to ?? "none"})`;
  }
  if (!isValidGasEstimate(sim.gasEstimate)) {
    return `Simulation produced no valid gas estimate (${sim.gasEstimate ?? "none"})`;
  }
  return null;
};

type SubmitResult =
  | { ok: true; status: DirectExecutionStatus }
  | { ok: false; reason: string; executionId?: string };

const submitAndSettle = async (
  client: KeeperHubClient,
  body: Omit<ContractCallRequest, "simulate">,
  idempotencyKey: string,
  pollMaxMs: number,
): Promise<SubmitResult> => {
  const sub = await client.executeContractCall(body, idempotencyKey);

  if (sub.executionId === null || sub.httpStatus !== 202) {
    return {
      ok: false,
      reason: `${sub.error ?? "no executionId returned"}${sub.code ? ` (${sub.code})` : ""}`,
      executionId: sub.executionId ?? undefined,
    };
  }
  const executionId = sub.executionId;

  const deadline = Date.now() + pollMaxMs;
  let status = await client.getExecutionStatus(executionId);
  while (!status.isTerminal && Date.now() < deadline) {
    await sleep(status.pollIntervalHintSec * 1000);
    status = await client.getExecutionStatus(executionId);
  }

  if (status.status === "failed") {
    return {
      ok: false,
      reason: `KeeperHub execution failed: ${status.error ?? "unknown error"}`,
      executionId,
    };
  }
  if (!status.isTerminal) {
    return {
      ok: false,
      reason:
        "KeeperHub execution did not reach a terminal state within the polling timeout; status unresolved — resolve this execution before any re-broadcast",
      executionId,
    };
  }
  if (status.status !== "completed") {
    return {
      ok: false,
      reason: `KeeperHub execution ended in unexpected terminal status: ${status.status ?? "none"}`,
      executionId,
    };
  }
  if (status.transactionHash === null) {
    return {
      ok: false,
      reason: "KeeperHub reported completed but returned no transaction hash",
      executionId,
    };
  }
  return { ok: true, status };
};

type OnchainResult<T> = { ok: true; blockNumber: number; receiptStatus: string } & T;
type OnchainFailure = { ok: false; failureReason: string };

const fetchReceipt = async (
  rpc: CanonicalReadClient,
  txHash: string,
): Promise<
  | { ok: true; receipt: import("viem").TransactionReceipt }
  | { ok: false; failureReason: string }
> => {
  try {
    const receipt = await rpc.getTransactionReceipt({ hash: txHash as `0x${string}` });
    if (receipt.status !== "success") {
      return {
        ok: false,
        failureReason: `Onchain receipt status is ${receipt.status}, expected success`,
      };
    }
    return { ok: true, receipt };
  } catch (error) {
    return {
      ok: false,
      failureReason: `Receipt fetch failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
};

type MintOnchainResult = { ok: true; blockNumber: number; receiptStatus: string } | OnchainFailure;

const verifyFundingMintOnchain = async (
  rpc: CanonicalReadClient,
  txHash: string,
  sponsored: boolean,
  expectedFrom: string,
  expectedTo: string,
  expectedWallet: string,
  expectedAmount: bigint,
): Promise<MintOnchainResult> => {
  const fetched = await fetchReceipt(rpc, txHash);
  if (!fetched.ok) return fetched;

  if (!sponsored) {
    if (!sameAddress(fetched.receipt.from, expectedFrom)) {
      return {
        ok: false,
        failureReason: `Transaction sender ${fetched.receipt.from} does not match expected ${expectedFrom}`,
      };
    }
    if (fetched.receipt.to === null || !sameAddress(fetched.receipt.to, expectedTo)) {
      return {
        ok: false,
        failureReason: `Transaction target ${fetched.receipt.to ?? "null"} does not match expected ${expectedTo}`,
      };
    }
  }

  const transferLog = fetched.receipt.logs.find(
    (log) =>
      sameAddress(log.address, AAVE_V3_BASE_SEPOLIA.usdcUnderlying) &&
      log.topics[0] === TRANSFER_TOPIC &&
      log.topics[1] === ZERO_ADDRESS_PADDED &&
      log.topics[2] === padAddress(expectedWallet),
  );
  if (transferLog === undefined) {
    return {
      ok: false,
      failureReason: "Funding mint Transfer event (0x0 -> wallet) not found on the Aave USDC token",
    };
  }
  const minted = BigInt(transferLog.data);
  if (minted !== expectedAmount) {
    return {
      ok: false,
      failureReason: `Funding mint amount mismatch (expected ${expectedAmount}, got ${minted})`,
    };
  }

  return {
    ok: true,
    blockNumber: Number(fetched.receipt.blockNumber),
    receiptStatus: fetched.receipt.status,
  };
};

const verifyApprovalOnchain = async (
  rpc: CanonicalReadClient,
  txHash: string,
  sponsored: boolean,
  expectedFrom: string,
  expectedTo: string,
  expectedSpender: string,
  expectedAmount: bigint,
): Promise<
  | OnchainResult<{ approvalLog: { owner: string; spender: string; value: string } | null }>
  | OnchainFailure
> => {
  const fetched = await fetchReceipt(rpc, txHash);
  if (!fetched.ok) return fetched;

  const approvalTopic = keccak256(toBytes("Approval(address,address,uint256)"));
  const approvalEvent = [
    {
      type: "event",
      name: "Approval",
      inputs: [
        { type: "address", name: "owner", indexed: true },
        { type: "address", name: "spender", indexed: true },
        { type: "uint256", name: "value", indexed: false },
      ],
    },
  ] as const;

  if (!sponsored) {
    if (!sameAddress(fetched.receipt.from, expectedFrom)) {
      return {
        ok: false,
        failureReason: `Transaction sender ${fetched.receipt.from} does not match expected ${expectedFrom}`,
      };
    }
    if (fetched.receipt.to === null || !sameAddress(fetched.receipt.to, expectedTo)) {
      return {
        ok: false,
        failureReason: `Transaction target ${fetched.receipt.to ?? "null"} does not match expected ${expectedTo}`,
      };
    }
  }

  const approvalLogEntry = fetched.receipt.logs.find(
    (log) => sameAddress(log.address, expectedTo) && log.topics[0] === approvalTopic,
  );
  if (approvalLogEntry === undefined) {
    if (sponsored) {
      return {
        ok: false,
        failureReason: "No Approval event found on the expected token for the sponsored execution",
      };
    }
    return {
      ok: true,
      blockNumber: Number(fetched.receipt.blockNumber),
      receiptStatus: fetched.receipt.status,
      approvalLog: null,
    };
  }

  let decoded: { owner: string; spender: string; value: bigint };
  try {
    const result = decodeEventLog({
      abi: approvalEvent,
      data: approvalLogEntry.data,
      topics: approvalLogEntry.topics,
    });
    decoded = result.args as unknown as { owner: string; spender: string; value: bigint };
  } catch {
    if (sponsored) {
      return { ok: false, failureReason: "Failed to decode the Approval event" };
    }
    return {
      ok: true,
      blockNumber: Number(fetched.receipt.blockNumber),
      receiptStatus: fetched.receipt.status,
      approvalLog: null,
    };
  }

  if (sponsored) {
    if (!sameAddress(decoded.owner, expectedFrom)) {
      return {
        ok: false,
        failureReason: `Approval owner ${decoded.owner} does not match expected organization wallet ${expectedFrom}`,
      };
    }
    if (!sameAddress(decoded.spender, expectedSpender)) {
      return {
        ok: false,
        failureReason: `Approval spender ${decoded.spender} does not match expected spender ${expectedSpender}`,
      };
    }
    if (decoded.value !== expectedAmount) {
      return {
        ok: false,
        failureReason: `Approval value ${decoded.value} does not match expected amount ${expectedAmount}`,
      };
    }
  }

  return {
    ok: true,
    blockNumber: Number(fetched.receipt.blockNumber),
    receiptStatus: fetched.receipt.status,
    approvalLog: { owner: decoded.owner, spender: decoded.spender, value: decoded.value.toString() },
  };
};

const verifySupplyOnchain = async (
  rpc: CanonicalReadClient,
  txHash: string,
  sponsored: boolean,
  expectedFrom: string,
  expectedTo: string,
  expectedWallet: string,
  expectedAsset: string,
  expectedAmount: bigint,
): Promise<
  | OnchainResult<{
      supplyLog: {
        reserve: string;
        user: string;
        onBehalfOf: string;
        amount: string;
        referralCode: number;
      } | null;
    }>
  | OnchainFailure
> => {
  const fetched = await fetchReceipt(rpc, txHash);
  if (!fetched.ok) return fetched;

  if (!sponsored) {
    if (!sameAddress(fetched.receipt.from, expectedFrom)) {
      return {
        ok: false,
        failureReason: `Transaction sender ${fetched.receipt.from} does not match expected ${expectedFrom}`,
      };
    }
    if (fetched.receipt.to === null || !sameAddress(fetched.receipt.to, expectedTo)) {
      return {
        ok: false,
        failureReason: `Transaction target ${fetched.receipt.to ?? "null"} does not match expected ${expectedTo}`,
      };
    }
  }

  const supplyLogEntry = fetched.receipt.logs.find(
    (log) => sameAddress(log.address, expectedTo) && log.topics[0] === SUPPLY_TOPIC,
  );
  if (supplyLogEntry === undefined) {
    if (sponsored) {
      return {
        ok: false,
        failureReason: "No Supply event found on the Aave Pool for the sponsored execution",
      };
    }
    return {
      ok: true,
      blockNumber: Number(fetched.receipt.blockNumber),
      receiptStatus: fetched.receipt.status,
      supplyLog: null,
    };
  }

  let supplyLog: {
    reserve: string;
    user: string;
    onBehalfOf: string;
    amount: string;
    referralCode: number;
  };
  try {
    const decoded = decodeEventLog({
      abi: POOL_SUPPLY_EVENT,
      data: supplyLogEntry.data,
      topics: supplyLogEntry.topics,
    });
    const args = decoded.args as {
      reserve: string;
      user: string;
      onBehalfOf: string;
      amount: bigint;
      referralCode: number;
    };
    supplyLog = {
      reserve: args.reserve,
      user: args.user,
      onBehalfOf: args.onBehalfOf,
      amount: args.amount.toString(),
      referralCode: args.referralCode,
    };
  } catch {
    if (sponsored) {
      return { ok: false, failureReason: "Failed to decode the Supply event" };
    }
    return {
      ok: true,
      blockNumber: Number(fetched.receipt.blockNumber),
      receiptStatus: fetched.receipt.status,
      supplyLog: null,
    };
  }

  if (sponsored) {
    if (!sameAddress(supplyLog.reserve, expectedAsset)) {
      return {
        ok: false,
        failureReason: `Supply reserve ${supplyLog.reserve} does not match expected ${expectedAsset}`,
      };
    }
    if (!sameAddress(supplyLog.onBehalfOf, expectedWallet)) {
      return {
        ok: false,
        failureReason: `Supply onBehalfOf ${supplyLog.onBehalfOf} does not match expected wallet ${expectedWallet}`,
      };
    }
    if (BigInt(supplyLog.amount) !== expectedAmount) {
      return {
        ok: false,
        failureReason: `Supply amount ${supplyLog.amount} does not match expected amount ${expectedAmount}`,
      };
    }
  }

  return {
    ok: true,
    blockNumber: Number(fetched.receipt.blockNumber),
    receiptStatus: fetched.receipt.status,
    supplyLog,
  };
};

const simulationRecordFor = (
  intentId: string,
  sim: ContractCallSimulation,
  functionName: string,
  functionArgs: string,
  now: () => Date,
): M2SimulationRecord => ({
  intentId,
  chainId: VINDEX_CHAIN_ID,
  from: sim.from,
  to: sim.to,
  function: functionName,
  functionArgs,
  success: sim.success === true,
  status: sim.status,
  wouldRevert: sim.wouldRevert,
  gasEstimate: sim.gasEstimate,
  simulatedReturnValue: sim.simulatedReturnValue,
  observedAt: now().toISOString(),
});

export async function runM2PositionProof(
  options: M2ExecutionOptions,
): Promise<M2ExecutionResult> {
  const env = options.env;
  const client: KeeperHubClient =
    options.keeperHubClient ??
    createKeeperHubClient({
      apiKey: env.keeperhubApiKey,
      baseUrl: env.keeperhubApiBaseUrl,
    });
  const rpc: CanonicalReadClient =
    options.publicClient ?? createCanonicalPublicClient(env.baseSepoliaRpcUrl);
  const evidencePath = options.evidencePath ?? M2_EVIDENCE_FILE;
  const simulationDir = options.simulationDir ?? M2_SIMULATIONS_DIR;
  const supplyAmount = options.supplyAmountBaseUnits ?? M2_SUPPLY_AMOUNT_BASE;
  const minGasWei = options.minGasWei ?? M1_MIN_GAS_WEI;
  const pollMaxMs = options.pollMaxMs ?? M2_POLL_TIMEOUT_MS;
  const now = options.now ?? (() => new Date());

  const { usdcUnderlying, pool, usdcAToken } = AAVE_V3_BASE_SEPOLIA;

  if (supplyAmount < M2_SUPPLY_MIN_BASE || supplyAmount > M2_SUPPLY_MAX_BASE) {
    return {
      outcome: "BLOCKED",
      stage: "configuration",
      reason: `Supply amount ${supplyAmount} is outside the allowed range (${M2_SUPPLY_MIN_BASE}–${M2_SUPPLY_MAX_BASE} base units = 1–10 USDC)`,
    };
  }

  const wallet = await client.getOrganizationWallet();
  if (!wallet.hasWallet) {
    return {
      outcome: "KEEPERHUB_WALLET_NOT_CONFIGURED",
      message:
        "KEEPERHUB_WALLET_NOT_CONFIGURED — the KeeperHub organization has no wallet. Create one under Wallet Management in the KeeperHub dashboard, then re-run.",
    };
  }
  if (wallet.invalidAddress || wallet.walletAddress === null) {
    return {
      outcome: "KEEPERHUB_WALLET_INVALID",
      message: "KEEPERHUB_WALLET_INVALID — KeeperHub returned an invalid organization wallet address.",
    };
  }
  const walletAddress = wallet.walletAddress;

  try {
    await readCanonicalChainState(rpc);
  } catch (error) {
    return {
      outcome: "BLOCKED",
      stage: "chain",
      reason: error instanceof Error ? error.message : "Failed to read canonical chain state",
      keeperHubWallet: walletAddress,
    };
  }

  // --- Re-run safety ----------------------------------------------------------
  const prior = loadM2Evidence(evidencePath);
  let reusedApproval: M2Evidence["approval"] = null;

  if (prior !== null && isVerifiedM2Evidence(prior)) {
    const live = await getAaveUsdcPosition(rpc, walletAddress as `0x${string}`);
    if (live.aTokenBalanceBaseUnits > BigInt(0)) {
      return { outcome: "M2_ALREADY_VERIFIED", evidence: prior };
    }
    console.warn("Prior M2 evidence is stale — onchain position is empty; re-running M2.");
  } else if (prior !== null && prior.supply?.executionId && prior.supply.transactionHash) {
    let status: DirectExecutionStatus;
    try {
      status = await client.getExecutionStatus(prior.supply.executionId);
    } catch {
      return {
        outcome: "BLOCKED",
        stage: "prior-execution-unresolved",
        reason: "Unable to resolve prior M2 supply status; do not broadcast a new transaction.",
        keeperHubWallet: prior.keeperHubWallet,
      };
    }
    if (status.isTerminal && status.status === "completed") {
      const verifyResult = await verifySupplyOnchain(
        rpc,
        prior.supply.transactionHash,
        prior.supply.sponsored,
        prior.keeperHubWallet,
        pool,
        prior.keeperHubWallet,
        usdcUnderlying,
        BigInt(prior.supplyAmountBaseUnits),
      );
      if (verifyResult.ok) {
        const live = await getAaveUsdcPosition(rpc, prior.keeperHubWallet as `0x${string}`);
        if (live.aTokenBalanceBaseUnits > BigInt(0)) {
          const evidence = buildM2Evidence({
            ...prior,
            supply: { ...prior.supply, receiptVerified: true },
            postState: {
              usdcBalance: live.underlyingBalanceBaseUnits.toString(),
              aUsdcBalance: live.aTokenBalanceBaseUnits.toString(),
              allowance: live.allowanceToPool.toString(),
              blockNumber: live.latestBlockNumber.toString(),
            },
            positionVerified: true,
            verifiedAt: now().toISOString(),
          });
          writeM2Evidence(evidencePath, evidence);
          return { outcome: "VERIFIED", evidence };
        }
      }
      return {
        outcome: "FAILED",
        stage: "verification",
        reason: "Prior supply execution could not be verified onchain",
        executionId: prior.supply.executionId,
        keeperHubWallet: prior.keeperHubWallet,
      };
    }
    if (status.isTerminal && status.status === "failed") {
      // Terminal failure — a fresh attempt is safe.
    } else {
      return {
        outcome: "BLOCKED",
        stage: "prior-execution-unresolved",
        reason: "A prior M2 supply is still running or unresolved; wait for it to settle before broadcasting again.",
        keeperHubWallet: prior.keeperHubWallet,
      };
    }
  } else if (prior !== null && prior.approval?.executionId && prior.approval.transactionHash && prior.supply === null) {
    let status: DirectExecutionStatus;
    try {
      status = await client.getExecutionStatus(prior.approval.executionId);
    } catch {
      return {
        outcome: "BLOCKED",
        stage: "prior-execution-unresolved",
        reason: "Unable to resolve prior M2 approval status; do not broadcast a new transaction.",
        keeperHubWallet: prior.keeperHubWallet,
      };
    }
    if (status.isTerminal && status.status === "completed") {
      const allowance = await readAaveUsdcAllowance(
        rpc,
        walletAddress as `0x${string}`,
        pool,
      );
      if (allowance >= supplyAmount) {
        reusedApproval = { ...prior.approval, allowanceAfter: allowance.toString() };
      }
    } else if (!(status.isTerminal && status.status === "failed")) {
      return {
        outcome: "BLOCKED",
        stage: "prior-execution-unresolved",
        reason: "A prior M2 approval is still running or unresolved; wait for it to settle before broadcasting again.",
        keeperHubWallet: prior.keeperHubWallet,
      };
    }
  }

  // --- Gas ---------------------------------------------------------------------
  const gasBalance = await readNativeBalance(rpc, walletAddress as `0x${string}`);
  if (gasBalance < minGasWei) {
    return {
      outcome: "BLOCKED",
      stage: "gas",
      reason: `Insufficient Base Sepolia ETH on the KeeperHub wallet (${walletAddress}). Current balance: ${gasBalance.toString()} wei. Required minimum: ${minGasWei.toString()} wei (0.001 ETH). Fund the wallet with Base Sepolia test ETH from a testnet faucet (e.g. https://portal.cdp.coinbase.com/products/faucet), then re-run npm run verify:m2-position.`,
      keeperHubWallet: walletAddress,
    };
  }

  // --- Pre-state ----------------------------------------------------------------
  const pos = await getAaveUsdcPosition(rpc, walletAddress as `0x${string}`);

  if (pos.aTokenBalanceBaseUnits > BigInt(0) && prior === null) {
    const evidence = buildM2Evidence({
      milestone: "M2",
      chainId: VINDEX_CHAIN_ID,
      network: CANONICAL_CHAIN.name,
      keeperHubWallet: walletAddress,
      asset: usdcUnderlying,
      aToken: usdcAToken,
      pool,
      faucet: AAVE_V3_BASE_SEPOLIA_FAUCET,
      supplyAmountBaseUnits: supplyAmount.toString(),
      supplyAmountFormatted: formatUnits(supplyAmount, AAVE_V3_BASE_SEPOLIA.usdcDecimals),
      preState: {
        usdcBalance: pos.underlyingBalanceBaseUnits.toString(),
        aUsdcBalance: pos.aTokenBalanceBaseUnits.toString(),
        allowance: pos.allowanceToPool.toString(),
        blockNumber: pos.latestBlockNumber.toString(),
      },
      funding: null,
      approval: null,
      supply: null,
      postState: {
        usdcBalance: pos.underlyingBalanceBaseUnits.toString(),
        aUsdcBalance: pos.aTokenBalanceBaseUnits.toString(),
        allowance: pos.allowanceToPool.toString(),
        blockNumber: pos.latestBlockNumber.toString(),
      },
      positionVerified: true,
      verifiedAt: now().toISOString(),
    });
    writeM2Evidence(evidencePath, evidence);
    return { outcome: "VERIFIED", evidence };
  }

  // --- Funding -------------------------------------------------------------------
  let funding: M2Evidence["funding"] = null;
  if (pos.underlyingBalanceBaseUnits < supplyAmount) {
    const needed = supplyAmount - pos.underlyingBalanceBaseUnits;
    const mintEntry = entryOf(FAUCET_ABI, "mint");
    if (mintEntry === undefined) {
      return {
        outcome: "BLOCKED",
        stage: "funding",
        reason: "FAUCET mint ABI entry is missing from the registry",
        keeperHubWallet: walletAddress,
      };
    }
    const fundingBody: Omit<ContractCallRequest, "simulate"> = {
      contractAddress: AAVE_V3_BASE_SEPOLIA_FAUCET,
      chainId: VINDEX_CHAIN_ID,
      functionName: "mint",
      functionArgs: JSON.stringify([usdcUnderlying, walletAddress, String(needed)]),
      abi: JSON.stringify([mintEntry]),
    };

    const sim = await client.simulateContractCall(fundingBody);
    const gateFailure = assertSimulationOk(sim, 
        walletAddress, AAVE_V3_BASE_SEPOLIA_FAUCET);
    if (gateFailure !== null) {
      if (sim.wouldRevert) {
        return {
          outcome: "M2_TOKEN_FUNDING_REQUIRED",
          keeperHubWallet: walletAddress,
          message: `M2_TOKEN_FUNDING_REQUIRED — the KeeperHub wallet (${walletAddress}) holds 0 Aave-market USDC and the official Aave faucet mint could not complete (${sim.revertReason ?? sim.error ?? "unknown reason"}). Acquisition source: official Aave Base Sepolia faucet ${AAVE_V3_BASE_SEPOLIA_FAUCET} — call mint(address,address,uint256) (permissionless while isPermissioned() == false; per-address cooldown 3600s). Desired amount: ${formatUnits(supplyAmount, AAVE_V3_BASE_SEPOLIA.usdcDecimals)} USDC. If the faucet cooldown blocks you, wait about an hour or fund the wallet directly with the Aave-market USDC (${usdcUnderlying}) from another legitimate source, then re-run npm run verify:m2-position.`,
        };
      }
      return {
        outcome: "BLOCKED",
        stage: "funding-simulation",
        reason: gateFailure,
        keeperHubWallet: walletAddress,
      };
    }

    const simulation = simulationRecordFor("m2-funding", sim, "mint", fundingBody.functionArgs, now);
    try {
      writeSimulationBeforeBroadcast("m2-funding", simulation, simulationDir);
    } catch {
      return {
        outcome: "FAILED",
        stage: "funding",
        reason: "Simulation evidence already persisted for m2-funding — a previous run reached simulation; inspect artifacts before re-running",
        keeperHubWallet: walletAddress,
      };
    }

    const fundingKey = deriveM2IdempotencyKey("funding", [
      VINDEX_CHAIN_ID,
      "faucet-mint",
      AAVE_V3_BASE_SEPOLIA_FAUCET,
      usdcUnderlying,
      
        walletAddress,
      needed,
    ]);
    const settled = await submitAndSettle(client, fundingBody, fundingKey, pollMaxMs);
    if (!settled.ok) {
      return {
        outcome: "FAILED",
        stage: "funding",
        reason: settled.reason,
        executionId: settled.executionId,
        keeperHubWallet: walletAddress,
      };
    }
    const sponsored = settled.status.sponsored ?? false;
    const verifyResult = await verifyFundingMintOnchain(
      rpc,
      settled.status.transactionHash as string,
      sponsored,
      
        walletAddress,
      AAVE_V3_BASE_SEPOLIA_FAUCET,
      
        walletAddress,
      needed,
    );
    if (!verifyResult.ok) {
      return {
        outcome: "FAILED",
        stage: "funding-verification",
        reason: verifyResult.failureReason,
        executionId: settled.status.executionId as string,
        keeperHubWallet: walletAddress,
      };
    }

    const balanceAfter = (
      await getAaveUsdcPosition(rpc, walletAddress as `0x${string}`)
    ).underlyingBalanceBaseUnits;
    if (balanceAfter < supplyAmount) {
      return {
        outcome: "M2_TOKEN_FUNDING_REQUIRED",
        keeperHubWallet: walletAddress,
        message: `M2_TOKEN_FUNDING_REQUIRED — the faucet execution completed but the wallet balance (${balanceAfter.toString()} base units) is still below the supply amount (${supplyAmount.toString()}). Fund the KeeperHub wallet (${walletAddress}) with the Aave-market USDC (${usdcUnderlying}) and re-run npm run verify:m2-position.`,
      };
    }

    funding = {
      required: true,
      simulation,
      executionId: settled.status.executionId as string,
      transactionHash: settled.status.transactionHash as string,
      transactionLink: settled.status.transactionLink,
      sponsored,
      receiptVerified: true,
      blockNumber: verifyResult.blockNumber,
      mintAmountBaseUnits: needed.toString(),
    };
  }

  // --- Approval -------------------------------------------------------------------
  let approval: M2Evidence["approval"] = null;
  if (reusedApproval !== null) {
    approval = reusedApproval;
  } else {
    const allowance = await readAaveUsdcAllowance(rpc, walletAddress as `0x${string}`, pool);
    if (allowance < supplyAmount) {
      const approveEntry = entryOf(ERC20_ABI, "approve");
      if (approveEntry === undefined) {
        return {
          outcome: "BLOCKED",
          stage: "approval",
          reason: "ERC20 approve ABI entry is missing from the registry",
          keeperHubWallet: walletAddress,
        };
      }
      const approveBody: Omit<ContractCallRequest, "simulate"> = {
        contractAddress: usdcUnderlying,
        chainId: VINDEX_CHAIN_ID,
        functionName: "approve",
        functionArgs: JSON.stringify([pool, String(supplyAmount)]),
        abi: JSON.stringify([approveEntry]),
      };

      const sim = await client.simulateContractCall(approveBody);
      const gateFailure = assertSimulationOk(sim, 
        walletAddress, usdcUnderlying);
      if (gateFailure !== null) {
        return {
          outcome: "BLOCKED",
          stage: "approval-simulation",
          reason: gateFailure,
          keeperHubWallet: walletAddress,
        };
      }

      const simulation = simulationRecordFor("m2-approve", sim, "approve", approveBody.functionArgs, now);
      try {
        writeSimulationBeforeBroadcast("m2-approve", simulation, simulationDir);
      } catch {
        return {
          outcome: "FAILED",
          stage: "approval",
          reason: "Simulation evidence already persisted for m2-approve — a previous run reached simulation; inspect artifacts before re-running",
          keeperHubWallet: walletAddress,
        };
      }

      const approveKey = deriveM2IdempotencyKey("approve", [
        VINDEX_CHAIN_ID,
        "approve",
        usdcUnderlying,
        pool,
        supplyAmount,
      ]);
      const settled = await submitAndSettle(client, approveBody, approveKey, pollMaxMs);
      if (!settled.ok) {
        return {
          outcome: "FAILED",
          stage: "approval",
          reason: settled.reason,
          executionId: settled.executionId,
          keeperHubWallet: walletAddress,
        };
      }
      const sponsored = settled.status.sponsored ?? false;
      const verifyResult = await verifyApprovalOnchain(
        rpc,
        settled.status.transactionHash as string,
        sponsored,
        
        walletAddress,
        usdcUnderlying,
        pool,
        supplyAmount,
      );
      if (!verifyResult.ok) {
        return {
          outcome: "FAILED",
          stage: "approval-verification",
          reason: verifyResult.failureReason,
          executionId: settled.status.executionId as string,
          keeperHubWallet: walletAddress,
        };
      }
      const postAllowance = await readAaveUsdcAllowance(
        rpc,
        walletAddress as `0x${string}`,
        pool,
      );
      if (postAllowance < supplyAmount) {
        return {
          outcome: "FAILED",
          stage: "approval-verification",
          reason: `Allowance after approval is ${postAllowance.toString()} but required ${supplyAmount.toString()}`,
          executionId: settled.status.executionId as string,
          keeperHubWallet: walletAddress,
        };
      }
      approval = {
        required: true,
        simulation,
        executionId: settled.status.executionId as string,
        transactionHash: settled.status.transactionHash as string,
        transactionLink: settled.status.transactionLink,
        sponsored,
        receiptVerified: true,
        blockNumber: verifyResult.blockNumber,
        allowanceAfter: postAllowance.toString(),
      };
    }
  }

  // --- Supply pre-broadcast gates ---------------------------------------------------
  const posNow = await getAaveUsdcPosition(rpc, walletAddress as `0x${string}`);
  if (posNow.underlyingBalanceBaseUnits < supplyAmount) {
    return {
      outcome: "BLOCKED",
      stage: "supply",
      reason: `USDC balance at supply time (${posNow.underlyingBalanceBaseUnits.toString()}) is below the supply amount (${supplyAmount.toString()})`,
      keeperHubWallet: walletAddress,
    };
  }
  if (posNow.allowanceToPool < supplyAmount) {
    return {
      outcome: "BLOCKED",
      stage: "supply",
      reason: `Allowance at supply time (${posNow.allowanceToPool.toString()}) is below the supply amount (${supplyAmount.toString()})`,
      keeperHubWallet: walletAddress,
    };
  }
  const aUsdcBefore = posNow.aTokenBalanceBaseUnits;

  // --- Supply ------------------------------------------------------------------------
  const supplyEntry = entryOf(POOL_ABI, "supply");
  if (supplyEntry === undefined) {
    return {
      outcome: "BLOCKED",
      stage: "supply",
      reason: "Aave Pool supply ABI entry is missing from the registry",
      keeperHubWallet: walletAddress,
    };
  }
  const supplyBody: Omit<ContractCallRequest, "simulate"> = {
    contractAddress: pool,
    chainId: VINDEX_CHAIN_ID,
    functionName: "supply",
    functionArgs: JSON.stringify([usdcUnderlying, String(supplyAmount), 
        walletAddress, 0]),
    abi: JSON.stringify([supplyEntry]),
  };

  const sim = await client.simulateContractCall(supplyBody);
  const gateFailure = assertSimulationOk(sim, 
        walletAddress, pool);
  if (gateFailure !== null) {
    return {
      outcome: "BLOCKED",
      stage: "supply-simulation",
      reason: gateFailure,
      keeperHubWallet: walletAddress,
    };
  }

  const simulation = simulationRecordFor("m2-supply", sim, "supply", supplyBody.functionArgs, now);
  try {
    writeSimulationBeforeBroadcast("m2-supply", simulation, simulationDir);
  } catch {
    return {
      outcome: "FAILED",
      stage: "supply",
      reason: "Simulation evidence already persisted for m2-supply — a previous run reached simulation; inspect artifacts before re-running",
      keeperHubWallet: walletAddress,
    };
  }

  const supplyKey = deriveM2IdempotencyKey("supply", [
    VINDEX_CHAIN_ID,
    "supply",
    pool,
    usdcUnderlying,
    supplyAmount,
    
        walletAddress,
  ]);
  const settled = await submitAndSettle(client, supplyBody, supplyKey, pollMaxMs);
  if (!settled.ok) {
    return {
      outcome: "FAILED",
      stage: "supply",
      reason: settled.reason,
      executionId: settled.executionId,
      keeperHubWallet: walletAddress,
    };
  }
  const sponsored = settled.status.sponsored ?? false;
  const verifyResult = await verifySupplyOnchain(
    rpc,
    settled.status.transactionHash as string,
    sponsored,
    
        walletAddress,
    pool,
    
        walletAddress,
    usdcUnderlying,
    supplyAmount,
  );
  if (!verifyResult.ok) {
    return {
      outcome: "FAILED",
      stage: "supply-verification",
      reason: verifyResult.failureReason,
      executionId: settled.status.executionId as string,
      keeperHubWallet: walletAddress,
    };
  }
  const supply: NonNullable<M2Evidence["supply"]> = {
    simulation,
    executionId: settled.status.executionId as string,
    transactionHash: settled.status.transactionHash as string,
    transactionLink: settled.status.transactionLink,
    sponsored,
    receiptVerified: true,
    blockNumber: verifyResult.blockNumber,
  };

  // --- Post-state (ultimate gate) ------------------------------------------------------
  const pos2 = await getAaveUsdcPosition(rpc, walletAddress as `0x${string}`);
  const aUsdcAfter = pos2.aTokenBalanceBaseUnits;
  if (aUsdcAfter <= aUsdcBefore || aUsdcAfter <= BigInt(0) || aUsdcAfter - aUsdcBefore > supplyAmount) {
    return {
      outcome: "FAILED",
      stage: "verification",
      reason: `aUSDC balance did not increase as expected (before ${aUsdcBefore.toString()}, after ${aUsdcAfter.toString()}). M2 FAILS even though KeeperHub reported completed.`,
      executionId: settled.status.executionId as string,
      keeperHubWallet: walletAddress,
    };
  }

  const evidence = buildM2Evidence({
    milestone: "M2",
    chainId: VINDEX_CHAIN_ID,
    network: CANONICAL_CHAIN.name,
    keeperHubWallet: walletAddress,
    asset: usdcUnderlying,
    aToken: usdcAToken,
    pool,
    faucet: AAVE_V3_BASE_SEPOLIA_FAUCET,
    supplyAmountBaseUnits: supplyAmount.toString(),
    supplyAmountFormatted: formatUnits(supplyAmount, AAVE_V3_BASE_SEPOLIA.usdcDecimals),
    preState: {
      usdcBalance: pos.underlyingBalanceBaseUnits.toString(),
      aUsdcBalance: pos.aTokenBalanceBaseUnits.toString(),
      allowance: pos.allowanceToPool.toString(),
      blockNumber: pos.latestBlockNumber.toString(),
    },
    funding,
    approval,
    supply,
    postState: {
      usdcBalance: pos2.underlyingBalanceBaseUnits.toString(),
      aUsdcBalance: pos2.aTokenBalanceBaseUnits.toString(),
      allowance: pos2.allowanceToPool.toString(),
      blockNumber: pos2.latestBlockNumber.toString(),
    },
    positionVerified: true,
    verifiedAt: now().toISOString(),
  });
  writeM2Evidence(evidencePath, evidence);

  return { outcome: "VERIFIED", evidence };
}
