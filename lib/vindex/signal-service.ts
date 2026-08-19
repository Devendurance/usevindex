// M4 live signal ingestion: READ -> NORMALIZE -> PERSIST -> QUERY.
// Observations carry real block provenance and are never threat-scored.
// This module performs NO KeeperHub calls and NO onchain writes.
import "server-only";

import { and, desc, eq } from "drizzle-orm";
import { formatUnits } from "viem";

import type { VindexDb } from "../../db";
import { signalObservations } from "../../db/schema";
import { AAVE_V3_BASE_SEPOLIA, AAVE_RESERVE_DATA_ABI, ORACLE_ABI, POOL_DATA_PROVIDER_ABI, ERC20_ABI, USDC_SYMBOL } from "./aave-registry";
import { CANONICAL_CHAIN, VINDEX_CHAIN_ID } from "./chain";
import { VindexApiError } from "./errors";
import {
  canonicalPositionId,
  refreshCurrentProtectedPosition,
  type PositionSnapshotModel,
} from "./position-service";
import type { CanonicalReadClient } from "./public-client";
import { createFailoverPublicClient } from "./rpc-failover";
import type { VindexEnv } from "./env";

export const SIGNAL_FAMILIES = [
  "ORACLE_PRICE_STATE",
  "AAVE_RESERVE_STATE",
  "POSITION_STATE",
] as const;

export type SignalSourceFamily = (typeof SIGNAL_FAMILIES)[number];

export type SignalMetric =
  | "AAVE_USDC_ORACLE_PRICE"
  | "AAVE_RESERVE_TOTAL_ATOKEN"
  | "AAVE_RESERVE_TOTAL_VARIABLE_DEBT"
  | "AAVE_RESERVE_LIQUIDITY_RATE"
  | "AAVE_RESERVE_LIQUIDITY_INDEX"
  | "POSITION_AUSDC_BALANCE";

export type SignalObservation = {
  id?: string;
  positionId: string;
  chainId: number;
  protocol: string;
  sourceFamily: SignalSourceFamily;
  metric: SignalMetric;
  rawValue: string;
  normalizedValue: string;
  severity: string | null;
  contractAddress: string;
  blockNumber: string;
  blockTimestamp: string | null;
  observedAt: string;
  rpcSource: string;
  metadata: Record<string, unknown>;
};

export const RPC_SOURCE = CANONICAL_CHAIN.name;

export const ORACLE_DECIMALS = 8;
export const RESERVE_RATE_DECIMALS = 27;

// Observations older than this are labeled STALE by the query layer.
export const SIGNAL_FRESHNESS_MAX_AGE_MS = 10 * 60 * 1000;

export const METRIC_META: Record<
  SignalMetric,
  { family: SignalSourceFamily; decimals: number }
> = {
  AAVE_USDC_ORACLE_PRICE: { family: "ORACLE_PRICE_STATE", decimals: ORACLE_DECIMALS },
  AAVE_RESERVE_TOTAL_ATOKEN: { family: "AAVE_RESERVE_STATE", decimals: AAVE_V3_BASE_SEPOLIA.usdcDecimals },
  AAVE_RESERVE_TOTAL_VARIABLE_DEBT: { family: "AAVE_RESERVE_STATE", decimals: AAVE_V3_BASE_SEPOLIA.usdcDecimals },
  AAVE_RESERVE_LIQUIDITY_RATE: { family: "AAVE_RESERVE_STATE", decimals: RESERVE_RATE_DECIMALS },
  AAVE_RESERVE_LIQUIDITY_INDEX: { family: "AAVE_RESERVE_STATE", decimals: RESERVE_RATE_DECIMALS },
  POSITION_AUSDC_BALANCE: { family: "POSITION_STATE", decimals: AAVE_V3_BASE_SEPOLIA.usdcDecimals },
};

export type SignalCollectionOutcome = "COMPLETE" | "PARTIAL" | "FAILED";

export type SignalCollectionResult = {
  outcome: SignalCollectionOutcome;
  chainId: number;
  blockNumber: string;
  blockTimestamp: string | null;
  observedAt: string;
  rpcSource: string;
  positionId: string;
  familiesCollected: SignalSourceFamily[];
  observations: SignalObservation[];
  persistedCount: number;
  duplicateCount: number;
  diagnostics: string[];
};

