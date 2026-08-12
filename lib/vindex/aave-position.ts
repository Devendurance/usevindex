import "server-only";
import { formatUnits } from "viem";
import {
  AAVE_V3_BASE_SEPOLIA,
  ERC20_ABI,
  POOL_DATA_PROVIDER_ABI,
} from "./aave-registry";
import { readAaveUsdcAllowance } from "./aave-reads";
import { VINDEX_CHAIN_ID } from "./chain";
import type { CanonicalReadClient } from "./public-client";

export type AaveUsdcPosition = {
  owner: string;
  chainId: number;
  underlyingAsset: string;
  underlyingBalanceBaseUnits: bigint;
  underlyingBalanceFormatted: string; // decimal string via viem formatUnits (no float math)
  aToken: string;
  aTokenBalanceBaseUnits: bigint;
  aTokenBalanceFormatted: string;
  allowanceToPool: bigint;
  pool: string;
  latestBlockNumber: bigint;
  observedAt: string;
  reserve: {
    decimals: number;
    isActive: boolean;
    isFrozen: boolean;
    ltv: bigint;
    liquidationThreshold: bigint;
  } | null;
};

export async function getAaveUsdcPosition(
  client: CanonicalReadClient,
  owner: string,
): Promise<AaveUsdcPosition> {
  const ownerAddress = owner as `0x${string}`;

  const [underlyingBalanceBaseUnits, aTokenBalanceBaseUnits, allowanceToPool, latestBlockNumber] =
    await Promise.all([
      client.readContract({
        address: AAVE_V3_BASE_SEPOLIA.usdcUnderlying,
        abi: ERC20_ABI,
        functionName: "balanceOf",
        args: [ownerAddress],
      }),
      client.readContract({
        address: AAVE_V3_BASE_SEPOLIA.usdcAToken,
        abi: ERC20_ABI,
        functionName: "balanceOf",
        args: [ownerAddress],
      }),
      readAaveUsdcAllowance(client, ownerAddress, AAVE_V3_BASE_SEPOLIA.pool),
      client.getBlockNumber(),
    ]);

  // Reserve configuration is informational; a failure here must not fail the
  // whole position read, so it is read defensively and mapped to null.
  let reserve: AaveUsdcPosition["reserve"] = null;
  try {
    const config = await client.readContract({
      address: AAVE_V3_BASE_SEPOLIA.aaveProtocolDataProvider,
      abi: POOL_DATA_PROVIDER_ABI,
      functionName: "getReserveConfigurationData",
      args: [AAVE_V3_BASE_SEPOLIA.usdcUnderlying],
    });
    const [decimals, ltv, liquidationThreshold, , , , , , isActive, isFrozen] = config;
    reserve = {
      decimals: Number(decimals),
      isActive: Boolean(isActive),
      isFrozen: Boolean(isFrozen),
      ltv: BigInt(ltv),
      liquidationThreshold: BigInt(liquidationThreshold),
    };
  } catch {
    reserve = null;
  }

  return {
    owner,
    chainId: VINDEX_CHAIN_ID,
    underlyingAsset: AAVE_V3_BASE_SEPOLIA.usdcUnderlying,
    underlyingBalanceBaseUnits,
    underlyingBalanceFormatted: formatUnits(
      underlyingBalanceBaseUnits,
      AAVE_V3_BASE_SEPOLIA.usdcDecimals,
    ),
    aToken: AAVE_V3_BASE_SEPOLIA.usdcAToken,
    aTokenBalanceBaseUnits,
    aTokenBalanceFormatted: formatUnits(
      aTokenBalanceBaseUnits,
      AAVE_V3_BASE_SEPOLIA.usdcDecimals,
    ),
    allowanceToPool,
    pool: AAVE_V3_BASE_SEPOLIA.pool,
    latestBlockNumber,
    observedAt: new Date().toISOString(),
    reserve,
  };
}
