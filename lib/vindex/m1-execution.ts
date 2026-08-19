// M1 KeeperHub execution proof — fail-closed orchestrator.
// Every gate must pass before a transaction is broadcast; nothing is mocked;
// the API key is never logged or serialized. Evidence only carries public
// onchain fields.

import "server-only";

import { randomUUID } from "node:crypto";
import { decodeEventLog, keccak256, toBytes, type DecodeEventLogReturnType, type TransactionReceipt } from "viem";

import { AAVE_V3_BASE_SEPOLIA, ERC20_ABI } from "./aave-registry";
import { readAaveUsdcAllowance, readNativeBalance } from "./aave-reads";
import { CANONICAL_CHAIN, VINDEX_CHAIN_ID } from "./chain";
import type { VindexEnv } from "./env";
import {
  createKeeperHubClient,
  type ContractCallRequest,
  type KeeperHubClient,
} from "./keeperhub";
import {
  M1_EVIDENCE_FILE,
  buildM1Evidence,
  isVerifiedM1Evidence,
  loadM1Evidence,
  writeM1Evidence,
  type M1Evidence,
} from "./m1-evidence";
import {
  createCanonicalPublicClient,
  readCanonicalChainState,
  type CanonicalReadClient,
} from "./public-client";

export const M1_MIN_GAS_WEI = BigInt("1000000000000000"); // 0.001 ETH buffer for one small contract write
export const M1_POLL_TIMEOUT_MS = 180_000;
export const M1_APPROVE_AMOUNT = "1"; // one base unit of 6-decimal Aave USDC
export const M1_IDEMPOTENCY_PREFIX = "vindex-m1";

export type M1ExecutionResult =
  | { outcome: "M1_ALREADY_VERIFIED"; evidence: M1Evidence }
  | { outcome: "KEEPERHUB_WALLET_NOT_CONFIGURED"; message: string }
  | { outcome: "KEEPERHUB_WALLET_INVALID"; message: string }
  | { outcome: "BLOCKED"; stage: string; reason: string; keeperHubWallet?: string }
  | { outcome: "FAILED"; stage: string; reason: string; executionId?: string; keeperHubWallet?: string }
  | { outcome: "VERIFIED"; evidence: M1Evidence };

export type M1ExecutionOptions = {
  env: VindexEnv;
  keeperHubClient?: KeeperHubClient;
  publicClient?: CanonicalReadClient;
  evidencePath?: string; // default M1_EVIDENCE_FILE
  minGasWei?: bigint; // default M1_MIN_GAS_WEI
  pollMaxMs?: number; // default M1_POLL_TIMEOUT_MS
  now?: () => Date;
};

export const sameAddress = (a: string, b: string): boolean =>
  a.toLowerCase() === b.toLowerCase();

export function isValidGasEstimate(gasEstimate: string | null): boolean {
  if (gasEstimate === null || !/^\d+$/.test(gasEstimate)) {
    return false;
  }
  return BigInt(gasEstimate) > BigInt(0);
}

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

const APPROVAL_TOPIC = keccak256(toBytes("Approval(address,address,uint256)"));

