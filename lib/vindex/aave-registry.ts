// Aave V3 Base Sepolia registry. Addresses verified 2026-08-12 against the
// official Aave address book:
// https://github.com/aave-dao/aave-address-book
// (src/AaveV3BaseSepolia.sol:
// https://github.com/aave-dao/aave-address-book/blob/main/src/AaveV3BaseSepolia.sol)
export const AAVE_V3_BASE_SEPOLIA = {
  poolAddressesProvider: "0xE4C23309117Aa30342BFaae6c95c6478e0A4Ad00",
  pool: "0x8bAB6d1b75f19e9eD9fCe8b9BD338844fF79aE27",
  aaveOracle: "0x943b0dE18d4abf4eF02A85912F8fc07684C141dF",
  aaveProtocolDataProvider: "0xBc9f5b7E248451CdD7cA54e717a2BFe1F32b566b",
  usdcUnderlying: "0xba50Cd2A20f6DA35D788639E581bca8d0B5d4D5f",
  usdcAToken: "0x10F1A9D11CDf50041f3f8cB7191CBE2f31750ACC",
  usdcOracle: "0xd30e2101a97dcbAeBCBC04F14C3f624E67A35165",
  usdcDecimals: 6,
} as const;

// KeeperHub quickstart / Circle-style generic Base Sepolia test USDC.
// CRITICAL: this is NOT the Aave market underlying asset. It must never be
// substituted into the Aave supply/withdraw flow. Retained for mismatch detection.
export const KEEPERHUB_QUICKSTART_USDC_BASE_SEPOLIA = "0x036CbD53842c5426634e7929541eC2318f3dCF7e" as const;

export const USDC_SYMBOL = "USDC" as const;

export const ERC20_ABI = [
  {
    type: "function",
    name: "balanceOf",
    stateMutability: "view",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ name: "balance", type: "uint256" }],
  },
  {
    type: "function",
    name: "decimals",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint8" }],
  },
  {
    type: "function",
    name: "symbol",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "string" }],
  },
  {
    type: "function",
    name: "totalSupply",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "supply", type: "uint256" }],
  },
  {
    type: "function",
    name: "approve",
    stateMutability: "nonpayable",
    inputs: [{ name: "spender", type: "address" }, { name: "amount", type: "uint256" }],
    outputs: [{ name: "", type: "bool" }],
  },
  {
    type: "function",
    name: "allowance",
    stateMutability: "view",
    inputs: [{ name: "owner", type: "address" }, { name: "spender", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
  },
] as const;

export const POOL_ADDRESSES_PROVIDER_ABI = [
  {
    type: "function",
    name: "getPool",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "address" }],
  },
] as const;

export const POOL_DATA_PROVIDER_ABI = [  {
    type: "function",
    name: "getReserveTokensAddresses",
    stateMutability: "view",
    inputs: [{ name: "asset", type: "address" }],
    outputs: [
      { name: "aTokenAddress", type: "address" },
      { name: "stableDebtTokenAddress", type: "address" },
      { name: "variableDebtTokenAddress", type: "address" },
    ],
  },
  {
    type: "function",
    name: "getReserveConfigurationData",
    stateMutability: "view",
    inputs: [{ name: "asset", type: "address" }],
    outputs: [
      { name: "decimals", type: "uint256" },
      { name: "ltv", type: "uint256" },
      { name: "liquidationThreshold", type: "uint256" },
      { name: "liquidationBonus", type: "uint256" },
      { name: "reserveFactor", type: "uint256" },
      { name: "usageAsCollateralEnabled", type: "bool" },
      { name: "borrowingEnabled", type: "bool" },
      { name: "stableBorrowRateEnabled", type: "bool" },
      { name: "isActive", type: "bool" },
      { name: "isFrozen", type: "bool" },
    ],
  },
] as const;