export type CollectSignalOptions = {
  env: VindexEnv;
  db: VindexDb;
  publicClient?: CanonicalReadClient;
  keeperHubClient?: import("./keeperhub").KeeperHubClient;
  now?: () => Date;
};

const loadPrevious = async (
  db: VindexDb,
  positionId: string,
  metric: SignalMetric,
  contractAddress: string,
): Promise<SignalObservationRow | null> => {
  const rows = await db
    .select()
    .from(signalObservations)
    .where(
      and(
        eq(signalObservations.positionId, positionId),
        eq(signalObservations.metric, metric),
        eq(signalObservations.contractAddress, contractAddress),
      ),
    )
    .orderBy(desc(signalObservations.observedAt))
    .limit(1);
  return rows[0] ?? null;
};

type SignalObservationRow = typeof signalObservations.$inferSelect;

const deltaBetween = (current: string, previous: string | null): string | null => {
  if (previous === null) return null;
  return (BigInt(current) - BigInt(previous)).toString();
};

const elapsedSeconds = (
  currentBlockTimestamp: string | null,
  previousBlockTimestamp: string | null,
): number | null => {
  if (currentBlockTimestamp === null || previousBlockTimestamp === null) return null;
  return Math.max(0, Math.floor((Date.parse(currentBlockTimestamp) - Date.parse(previousBlockTimestamp)) / 1000));
};

