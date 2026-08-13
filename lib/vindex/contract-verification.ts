import "server-only";

import {
  AAVE_V3_BASE_SEPOLIA,
  ERC20_ABI,
  POOL_ADDRESSES_PROVIDER_ABI,
  POOL_DATA_PROVIDER_ABI,
  USDC_SYMBOL,
} from "./aave-registry";
import type { CanonicalReadClient } from "./public-client";
import { isEvmAddress } from "./validation";

export type ContractCheck = {
  label: string;
  address: string;
  addressValid: boolean;
  bytecodePresent: boolean;
  /** (bytecode.length - 2) / 2 bytes, null if absent */
  bytecodeLength: number | null;
  passed: boolean;
  error: string | null;
};

export async function verifyContractDeployed(
  client: CanonicalReadClient,
  address: string,
  label: string,
): Promise<ContractCheck> {
  if (!isEvmAddress(address)) {
    return {
      label,
      address,
      addressValid: false,
      bytecodePresent: false,
      bytecodeLength: null,
      passed: false,
      error: "Invalid EVM address format",
    };
  }

  // Safe cast: the isEvmAddress guard above guarantees a 0x-prefixed 40-hex address.
  const evmAddress = address as `0x${string}`;

  let bytecode: `0x${string}` | undefined;
  try {
    bytecode = await client.getBytecode({ address: evmAddress });
  } catch (error) {
    return {
      label,
      address,
      addressValid: true,
      bytecodePresent: false,
      bytecodeLength: null,
      passed: false,
      error: error instanceof Error ? error.message : "Failed to read contract bytecode",
    };
  }

  const bytecodePresent = bytecode !== undefined && bytecode !== "0x";
  return {
    label,
    address,
    addressValid: true,
    bytecodePresent,
    bytecodeLength:
      bytecode !== undefined && bytecode !== "0x" ? (bytecode.length - 2) / 2 : null,
    passed: bytecodePresent,
    error: null,
  };
}

export type AaveAssetVerification = {
  usdc: {
    decimals: number | null;
    symbol: string | null;
    decimalsExpected: number;
    symbolExpected: string;
    decimalsVerified: boolean;
    symbolVerified: boolean;
    passed: boolean;
    error: string | null;
  };
  aToken: {
    symbol: string | null;
    aTokenMatch: boolean;
    expectedATokenAddress: string;
    observedATokenAddress: string | null;
    passed: boolean;
    error: string | null;
  };
  /** POOL_ADDRESSES_PROVIDER.getPool() === registry pool */
  providerPoolMatch: boolean;
};

const errorMessage = (error: unknown, fallback: string): string =>
  error instanceof Error ? error.message : fallback;

const joinedErrors = (errors: Array<string | null>): string | null => {
  const present = errors.filter((item): item is string => item !== null);
  return present.length > 0 ? present.join("; ") : null;
};