export const POOL_ABI = [
  {
    type: "function",
    name: "getReserveData",
    stateMutability: "view",
    inputs: [{ name: "asset", type: "address" }],
    outputs: [
      {
        name: "",
        type: "tuple",
        components: [
          { name: "configuration", type: "uint256" },
          { name: "liquidityIndex", type: "uint128" },
          { name: "currentLiquidityRate", type: "uint128" },
          { name: "variableBorrowIndex", type: "uint128" },
          { name: "currentVariableBorrowRate", type: "uint128" },
          { name: "currentStableBorrowRate", type: "uint128" },
          { name: "lastUpdateTimestamp", type: "uint40" },
          { name: "id", type: "uint16" },
          { name: "aTokenAddress", type: "address" },
          { name: "stableDebtTokenAddress", type: "address" },
          { name: "variableDebtTokenAddress", type: "address" },
          { name: "interestRateStrategyAddress", type: "address" },
          { name: "accruedToTreasury", type: "uint128" },
          { name: "unbacked", type: "uint128" },
          { name: "isolationModeTotalDebt", type: "uint128" },
        ],
      },
    ],
  },
  {
    type: "function",
    name: "supply",
    stateMutability: "nonpayable",
    inputs: [
      { name: "asset", type: "address" },
      { name: "amount", type: "uint256" },
      { name: "onBehalfOf", type: "address" },
      { name: "referralCode", type: "uint16" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "withdraw",
    stateMutability: "nonpayable",
    inputs: [
      { name: "asset", type: "address" },
      { name: "amount", type: "uint256" },
      { name: "to", type: "address" },
    ],
    outputs: [{ name: "", type: "uint256" }],
  },
] as const;

// Aave V3 Pool.withdraw with amount == type(uint256).max withdraws the full
// aToken balance. Verified against the deployed Base Sepolia Pool
// implementation (POOL_IMPL bytecode contains selector 0x69328dec) and via a
// real KeeperHub simulate:true call: withdraw(USDC, MAX_UINT, safeWallet)
// returns the full accrued position without amount drift.
export const MAX_UINT256: string = (BigInt(2) ** BigInt(256) - BigInt(1)).toString();

export const POOL_SUPPLY_EVENT = [
  {
    type: "event",
    name: "Supply",
    inputs: [
      { name: "reserve", type: "address", indexed: true },
      { name: "user", type: "address", indexed: false },
      { name: "onBehalfOf", type: "address", indexed: true },
      { name: "amount", type: "uint256", indexed: false },
      { name: "referralCode", type: "uint16", indexed: true },
    ],
  },
] as const;

// Official Aave Base Sepolia testnet faucet — owner of the Aave-market USDC
// underlying (verified 2026-08-12). Source: aave-address-book
// MiscBaseSepolia.sol:
// https://github.com/aave-dao/aave-address-book/blob/main/src/MiscBaseSepolia.sol
// Interface (mint(address,address,uint256), isPermissioned()) matches the
// current official @aave/contract-helpers V3FaucetService/IERC20FaucetOwnable.
// Verified onchain: isPermissioned() == false (permissionless), token config
// (cooldown 3600s, request amount 1,000,000 base units).
export const AAVE_V3_BASE_SEPOLIA_FAUCET = "0xD9145b5F45Ad4519c7ACcD6E0A4A82e83bB8A6Dc" as const;

export const FAUCET_ABI = [
  {
    type: "function",
    name: "mint",
    stateMutability: "nonpayable",
    inputs: [
      { name: "token", type: "address" },
      { name: "to", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "isPermissioned",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "bool" }],
  },
] as const;

// M2 supply amount bounds (base units, 6 decimals)
export const M2_SUPPLY_AMOUNT_BASE = BigInt(5000000); // 5 USDC (6 decimals) — preferred M2 supply
export const M2_SUPPLY_MIN_BASE = BigInt(1000000);    // 1 USDC
export const M2_SUPPLY_MAX_BASE = BigInt(10000000);   // 10 USDC

export const POOL_WITHDRAW_EVENT = [
  {
    type: "event",
    name: "Withdraw",
    inputs: [
      { name: "reserve", type: "address", indexed: true },
      { name: "user", type: "address", indexed: true },
      { name: "to", type: "address", indexed: true },
      { name: "amount", type: "uint256", indexed: false },
    ],
  },
] as const;

// M4 signal sources
export const ORACLE_ABI = [
  {
    type: "function",
    name: "getAssetPrice",
    stateMutability: "view",
    inputs: [{ name: "asset", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
  },
] as const;

// Aave V3 ReserveData tuple (deployed getReserveData verified on Base Sepolia).
export const AAVE_RESERVE_DATA_ABI = [
  {
    type: "function",
    name: "getReserveData",
    stateMutability: "view",
    inputs: [{ name: "asset", type: "address" }],
    outputs: [
      {
        name: "",
        type: "tuple",
        components: [
          { name: "configuration", type: "uint256" },
          { name: "liquidityIndex", type: "uint128" },
          { name: "currentLiquidityRate", type: "uint128" },
          { name: "variableBorrowIndex", type: "uint128" },
          { name: "currentVariableBorrowRate", type: "uint128" },
          { name: "currentStableBorrowRate", type: "uint128" },
          { name: "lastUpdateTimestamp", type: "uint40" },
          { name: "id", type: "uint16" },
          { name: "aTokenAddress", type: "address" },
          { name: "stableDebtTokenAddress", type: "address" },
          { name: "variableDebtTokenAddress", type: "address" },
          { name: "interestRateStrategyAddress", type: "address" },
          { name: "accruedToTreasury", type: "uint128" },
          { name: "unbacked", type: "uint128" },
          { name: "isolationModeTotalDebt", type: "uint128" },
        ],
      },
    ],
  },
] as const;
