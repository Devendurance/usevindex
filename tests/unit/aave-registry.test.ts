import { describe, expect, it } from "vitest";
import {
  AAVE_V3_BASE_SEPOLIA,
  KEEPERHUB_QUICKSTART_USDC_BASE_SEPOLIA,
} from "../../lib/vindex/aave-registry";
import { isEvmAddress } from "../../lib/vindex/validation";

/**
 * IfEquals<X, Y, A, B> is A when X and Y are the exact same type (property
 * modifiers included), B otherwise. Used below for a compile-time readonly
 * proof: a mutable registry would produce non-never keys and fail to compile.
 */
type IfEquals<X, Y, A, B> = (<T>() => T extends X ? 1 : 2) extends (
  <T>() => T extends Y ? 1 : 2
)
  ? A
  : B;

type MutableKeys<T> = {
  [P in keyof T]-?: IfEquals<
    { [Q in P]: T[P] },
    { -readonly [Q in P]: T[P] },
    P,
    never
  >;
}[keyof T];

// `never` only accepts `never`, so this assignment is a compile error if any
// registry field loses its `as const` readonly modifier.
const registryIsReadonly: never = undefined as unknown as MutableKeys<
  typeof AAVE_V3_BASE_SEPOLIA
>;

// Authoritative expectation: the current official Aave address book
// (aave-dao/aave-address-book, src/AaveV3BaseSepolia.sol).
const OFFICIAL_AAVE_V3_BASE_SEPOLIA = {
  poolAddressesProvider: "0xE4C23309117Aa30342BFaae6c95c6478e0A4Ad00",
  pool: "0x8bAB6d1b75f19e9eD9fCe8b9BD338844fF79aE27",
  aaveOracle: "0x943b0dE18d4abf4eF02A85912F8fc07684C141dF",
  aaveProtocolDataProvider: "0xBc9f5b7E248451CdD7cA54e717a2BFe1F32b566b",
  usdcUnderlying: "0xba50Cd2A20f6DA35D788639E581bca8d0B5d4D5f",
  usdcAToken: "0x10F1A9D11CDf50041f3f8cB7191CBE2f31750ACC",
  usdcOracle: "0xd30e2101a97dcbAeBCBC04F14C3f624E67A35165",
  usdcDecimals: 6,
} as const;

describe("AAVE_V3_BASE_SEPOLIA registry", () => {
  it("matches the official Aave V3 Base Sepolia address book", () => {
    expect(AAVE_V3_BASE_SEPOLIA).toEqual(OFFICIAL_AAVE_V3_BASE_SEPOLIA);
  });

  it("distinguishes the Aave market USDC from the KeeperHub quickstart USDC", () => {
    expect(AAVE_V3_BASE_SEPOLIA.usdcUnderlying).not.toBe(
      KEEPERHUB_QUICKSTART_USDC_BASE_SEPOLIA,
    );
    expect(KEEPERHUB_QUICKSTART_USDC_BASE_SEPOLIA).toBe(
      "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
    );
  });

  it("uses valid EVM addresses throughout the registry", () => {
    const addresses = [
      AAVE_V3_BASE_SEPOLIA.poolAddressesProvider,
      AAVE_V3_BASE_SEPOLIA.pool,
      AAVE_V3_BASE_SEPOLIA.aaveOracle,
      AAVE_V3_BASE_SEPOLIA.aaveProtocolDataProvider,
      AAVE_V3_BASE_SEPOLIA.usdcUnderlying,
      AAVE_V3_BASE_SEPOLIA.usdcAToken,
      AAVE_V3_BASE_SEPOLIA.usdcOracle,
      KEEPERHUB_QUICKSTART_USDC_BASE_SEPOLIA,
    ];
    for (const address of addresses) {
      expect(isEvmAddress(address)).toBe(true);
    }
  });

  it("is readonly at the type level", () => {
    // Compile-time check above: registryIsReadonly only type-checks while every
    // field is readonly. Runtime check documents the value is an inert constant.
    expect(registryIsReadonly).toBeUndefined();
  });
});