export const collectLiveSignalObservations = async (
  options: CollectSignalOptions,
): Promise<SignalCollectionResult> => {
  const { env, db } = options;
  const now = options.now ?? (() => new Date());
  const observedAt = now();
  const diagnostics: string[] = [];
  const observations: SignalObservation[] = [];
  const familiesCollected: SignalSourceFamily[] = [];

  // 1-3. M3 readiness + canonical block (reuses the live position service; a
  // failed readiness gate aborts collection before any observation is made).
  let readinessModel: PositionSnapshotModel;
  try {
    readinessModel = await refreshCurrentProtectedPosition({
      env,
      db,
      publicClient: options.publicClient,
      keeperHubClient: options.keeperHubClient,
      now,
    });
  } catch (error) {
    if (error instanceof VindexApiError && error.code === "WRONG_CHAIN") {
      return {
        outcome: "FAILED",
        chainId: VINDEX_CHAIN_ID,
        blockNumber: "",
        blockTimestamp: null,
        observedAt: observedAt.toISOString(),
        rpcSource: RPC_SOURCE,
        positionId: "",
        familiesCollected,
        observations,
        persistedCount: 0,
        duplicateCount: 0,
        diagnostics: ["Wrong chain — Base Sepolia (84532) required."],
      };
    }
    if (error instanceof VindexApiError && error.code === "RPC_UNAVAILABLE") {
      return {
        outcome: "FAILED",
        chainId: VINDEX_CHAIN_ID,
        blockNumber: "",
        blockTimestamp: null,
        observedAt: observedAt.toISOString(),
        rpcSource: RPC_SOURCE,
        positionId: "",
        familiesCollected,
        observations,
        persistedCount: 0,
        duplicateCount: 0,
        diagnostics: ["Base Sepolia RPC unavailable."],
      };
    }
    return {
      outcome: "FAILED",
      chainId: VINDEX_CHAIN_ID,
      blockNumber: "",
      blockTimestamp: null,
      observedAt: observedAt.toISOString(),
      rpcSource: RPC_SOURCE,
      positionId: "",
      familiesCollected,
      observations,
      persistedCount: 0,
      duplicateCount: 0,
      diagnostics: [error instanceof Error ? error.message : "Collection failed."],
    };
  }

  const readiness = readinessModel.readiness;
  const positionId = canonicalPositionId(readinessModel.position.executionWallet);
  const blockNumber = readinessModel.position.blockNumber;
  const blockTimestamp = readinessModel.position.blockTimestamp;

  if (!readiness.networkValid) {
    return failedBatch(positionId, blockNumber, blockTimestamp, observedAt, ["Network not verified."]);
  }
  if (!readiness.contractsValid) {
    return failedBatch(positionId, blockNumber, blockTimestamp, observedAt, ["Aave contracts not verified."]);
  }
  if (!readiness.executionWalletValid) {
    return failedBatch(positionId, blockNumber, blockTimestamp, observedAt, ["KeeperHub execution wallet invalid."]);
  }
  if (!readiness.positionExists) {
    return failedBatch(positionId, blockNumber, blockTimestamp, observedAt, ["No current protected position (aUSDC = 0)."]);
  }
  if (!readiness.safeWalletConfigured || !readiness.safeWalletValid) {
    return failedBatch(positionId, blockNumber, blockTimestamp, observedAt, ["Safe wallet not configured."]);
  }
  if (!readiness.keeperHubHealthy) {
    diagnostics.push("KeeperHub health check failed — observations are still collectible.");
  }

  const rpc: CanonicalReadClient =
    options.publicClient ?? (createFailoverPublicClient(process.env) as unknown as CanonicalReadClient);
  const {
    pool,
    aaveOracle,
    usdcUnderlying,
    usdcAToken,
    aaveProtocolDataProvider,
  } = AAVE_V3_BASE_SEPOLIA;

  const buildObservation = async (
    metric: SignalMetric,
    rawValue: bigint | string,
    contractAddress: string,
    extraMetadata: Record<string, unknown> = {},
  ): Promise<SignalObservation | null> => {
    const raw = typeof rawValue === "bigint" ? rawValue.toString() : rawValue;
    const meta = METRIC_META[metric];
    const previous = await loadPrevious(db, positionId, metric, contractAddress);
    const metadata: Record<string, unknown> = {
      decimals: meta.decimals,
      formatted: formatUnits(BigInt(raw), meta.decimals),
      ...extraMetadata,
    };
    const delta = deltaBetween(raw, previous?.rawValue ?? null);
    if (previous !== null) {
      metadata.previousValue = previous.rawValue;
      metadata.previousBlockNumber = previous.blockNumber;
      if (delta !== null) metadata.delta = delta;
      const elapsed = elapsedSeconds(blockTimestamp, previous.blockTimestamp?.toISOString() ?? null);
      if (elapsed !== null) metadata.elapsedSeconds = elapsed;
    }
    return {
      positionId,
      chainId: VINDEX_CHAIN_ID,
      protocol: "Aave V3",
      sourceFamily: meta.family,
      metric,
      rawValue: raw,
      normalizedValue: raw,
      severity: null,
      contractAddress,
      blockNumber,
      blockTimestamp,
      observedAt: observedAt.toISOString(),
      rpcSource: RPC_SOURCE,
      metadata,
    };
  };

  const persistedCount = { value: 0 };
  const duplicateCount = { value: 0 };
  const persistObservation = async (observation: SignalObservation): Promise<SignalObservation> => {
    try {
      const inserted = await db
        .insert(signalObservations)
        .values({
          positionId: observation.positionId,
          chainId: observation.chainId,
          protocol: observation.protocol,
          sourceFamily: observation.sourceFamily,
          metric: observation.metric,
          rawValue: observation.rawValue,
          normalizedValue: observation.normalizedValue,
          severity: observation.severity,
          contractAddress: observation.contractAddress,
          blockNumber: observation.blockNumber,
          blockTimestamp: observation.blockTimestamp !== null ? new Date(observation.blockTimestamp) : null,
          observedAt: new Date(observation.observedAt),
          rpcSource: observation.rpcSource,
          metadataJson: JSON.stringify(observation.metadata),
        })
        .onConflictDoNothing()
        .returning({ id: signalObservations.id });
      if (inserted.length === 1) persistedCount.value += 1;
      else duplicateCount.value += 1;
      return { ...observation, id: inserted[0]?.id ?? undefined };
    } catch {
      duplicateCount.value += 1;
      return observation;
    }
  };

  // --- ORACLE_PRICE_STATE -----------------------------------------------------
  try {
    const price = await rpc.readContract({
      address: aaveOracle,
      abi: ORACLE_ABI,
      functionName: "getAssetPrice",
      args: [usdcUnderlying],
    });
    const observation = await buildObservation(
      "AAVE_USDC_ORACLE_PRICE",
      BigInt(price as bigint),
      aaveOracle,
      {
        asset: usdcUnderlying,
        source: "Aave Oracle getAssetPrice(USDC)",
        label: "Aave Oracle Price State/Change",
      },
    );
    if (observation !== null) {
      observations.push(await persistObservation(observation));
      familiesCollected.push("ORACLE_PRICE_STATE");
    }
  } catch (error) {
    diagnostics.push(`Oracle read failed: ${error instanceof Error ? error.message : "unknown"}`);
  }

  // --- AAVE_RESERVE_STATE ------------------------------------------------------
  let reserveOk = false;
  try {
    const [reserveData, reserveConfig, aTokenSupply] = await Promise.all([
      rpc.readContract({
        address: pool,
        abi: AAVE_RESERVE_DATA_ABI,
        functionName: "getReserveData",
        args: [usdcUnderlying],
      }),
      rpc.readContract({
        address: aaveProtocolDataProvider,
        abi: POOL_DATA_PROVIDER_ABI,
        functionName: "getReserveConfigurationData",
        args: [usdcUnderlying],
      }),
      rpc.readContract({
        address: usdcAToken,
        abi: ERC20_ABI,
        functionName: "totalSupply",
      }),
    ]);

    const reserve = reserveData as {
      liquidityIndex: bigint;
      currentLiquidityRate: bigint;
      variableDebtTokenAddress: string;
    };
    const liquidityIndex = reserve.liquidityIndex;
    const currentLiquidityRate = reserve.currentLiquidityRate;
    const variableDebtTokenAddress = reserve.variableDebtTokenAddress as `0x${string}`;

    let variableDebtSupplyValue: bigint;
    try {
      variableDebtSupplyValue = BigInt(
        (await rpc.readContract({
          address: variableDebtTokenAddress,
          abi: ERC20_ABI,
          functionName: "totalSupply",
        })) as bigint,
      );
    } catch {
      variableDebtSupplyValue = BigInt(0);
      diagnostics.push("Variable debt token totalSupply read failed.");
    }

    const [, , , , , usageAsCollateralEnabled, borrowingEnabled, stableBorrowRateEnabled, isActive, isFrozen] =
      reserveConfig as [
        bigint, bigint, bigint, bigint, bigint, boolean, boolean, boolean, boolean, boolean,
      ];

    const booleans = {
      isActive,
      isFrozen,
      borrowingEnabled,
      usageAsCollateralEnabled,
      stableBorrowRateEnabled,
      // getPaused() reverts on this deployment — omitted rather than fabricated.
      isPausedUnavailable: "getPaused() reverts on the deployed Base Sepolia Pool",
    };

    const reserveObservations = await Promise.all([
      buildObservation("AAVE_RESERVE_TOTAL_ATOKEN", BigInt(aTokenSupply as bigint), usdcAToken, {
        reserve: usdcUnderlying,
        booleans,
        label: "aToken total supply (base units, 6 decimals)",
      }),
      buildObservation("AAVE_RESERVE_TOTAL_VARIABLE_DEBT", variableDebtSupplyValue, variableDebtTokenAddress, {
        reserve: usdcUnderlying,
        booleans,
        label: "variable debt token total supply (base units, 6 decimals)",
      }),
      buildObservation("AAVE_RESERVE_LIQUIDITY_RATE", currentLiquidityRate, pool, {
        reserve: usdcUnderlying,
        booleans,
        label: "per-second liquidity rate scaled by 1e27",
      }),
      buildObservation("AAVE_RESERVE_LIQUIDITY_INDEX", liquidityIndex, pool, {
        reserve: usdcUnderlying,
        booleans,
        label: "liquidity index scaled by 1e27",
      }),
    ]);

    for (const observation of reserveObservations) {
      if (observation !== null) {
        observations.push(await persistObservation(observation));
        reserveOk = true;
      }
    }
    if (reserveOk) familiesCollected.push("AAVE_RESERVE_STATE");
  } catch (error) {
    diagnostics.push(`Reserve read failed: ${error instanceof Error ? error.message : "unknown"}`);
  }

  // --- POSITION_STATE ----------------------------------------------------------
  try {
    const position = readinessModel.position;
    const observation = await buildObservation(
      "POSITION_AUSDC_BALANCE",
      BigInt(position.suppliedBalance.baseUnits),
      AAVE_V3_BASE_SEPOLIA.usdcAToken,
      {
        owner: position.executionWallet,
        aToken: position.positionToken.address,
        asset: position.asset.address,
        label: "execution wallet aUSDC balance (base units, 6 decimals)",
      },
    );
    if (observation !== null) {
      observations.push(await persistObservation(observation));
      familiesCollected.push("POSITION_STATE");
    }
  } catch (error) {
    diagnostics.push(`Position observation failed: ${error instanceof Error ? error.message : "unknown"}`);
  }

  const outcome: SignalCollectionOutcome =
    familiesCollected.length === SIGNAL_FAMILIES.length
      ? "COMPLETE"
      : familiesCollected.length === 0
        ? "FAILED"
        : "PARTIAL";

  return {
    outcome,
    chainId: VINDEX_CHAIN_ID,
    blockNumber,
    blockTimestamp,
    observedAt: observedAt.toISOString(),
    rpcSource: RPC_SOURCE,
    positionId,
    familiesCollected: [...new Set(familiesCollected)],
    observations,
    persistedCount: persistedCount.value,
    duplicateCount: duplicateCount.value,
    diagnostics,
  };
};

