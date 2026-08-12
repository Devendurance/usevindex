// M3 live position service. Single server-authoritative read model for the
// dashboard. Reads live chain state, validates readiness, and persists the
// authoritative snapshot. This module has NO capability to execute chain
// writes — it never imports or calls KeeperHub execution methods.
import "server-only";

import { eq } from "drizzle-orm";
import { formatUnits } from "viem";

import type { VindexDb } from "../../db";
import { protectedPositions } from "../../db/schema";
import { getAaveUsdcPosition } from "./aave-position";
import { readNativeBalance } from "./aave-reads";
import { AAVE_V3_BASE_SEPOLIA, USDC_SYMBOL } from "./aave-registry";
import { CANONICAL_CHAIN, VINDEX_CHAIN_ID, WrongChainError } from "./chain";
import { verifyAaveFoundation } from "./contract-verification";
import { VindexApiError } from "./errors";
import {
  createKeeperHubClient,
  isKeeperHubHealthy,
  type KeeperHubClient,
} from "./keeperhub";
import {
  createCanonicalPublicClient,
  readCanonicalChainState,
  type CanonicalReadClient,
} from "./public-client";
import { getSafeWalletConfig } from "./safe-wallet";
import type { VindexEnv } from "./env";

export const POSITION_FRESHNESS_MAX_AGE_MS = 60_000;

export const canonicalPositionId = (executionWallet: string): string =>
  `base-sepolia:aave-v3:usdc:${executionWallet.toLowerCase()}`;

export type PositionReadiness = {
  networkValid: boolean;
  contractsValid: boolean;
  executionWalletValid: boolean;
  positionExists: boolean;
  safeWalletConfigured: boolean;
  safeWalletValid: boolean;
  keeperHubHealthy: boolean;
  readyForMonitoring: boolean;
};

export type PositionSnapshotModel = {
  position: {
    chainId: number;
    networkName: string;
    protocol: string;
    asset: { symbol: string; label: string; address: string; decimals: number };
    positionToken: { symbol: string; address: string };
    executionWallet: string;
    safeWallet: string | null;
    suppliedBalance: { baseUnits: string; formatted: string };
    executionWalletUsdcBalance: { baseUnits: string; formatted: string };
    executionWalletNativeBalance: { wei: string; formatted: string };
    safeWalletUsdcBalance: { baseUnits: string; formatted: string } | null;
    blockNumber: string;
    blockTimestamp: string | null;
    observedAt: string;
  };
  readiness: PositionReadiness;
  freshness: "live" | "stale" | "unavailable";
  diagnostics: string[];
};

type SnapshotRow = typeof protectedPositions.$inferSelect;

// The canonical public client exposes getBlock; the CanonicalReadClient Pick
// keeps the type surface small, so the block-timestamp read is scoped locally.
type BlockTimestampReader = {
  getBlock: (params: { blockNumber: bigint }) => Promise<{ timestamp: bigint }>;
};

const formatDecimals = (value: bigint, decimals: number): string =>
  formatUnits(value, decimals);

const rowToPosition = (row: SnapshotRow) => ({
  chainId: row.chainId,
  networkName: CANONICAL_CHAIN.name,
  protocol: row.protocol,
  asset: {
    symbol: row.assetSymbol,
    label: `${row.assetSymbol} — Aave Base Sepolia test asset`,
    address: row.assetAddress,
    decimals: row.assetDecimals,
  },
  positionToken: { symbol: "aUSDC", address: row.positionTokenAddress },
  executionWallet: row.executionWallet,
  safeWallet: row.safeWallet,
  suppliedBalance: {
    baseUnits: row.latestPositionAmount,
    formatted: formatDecimals(BigInt(row.latestPositionAmount), row.assetDecimals),
  },
  executionWalletUsdcBalance: {
    baseUnits: row.latestUnderlyingWalletBalance,
    formatted: formatDecimals(BigInt(row.latestUnderlyingWalletBalance), row.assetDecimals),
  },
  executionWalletNativeBalance: {
    wei: row.latestNativeBalanceWei,
    formatted: formatDecimals(BigInt(row.latestNativeBalanceWei), 18),
  },
  safeWalletUsdcBalance: null,
  blockNumber: row.latestBlockNumber,
  blockTimestamp: row.latestBlockTimestamp?.toISOString() ?? null,
  observedAt: row.observedAt.toISOString(),
});