const APPROVAL_EVENT = [
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

type M1OnchainVerification =
  | {
      ok: true;
      receiptStatus: string;
      blockNumber: number;
      approvalLog: M1Evidence["approvalLog"];
      executorAddress: string | null;
    }
  | { ok: false; failureReason: string };

/**
 * Verifies a KeeperHub-reported transaction against the canonical chain:
 * receipt success, then identity checks that depend on the execution mode.
 *
 * - direct (sponsored = false): the top-level transaction sender must be the
 *   organization wallet and the top-level target the canonical Aave USDC;
 *   the Approval log is decoded best-effort and never fatal.
 * - sponsored (sponsored = true): KeeperHub executed via its sponsored
 *   (EIP-7702) path, so the top-level sender/target are KeeperHub's relayer
 *   EOA and executor contract, not the organization wallet. Identity is
 *   proven from the onchain Approval event instead (owner, spender, value).
 *   Per the current KeeperHub docs: "A sponsored execution does not change
 *   your EOA's nonce or native balance... Check the `sponsored` field on the
 *   status response and treat `transactionHash` / `transactionLink` as the
 *   authoritative proof, not EOA-level state."
 *
 * Shared by the main flow and the prior-attempt recovery path.
 */
async function verifyM1Onchain(
  rpc: CanonicalReadClient,
  txHash: string,
  expectedFrom: string, // organization wallet
  expectedTo: string, // canonical Aave USDC
  expectedSpender: string, // canonical Aave Pool
  sponsored: boolean,
): Promise<M1OnchainVerification> {
  let receipt: TransactionReceipt;
  try {
    receipt = await rpc.getTransactionReceipt({ hash: txHash as `0x${string}` });
  } catch (error) {
    return {
      ok: false,
      failureReason: `Receipt fetch failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }

  if (receipt.status !== "success") {
    return {
      ok: false,
      failureReason: `Onchain receipt status is ${receipt.status}, expected success`,
    };
  }

  const blockNumber = Number(receipt.blockNumber);

  if (!sponsored) {
    // Direct execution: the organization wallet is the top-level sender and
    // the canonical USDC the top-level target.
    if (!sameAddress(receipt.from, expectedFrom)) {
      return {
        ok: false,
        failureReason: `Transaction sender ${receipt.from} does not match expected ${expectedFrom}`,
      };
    }
    if (receipt.to === null || !sameAddress(receipt.to, expectedTo)) {
      return {
        ok: false,
        failureReason: `Transaction target ${receipt.to ?? "null"} does not match expected ${expectedTo}`,
      };
    }

    // Optional, best-effort Approval log decode; failure is never fatal.
    let approvalLog: M1Evidence["approvalLog"] = null;
    const approvalLogEntry = receipt.logs.find(
      (log) => sameAddress(log.address, expectedTo) && log.topics[0] === APPROVAL_TOPIC,
    );
    if (approvalLogEntry !== undefined) {
      try {
        const decoded = decodeEventLog({
          abi: APPROVAL_EVENT,
          data: approvalLogEntry.data,
          topics: approvalLogEntry.topics,
        });
        approvalLog = {
          owner: decoded.args.owner,
          spender: decoded.args.spender,
          value: decoded.args.value.toString(),
        };
      } catch {
        approvalLog = null;
      }
    }

    return { ok: true, receiptStatus: receipt.status, blockNumber, approvalLog, executorAddress: null };
  }

  // Sponsored (EIP-7702) execution: the top-level from/to are KeeperHub's
  // sponsor/executor infrastructure, so identity is proven from the onchain
  // Approval event emitted for the organization wallet.
  const approvalLogEntry = receipt.logs.find(
    (log) => sameAddress(log.address, expectedTo) && log.topics[0] === APPROVAL_TOPIC,
  );
  if (approvalLogEntry === undefined) {
    return {
      ok: false,
      failureReason: "No Approval event found on the expected token for the sponsored execution",
    };
  }

  let decoded: DecodeEventLogReturnType<typeof APPROVAL_EVENT>;
  try {
    decoded = decodeEventLog({
      abi: APPROVAL_EVENT,
      data: approvalLogEntry.data,
      topics: approvalLogEntry.topics,
    });
  } catch {
    return { ok: false, failureReason: "Failed to decode the Approval event" };
  }

  if (!sameAddress(decoded.args.owner, expectedFrom)) {
    return {
      ok: false,
      failureReason: `Approval owner ${decoded.args.owner} does not match expected organization wallet ${expectedFrom}`,
    };
  }
  if (!sameAddress(decoded.args.spender, expectedSpender)) {
    return {
      ok: false,
      failureReason: `Approval spender ${decoded.args.spender} does not match expected spender ${expectedSpender}`,
    };
  }
  if (decoded.args.value.toString() !== M1_APPROVE_AMOUNT) {
    return {
      ok: false,
      failureReason: `Approval value ${decoded.args.value.toString()} does not match expected amount ${M1_APPROVE_AMOUNT}`,
    };
  }

  return {
    ok: true,
    receiptStatus: receipt.status,
    blockNumber,
    approvalLog: {
      owner: decoded.args.owner,
      spender: decoded.args.spender,
      value: decoded.args.value.toString(),
    },
    executorAddress: receipt.to,
  };
}

/**
 * Runs the M1 execution proof against the live KeeperHub API and the canonical
 * Base Sepolia chain. Fail-closed: on any uncertain prior attempt, gas
 * shortfall, simulation problem, or verification mismatch, no new transaction
 * is ever broadcast and no evidence is written.
 */
export async function runM1ExecutionProof(
  options: M1ExecutionOptions,
): Promise<M1ExecutionResult> {
  const env = options.env;
  const client: KeeperHubClient =
    options.keeperHubClient ??
    createKeeperHubClient({
      apiKey: env.keeperhubApiKey,
      baseUrl: env.keeperhubApiBaseUrl,
    });
  const rpc: CanonicalReadClient =
    options.publicClient ?? createCanonicalPublicClient(env.baseSepoliaRpcUrl);
  const evidencePath = options.evidencePath ?? M1_EVIDENCE_FILE;
  const now = options.now ?? (() => new Date());
  const minGasWei = options.minGasWei ?? M1_MIN_GAS_WEI;
  const pollMaxMs = options.pollMaxMs ?? M1_POLL_TIMEOUT_MS;

  // --- 2. Re-run safety ------------------------------------------------------
  // A verified M1 never broadcasts again; an unresolved prior attempt blocks;
  // only a provably failed prior attempt falls through to a fresh one.
  const prior = loadM1Evidence(evidencePath);

  if (prior !== null && isVerifiedM1Evidence(prior)) {
    return { outcome: "M1_ALREADY_VERIFIED", evidence: prior };
  }

  if (prior !== null && prior.executionId !== "" && prior.transactionHash !== "") {
    let status;
    try {
      status = await client.getExecutionStatus(prior.executionId);
    } catch {
      return {
        outcome: "BLOCKED",
        stage: "prior-execution-unresolved",
        reason: "Unable to resolve prior M1 execution status; do not broadcast a new transaction.",
        keeperHubWallet: prior.keeperHubWallet,
      };
    }

    if (status.isTerminal && status.status === "completed") {
      const verifyResult = await verifyM1Onchain(
        rpc,
        prior.transactionHash,
        prior.keeperHubWallet,
        prior.contractAddress,
        prior.spender,
        prior.sponsored,
      );
      if (verifyResult.ok) {
        const allowanceAfter = await readAaveUsdcAllowance(
          rpc,
          prior.keeperHubWallet as `0x${string}`,
          AAVE_V3_BASE_SEPOLIA.pool,
        );
        if (allowanceAfter === BigInt(M1_APPROVE_AMOUNT)) {
          const evidence = buildM1Evidence({
            ...prior,
            allowanceAfter: allowanceAfter.toString(),
            verifiedAt: now().toISOString(),
            approvalLog: verifyResult.approvalLog,
            sponsored: prior.sponsored,
            executorAddress: verifyResult.executorAddress,
          });
          writeM1Evidence(evidencePath, evidence);
          return { outcome: "VERIFIED", evidence };
        }
      }
      // Prior transaction did not hold up onchain — fall through to a fresh attempt.
    } else if (status.isTerminal && status.status === "failed") {
      // Terminal failure — a fresh broadcast is safe.
    } else {
      return {
        outcome: "BLOCKED",
        stage: "prior-execution-unresolved",
        reason: "A prior M1 execution is still running; wait for it to settle before broadcasting again.",
        keeperHubWallet: prior.keeperHubWallet,
      };
    }
  }

  // --- 3. Wallet -------------------------------------------------------------
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

  // --- 4. Chain --------------------------------------------------------------
  try {
    await readCanonicalChainState(rpc);
  } catch (error) {
    return {
      outcome: "BLOCKED",
      stage: "chain",
      reason: error instanceof Error ? error.message : "Failed to read canonical chain state",
      keeperHubWallet: wallet.walletAddress,
    };
  }

  // --- 5. Gas buffer ----------------------------------------------------------
  const balance = await readNativeBalance(rpc, wallet.walletAddress as `0x${string}`);
  if (balance < minGasWei) {
    return {
      outcome: "BLOCKED",
      stage: "gas",
      reason: `Insufficient Base Sepolia ETH on the KeeperHub wallet (${wallet.walletAddress}). Current balance: ${balance.toString()} wei. Required minimum: ${minGasWei.toString()} wei (0.001 ETH). Fund the wallet with Base Sepolia test ETH from a testnet faucet (e.g. https://portal.cdp.coinbase.com/products/faucet), then re-run npm run verify:m1-execution.`,
      keeperHubWallet: wallet.walletAddress,
    };
  }

  // --- 6. Allowance before ----------------------------------------------------
  const allowanceBefore = await readAaveUsdcAllowance(
    rpc,
    wallet.walletAddress as `0x${string}`,
    AAVE_V3_BASE_SEPOLIA.pool,
  );

  // --- 7. Request -------------------------------------------------------------
  // ABI is passed explicitly; no explorer auto-discovery dependency.
  const approveEntry = ERC20_ABI.filter(
    (item) => item.type === "function" && item.name === "approve",
  ).map((item) => ({
    type: item.type,
    name: item.name,
    stateMutability: item.stateMutability,
    inputs: item.inputs,
    outputs: item.outputs,
  }))[0];

  if (!approveEntry) {
    return {
      outcome: "BLOCKED",
      stage: "request",
      reason: "ERC20 approve ABI entry is missing from the registry",
      keeperHubWallet: wallet.walletAddress,
    };
  }

  const callBase: Omit<ContractCallRequest, "simulate"> = {
    contractAddress: AAVE_V3_BASE_SEPOLIA.usdcUnderlying,
    chainId: VINDEX_CHAIN_ID,
    functionName: "approve",
    functionArgs: JSON.stringify([AAVE_V3_BASE_SEPOLIA.pool, M1_APPROVE_AMOUNT]),
    abi: JSON.stringify([approveEntry]),
  };

  // --- 8. Simulate + gate ------------------------------------------------------
  const sim = await client.simulateContractCall(callBase);

  if (sim.wouldRevert) {
    return {
      outcome: "BLOCKED",
      stage: "simulation",
      reason: `Simulation would revert: ${sim.revertReason ?? sim.error ?? "unknown reason"}`,
      keeperHubWallet: wallet.walletAddress,
    };
  }
  if (sim.success !== true) {
    return {
      outcome: "BLOCKED",
      stage: "simulation",
      reason: `Simulation did not succeed: ${sim.error ?? "unknown error"}`,
      keeperHubWallet: wallet.walletAddress,
    };
  }
  if (sim.status !== "simulated") {
    return {
      outcome: "BLOCKED",
      stage: "simulation",
      reason: `Simulation returned unexpected status: ${sim.status ?? "none"}`,
      keeperHubWallet: wallet.walletAddress,
    };
  }
  if (sim.from === null || !sameAddress(sim.from, wallet.walletAddress)) {
    return {
      outcome: "BLOCKED",
      stage: "simulation",
      reason: `Simulation sender mismatch (expected ${wallet.walletAddress}, got ${sim.from ?? "none"})`,
      keeperHubWallet: wallet.walletAddress,
    };
  }
  if (sim.to === null || !sameAddress(sim.to, AAVE_V3_BASE_SEPOLIA.usdcUnderlying)) {
    return {
      outcome: "BLOCKED",
      stage: "simulation",
      reason: `Simulation target mismatch (expected ${AAVE_V3_BASE_SEPOLIA.usdcUnderlying}, got ${sim.to ?? "none"})`,
      keeperHubWallet: wallet.walletAddress,
    };
  }
  if (!isValidGasEstimate(sim.gasEstimate)) {
    return {
      outcome: "BLOCKED",
      stage: "simulation",
      reason: `Simulation produced no valid gas estimate (${sim.gasEstimate ?? "none"})`,
      keeperHubWallet: wallet.walletAddress,
    };
  }

  // --- 9. Broadcast ------------------------------------------------------------
  const submittedAt = now().toISOString();
  const idempotencyKey = `${M1_IDEMPOTENCY_PREFIX}-${randomUUID()}`;
  const sub = await client.executeContractCall(callBase, idempotencyKey);

  if (sub.executionId === null || sub.httpStatus !== 202) {
    return {
      outcome: "FAILED",
      stage: "broadcast",
      reason: `${sub.error ?? "no executionId returned"}${sub.code ? ` (${sub.code})` : ""}`,
      keeperHubWallet: wallet.walletAddress,
    };
  }
  const executionId = sub.executionId;

  // --- 10. Poll to terminal -----------------------------------------------------
  const deadline = Date.now() + pollMaxMs;
  let status = await client.getExecutionStatus(executionId);
  while (!status.isTerminal && Date.now() < deadline) {
    await sleep(status.pollIntervalHintSec * 1000);
    status = await client.getExecutionStatus(executionId);
  }

  if (status.status === "failed") {
    return {
      outcome: "FAILED",
      stage: "execution",
      reason: `KeeperHub execution failed: ${status.error ?? "unknown error"}`,
      executionId,
      keeperHubWallet: wallet.walletAddress,
    };
  }
  if (!status.isTerminal) {
    return {
      outcome: "FAILED",
      stage: "execution",
      reason:
        "KeeperHub execution did not reach a terminal state within the polling timeout; status unresolved — resolve this execution before any re-broadcast",
      executionId,
      keeperHubWallet: wallet.walletAddress,
    };
  }
  if (status.status !== "completed") {
    return {
      outcome: "FAILED",
      stage: "execution",
      reason: `KeeperHub execution ended in unexpected terminal status: ${status.status ?? "none"}`,
      executionId,
      keeperHubWallet: wallet.walletAddress,
    };
  }

  // --- 11. Transaction hash -------------------------------------------------------
  if (status.transactionHash === null) {
    return {
      outcome: "FAILED",
      stage: "verification",
      reason: "KeeperHub reported completed but returned no transaction hash",
      executionId,
      keeperHubWallet: wallet.walletAddress,
    };
  }
  const transactionHash = status.transactionHash;

  // --- 12. Chain verification -----------------------------------------------------
  const verifyResult = await verifyM1Onchain(
    rpc,
    transactionHash,
    wallet.walletAddress,
    AAVE_V3_BASE_SEPOLIA.usdcUnderlying,
    AAVE_V3_BASE_SEPOLIA.pool,
    status.sponsored ?? false,
  );
  if (!verifyResult.ok) {
    return {
      outcome: "FAILED",
      stage: "verification",
      reason: verifyResult.failureReason,
      executionId,
      keeperHubWallet: wallet.walletAddress,
    };
  }

  // --- 13. Allowance after (ultimate gate) -----------------------------------------
  const allowanceAfter = await readAaveUsdcAllowance(
    rpc,
    wallet.walletAddress as `0x${string}`,
    AAVE_V3_BASE_SEPOLIA.pool,
  );
  if (allowanceAfter !== BigInt(M1_APPROVE_AMOUNT)) {
    return {
      outcome: "FAILED",
      stage: "verification",
      reason: `Allowance after execution is ${allowanceAfter.toString()} but required value is 1. M1 FAILS even though KeeperHub reported completed.`,
      executionId,
      keeperHubWallet: wallet.walletAddress,
    };
  }

  // --- 14. Evidence ------------------------------------------------------------------
  const evidence = buildM1Evidence({
    milestone: "M1",
    chainId: VINDEX_CHAIN_ID,
    network: CANONICAL_CHAIN.name,
    keeperHubWallet: wallet.walletAddress,
    executionId,
    transactionHash,
    transactionLink: status.transactionLink,
    blockNumber: verifyResult.blockNumber,
    contractAddress: AAVE_V3_BASE_SEPOLIA.usdcUnderlying,
    functionName: "approve",
    spender: AAVE_V3_BASE_SEPOLIA.pool,
    amountBaseUnits: M1_APPROVE_AMOUNT,
    allowanceBefore: allowanceBefore.toString(),
    allowanceAfter: allowanceAfter.toString(),
    gasUsedWei: status.gasUsedWei,
    keeperHubStatus: "completed",
    onchainReceiptStatus: "success",
    executedAt: submittedAt,
    verifiedAt: now().toISOString(),
    approvalLog: verifyResult.approvalLog,
    simulation: {
      success: sim.success === true,
      gasEstimate: sim.gasEstimate,
      from: sim.from,
      to: sim.to,
    },
    sponsored: status.sponsored ?? false,
    executorAddress: verifyResult.executorAddress,
  });
  writeM1Evidence(evidencePath, evidence);

  return { outcome: "VERIFIED", evidence };
}