export async function verifyAaveIdentity(
  client: CanonicalReadClient,
): Promise<AaveAssetVerification> {
  const {
    pool,
    poolAddressesProvider,
    aaveProtocolDataProvider,
    usdcUnderlying,
    usdcAToken,
    usdcDecimals,
  } = AAVE_V3_BASE_SEPOLIA;

  let decimals: number | null = null;
  let decimalsError: string | null = null;
  try {
    const value = await client.readContract({
      address: usdcUnderlying,
      abi: ERC20_ABI,
      functionName: "decimals",
    });
    decimals = Number(value);
  } catch (error) {
    decimalsError = errorMessage(error, "Failed to read USDC decimals()");
  }

  let symbol: string | null = null;
  let symbolError: string | null = null;
  try {
    const value = await client.readContract({
      address: usdcUnderlying,
      abi: ERC20_ABI,
      functionName: "symbol",
    });
    symbol = String(value);
  } catch (error) {
    symbolError = errorMessage(error, "Failed to read USDC symbol()");
  }

  const decimalsVerified = decimals === usdcDecimals;
  const symbolVerified = symbol === USDC_SYMBOL;

  let providerPoolAddress: string | null = null;
  try {
    const value = await client.readContract({
      address: poolAddressesProvider,
      abi: POOL_ADDRESSES_PROVIDER_ABI,
      functionName: "getPool",
    });
    providerPoolAddress = value.toLowerCase();
  } catch {
    // No dedicated error slot for this read; a failed read surfaces as
    // providerPoolMatch === false.
  }

  let observedATokenAddress: string | null = null;
  let aTokenError: string | null = null;
  try {
    const [aTokenAddress] = await client.readContract({
      address: aaveProtocolDataProvider,
      abi: POOL_DATA_PROVIDER_ABI,
      functionName: "getReserveTokensAddresses",
      args: [usdcUnderlying],
    });
    observedATokenAddress = aTokenAddress.toLowerCase();
  } catch (error) {
    aTokenError = errorMessage(error, "Failed to read reserve token addresses");
  }

  // Probe the symbol on the observed aToken when available, falling back to the
  // expected address so the check stays meaningful after a data-provider error.
  // Both branches are registry/on-chain addresses, so the address pattern holds.
  const symbolProbeAddress = (observedATokenAddress ?? usdcAToken.toLowerCase()) as `0x${string}`;
  let aTokenSymbol: string | null = null;
  let aTokenSymbolError: string | null = null;
  try {
    const value = await client.readContract({
      address: symbolProbeAddress,
      abi: ERC20_ABI,
      functionName: "symbol",
    });
    aTokenSymbol = String(value);
  } catch (error) {
    aTokenSymbolError = errorMessage(error, "Failed to read aUSDC symbol()");
  }

  const providerPoolMatch = providerPoolAddress === pool.toLowerCase();
  const aTokenMatch = observedATokenAddress === usdcAToken.toLowerCase();

  return {
    usdc: {
      decimals,
      symbol,
      decimalsExpected: usdcDecimals,
      symbolExpected: USDC_SYMBOL,
      decimalsVerified,
      symbolVerified,
      passed: decimalsVerified && symbolVerified,
      error: joinedErrors([decimalsError, symbolError]),
    },
    aToken: {
      symbol: aTokenSymbol,
      aTokenMatch,
      expectedATokenAddress: usdcAToken,
      observedATokenAddress,
      passed: aTokenMatch,
      error: joinedErrors([aTokenError, aTokenSymbolError]),
    },
    providerPoolMatch,
  };
}

export type FoundationContractsReport = {
  contracts: ContractCheck[]; // Pool Addresses Provider, Pool, Data Provider, USDC underlying, aUSDC
  asset: AaveAssetVerification;
  allPassed: boolean;
};

export async function verifyAaveFoundation(
  client: CanonicalReadClient,
): Promise<FoundationContractsReport> {
  const { pool, poolAddressesProvider, aaveProtocolDataProvider, usdcUnderlying, usdcAToken } =
    AAVE_V3_BASE_SEPOLIA;

  const [addressesProviderCheck, poolCheck, dataProviderCheck, usdcCheck, aTokenCheck, asset] =
    await Promise.all([
      verifyContractDeployed(client, poolAddressesProvider, "Aave Pool Addresses Provider"),
      verifyContractDeployed(client, pool, "Aave V3 Pool"),
      verifyContractDeployed(client, aaveProtocolDataProvider, "Aave Protocol Data Provider"),
      verifyContractDeployed(client, usdcUnderlying, "Aave USDC underlying"),
      verifyContractDeployed(client, usdcAToken, "Aave aUSDC"),
      verifyAaveIdentity(client),
    ]);

  const contracts = [addressesProviderCheck, poolCheck, dataProviderCheck, usdcCheck, aTokenCheck];
  const allPassed =
    contracts.every((check) => check.passed) &&
    asset.usdc.passed &&
    asset.aToken.passed &&
    asset.providerPoolMatch;

  return { contracts, asset, allPassed };
}