const loadPersistedSnapshot = async (
  db: VindexDb,
  executionWallet: string,
): Promise<SnapshotRow | null> => {
  const rows = await db
    .select()
    .from(protectedPositions)
    .where(eq(protectedPositions.id, canonicalPositionId(executionWallet)))
    .limit(1);
  return rows[0] ?? null;
};

const staleModelFromRow = (row: SnapshotRow): PositionSnapshotModel => {
  const safeWalletConfigured = row.safeWallet !== null;
  const positionExists = BigInt(row.latestPositionAmount) > BigInt(0);
  return {
    position: rowToPosition(row),
    readiness: {
      networkValid: row.chainId === VINDEX_CHAIN_ID,
      contractsValid: false,
      executionWalletValid: row.executionWallet !== "",
      positionExists,
      safeWalletConfigured,
      safeWalletValid: safeWalletConfigured && row.safeWallet !== null,
      keeperHubHealthy: false,
      readyForMonitoring: false,
    },
    freshness: "stale",
    diagnostics: ["Showing the last persisted snapshot — live data is currently unavailable."],
  };
};

export type RefreshOptions = {
  env: VindexEnv;
  db: VindexDb;
  keeperHubClient?: KeeperHubClient;
  publicClient?: CanonicalReadClient;
  now?: () => Date;
};