const failedBatch = (
  positionId: string,
  blockNumber: string,
  blockTimestamp: string | null,
  observedAt: Date,
  diagnostics: string[],
): SignalCollectionResult => ({
  outcome: "FAILED",
  chainId: VINDEX_CHAIN_ID,
  blockNumber,
  blockTimestamp,
  observedAt: observedAt.toISOString(),
  rpcSource: RPC_SOURCE,
  positionId,
  familiesCollected: [],
  observations: [],
  persistedCount: 0,
  duplicateCount: 0,
  diagnostics,
});

export type SignalFreshness = "LIVE" | "STALE" | "UNAVAILABLE";

export const getLatestSignalObservations = async (
  db: VindexDb,
  positionId: string,
  now: () => Date = () => new Date(),
): Promise<{
  freshness: SignalFreshness;
  latest: SignalObservation[];
  observedAt: string | null;
  positionId: string;
}> => {
  const rows = await db
    .selectDistinctOn([signalObservations.metric])
    .from(signalObservations)
    .where(eq(signalObservations.positionId, positionId))
    .orderBy(signalObservations.metric, desc(signalObservations.observedAt));

  const latest = rows.map((row) => ({
    id: row.id,
    positionId: row.positionId,
    chainId: row.chainId,
    protocol: row.protocol,
    sourceFamily: row.sourceFamily as SignalSourceFamily,
    metric: row.metric as SignalMetric,
    rawValue: row.rawValue,
    normalizedValue: row.normalizedValue,
    severity: row.severity,
    contractAddress: row.contractAddress,
    blockNumber: row.blockNumber,
    blockTimestamp: row.blockTimestamp?.toISOString() ?? null,
    observedAt: row.observedAt.toISOString(),
    rpcSource: row.rpcSource,
    metadata: parseMetadata(row.metadataJson),
  }));

  const newestObservedAt = latest.reduce<string | null>((newest, observation) => {
    if (newest === null || observation.observedAt > newest) return observation.observedAt;
    return newest;
  }, null);

  let freshness: SignalFreshness = "UNAVAILABLE";
  if (newestObservedAt !== null) {
    freshness =
      now().getTime() - Date.parse(newestObservedAt) <= SIGNAL_FRESHNESS_MAX_AGE_MS ? "LIVE" : "STALE";
  }

  return { freshness, latest, observedAt: newestObservedAt, positionId };
};

export const getSignalHistory = async (
  db: VindexDb,
  positionId: string,
  options: { family?: SignalSourceFamily; metric?: SignalMetric; limit?: number } = {},
): Promise<SignalObservation[]> => {
  const limit = Math.min(Math.max(options.limit ?? 50, 1), 500);
  const conditions = [eq(signalObservations.positionId, positionId)];
  if (options.family !== undefined) {
    conditions.push(eq(signalObservations.sourceFamily, options.family));
  }
  if (options.metric !== undefined) {
    conditions.push(eq(signalObservations.metric, options.metric));
  }

  const rows = await db
    .select()
    .from(signalObservations)
    .where(and(...conditions))
    .orderBy(desc(signalObservations.observedAt))
    .limit(limit);

  return rows.map((row) => ({
    id: row.id,
    positionId: row.positionId,
    chainId: row.chainId,
    protocol: row.protocol,
    sourceFamily: row.sourceFamily as SignalSourceFamily,
    metric: row.metric as SignalMetric,
    rawValue: row.rawValue,
    normalizedValue: row.normalizedValue,
    severity: row.severity,
    contractAddress: row.contractAddress,
    blockNumber: row.blockNumber,
    blockTimestamp: row.blockTimestamp?.toISOString() ?? null,
    observedAt: row.observedAt.toISOString(),
    rpcSource: row.rpcSource,
    metadata: parseMetadata(row.metadataJson),
  }));
};

const parseMetadata = (json: string): Record<string, unknown> => {
  try {
    const parsed: unknown = JSON.parse(json);
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // fall through
  }
  return {};
};

export { USDC_SYMBOL };