export const refreshCurrentProtectedPosition = async (
  options: RefreshOptions,
): Promise<PositionSnapshotModel> => {
  const { env, db } = options;
  const now = options.now ?? (() => new Date());
  const observedAt = now();
  const diagnostics: string[] = [];

  const keeperHubClient: KeeperHubClient =
    options.keeperHubClient ??
    createKeeperHubClient({
      apiKey: env.keeperhubApiKey,
      baseUrl: env.keeperhubApiBaseUrl,
    });
  const rpc: CanonicalReadClient =
    options.publicClient ?? createCanonicalPublicClient(env.baseSepoliaRpcUrl);

  // A. Chain — fail closed on wrong chain; RPC down -> stale fallback or error.
  let latestBlock: bigint;
  try {
    latestBlock = (await readCanonicalChainState(rpc)).latestBlock;
  } catch (error) {
    if (error instanceof WrongChainError) {
      throw new VindexApiError("WRONG_CHAIN", "The connected chain is not Base Sepolia (84532).", 502);
    }
    throw new VindexApiError("RPC_UNAVAILABLE", "The Base Sepolia RPC is unavailable.", 502);
  }

  // B. Contracts (foundation verification).
  let contractsValid = false;
  try {
    contractsValid = (await verifyAaveFoundation(rpc)).allPassed;
  } catch {
    contractsValid = false;
  }
  if (!contractsValid) diagnostics.push("Aave contract verification failed.");

  // C. Execution wallet.
  let wallet: string | null = null;
  let executionWalletValid = false;
  try {
    const orgWallet = await keeperHubClient.getOrganizationWallet();
    if (orgWallet.hasWallet && !orgWallet.invalidAddress && orgWallet.walletAddress !== null) {
      wallet = orgWallet.walletAddress;
      executionWalletValid = true;
    } else {
      diagnostics.push(orgWallet.error ?? "KeeperHub organization wallet is not configured.");
    }
  } catch {
    diagnostics.push("KeeperHub wallet discovery failed.");
  }

  // D. Position reads (execution wallet required).
  let positionAmount = BigInt(0);
  let underlyingWalletBalance = BigInt(0);
  let nativeBalanceWei = BigInt(0);
  let allowance = BigInt(0);
  let positionReadOk = false;
  if (wallet !== null) {
    try {
      const position = await getAaveUsdcPosition(rpc, wallet);
      positionAmount = position.aTokenBalanceBaseUnits;
      underlyingWalletBalance = position.underlyingBalanceBaseUnits;
      allowance = position.allowanceToPool;
      latestBlock = position.latestBlockNumber;
      positionReadOk = true;
    } catch {
      diagnostics.push("Live position read failed.");
    }
    try {
      nativeBalanceWei = await readNativeBalance(rpc, wallet as `0x${string}`);
    } catch {
      diagnostics.push("Native balance read failed.");
    }
  }

  // E. Safe wallet config + safe-wallet USDC balance.
  let safeWallet: string | null = null;
  let safeWalletConfigured = false;
  let safeWalletValid = false;
  let safeWalletUsdcBalance: bigint | null = null;
  try {
    const config = await getSafeWalletConfig(db);
    safeWallet = config.safeWallet;
    safeWalletConfigured = config.configured;
    if (safeWallet !== null) {
      try {
        const safePosition = await getAaveUsdcPosition(rpc, safeWallet);
        safeWalletUsdcBalance = safePosition.underlyingBalanceBaseUnits;
        safeWalletValid = true;
      } catch {
        diagnostics.push("Safe-wallet balance read failed.");
      }
    }
  } catch (error) {
    if (error instanceof VindexApiError) throw error;
    diagnostics.push("Safe-wallet configuration read failed.");
  }

  // F. KeeperHub health.
  let keeperHubHealthy = false;
  try {
    keeperHubHealthy = isKeeperHubHealthy(await keeperHubClient.healthCheck());
  } catch {
    diagnostics.push("KeeperHub health check failed.");
  }
  if (!keeperHubHealthy) diagnostics.push("KeeperHub is not authenticated.");

  // G. Block timestamp.
  let blockTimestamp: Date | null = null;
  try {
    const block = await (rpc as unknown as BlockTimestampReader).getBlock({
      blockNumber: latestBlock,
    });
    blockTimestamp = new Date(Number(block.timestamp) * 1000);
  } catch {
    blockTimestamp = null;
  }

  // Never show fabricated zeros: if the live position read failed and a valid
  // persisted snapshot exists, return it labeled STALE instead.
  if (!positionReadOk && wallet !== null) {
    const persisted = await loadPersistedSnapshot(db, wallet);
    if (persisted !== null) return staleModelFromRow(persisted);
    throw new VindexApiError(
      "LIVE_READ_FAILED",
      "Live position data could not be read and no previous snapshot exists.",
      502,
    );
  }

  const positionExists = positionAmount > BigInt(0);
  const safeWalletUsdcBalanceModel =
    safeWalletUsdcBalance !== null
      ? {
          baseUnits: safeWalletUsdcBalance.toString(),
          formatted: formatDecimals(safeWalletUsdcBalance, AAVE_V3_BASE_SEPOLIA.usdcDecimals),
        }
      : null;

  const readyForMonitoring =
    contractsValid &&
    executionWalletValid &&
    positionExists &&
    safeWalletConfigured &&
    safeWalletValid &&
    keeperHubHealthy;

  // Persist the authoritative snapshot (only after a successful live read).
  if (wallet !== null) {
    try {
      await db
        .insert(protectedPositions)
        .values({
          id: canonicalPositionId(wallet),
          chainId: VINDEX_CHAIN_ID,
          protocol: "Aave V3",
          poolAddress: AAVE_V3_BASE_SEPOLIA.pool,
          assetAddress: AAVE_V3_BASE_SEPOLIA.usdcUnderlying,
          assetSymbol: USDC_SYMBOL,
          assetDecimals: AAVE_V3_BASE_SEPOLIA.usdcDecimals,
          positionTokenAddress: AAVE_V3_BASE_SEPOLIA.usdcAToken,
          executionWallet: wallet,
          safeWallet,
          latestPositionAmount: positionAmount.toString(),
          latestUnderlyingWalletBalance: underlyingWalletBalance.toString(),
          latestNativeBalanceWei: nativeBalanceWei.toString(),
          latestAllowance: allowance.toString(),
          latestBlockNumber: latestBlock.toString(),
          latestBlockTimestamp: blockTimestamp,
          observedAt,
          updatedAt: observedAt,
        })
        .onConflictDoUpdate({
          target: protectedPositions.id,
          set: {
            safeWallet,
            latestPositionAmount: positionAmount.toString(),
            latestUnderlyingWalletBalance: underlyingWalletBalance.toString(),
            latestNativeBalanceWei: nativeBalanceWei.toString(),
            latestAllowance: allowance.toString(),
            latestBlockNumber: latestBlock.toString(),
            latestBlockTimestamp: blockTimestamp,
            observedAt,
            updatedAt: observedAt,
          },
        });
    } catch {
      diagnostics.push("Persisting the position snapshot failed.");
    }
  }

  return {
    position: {
      chainId: VINDEX_CHAIN_ID,
      networkName: CANONICAL_CHAIN.name,
      protocol: "Aave V3",
      asset: {
        symbol: USDC_SYMBOL,
        label: `${USDC_SYMBOL} — Aave Base Sepolia test asset`,
        address: AAVE_V3_BASE_SEPOLIA.usdcUnderlying,
        decimals: AAVE_V3_BASE_SEPOLIA.usdcDecimals,
      },
      positionToken: {
        symbol: "aUSDC",
        address: AAVE_V3_BASE_SEPOLIA.usdcAToken,
      },
      executionWallet: wallet ?? "",
      safeWallet,
      suppliedBalance: {
        baseUnits: positionAmount.toString(),
        formatted: formatDecimals(positionAmount, AAVE_V3_BASE_SEPOLIA.usdcDecimals),
      },
      executionWalletUsdcBalance: {
        baseUnits: underlyingWalletBalance.toString(),
        formatted: formatDecimals(underlyingWalletBalance, AAVE_V3_BASE_SEPOLIA.usdcDecimals),
      },
      executionWalletNativeBalance: {
        wei: nativeBalanceWei.toString(),
        formatted: formatDecimals(nativeBalanceWei, 18),
      },
      safeWalletUsdcBalance: safeWalletUsdcBalanceModel,
      blockNumber: latestBlock.toString(),
      blockTimestamp: blockTimestamp?.toISOString() ?? null,
      observedAt: observedAt.toISOString(),
    },
    readiness: {
      networkValid: true,
      contractsValid,
      executionWalletValid,
      positionExists,
      safeWalletConfigured,
      safeWalletValid,
      keeperHubHealthy,
      readyForMonitoring,
    },
    freshness: "live",
    diagnostics,
  };
};

export const getCurrentPositionModel = async (
  options: RefreshOptions,
): Promise<PositionSnapshotModel> => {
  const { env, db } = options;

  let wallet: string | null = null;
  try {
    const client = createKeeperHubClient({
      apiKey: env.keeperhubApiKey,
      baseUrl: env.keeperhubApiBaseUrl,
    });
    const orgWallet = await client.getOrganizationWallet();
    if (orgWallet.hasWallet && orgWallet.walletAddress !== null) {
      wallet = orgWallet.walletAddress;
    }
  } catch {
    wallet = null;
  }

  try {
    // Always derive the model from a live refresh so the readiness flags
    // reflect current chain/health state, not a persisted snapshot.
    return await refreshCurrentProtectedPosition(options);
  } catch (error) {
    if (error instanceof VindexApiError && error.code !== "LIVE_READ_FAILED") throw error;
    if (wallet !== null) {
      try {
        const persisted = await loadPersistedSnapshot(db, wallet);
        if (persisted !== null) return staleModelFromRow(persisted);
      } catch {
        // fall through to POSITION_NOT_FOUND
      }
    }
    throw new VindexApiError("POSITION_NOT_FOUND", "No position snapshot is available yet.", 404);
  }
};
