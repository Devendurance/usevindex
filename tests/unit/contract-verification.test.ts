import { describe, expect, it } from "vitest";
import { AAVE_V3_BASE_SEPOLIA } from "../../lib/vindex/aave-registry";
import { VINDEX_CHAIN_ID } from "../../lib/vindex/chain";
import {
  verifyAaveFoundation,
  verifyContractDeployed,
} from "../../lib/vindex/contract-verification";
import type { CanonicalReadClient } from "../../lib/vindex/public-client";

const ZERO_ADDRESS = `0x${"00".repeat(20)}` as const;

/** Minimal client stub where getBytecode always returns the given value. */
function bytecodeStub(bytecode: `0x${string}` | undefined): CanonicalReadClient {
  return {
    getChainId: async () => VINDEX_CHAIN_ID,
    getBlockNumber: async () => BigInt(1),
    getBytecode: async () => bytecode,
    readContract: async () => null,
  } as unknown as CanonicalReadClient;
}

type ReadContractArgs = {
  address: `0x${string}`;
  functionName: string;
  args?: readonly unknown[];
};

type FoundationStubOptions = {
  bytecode?: `0x${string}` | undefined;
  decimals?: bigint;
  underlyingSymbol?: string;
  pool?: string;
  reserveTokens?: readonly [string, string, string];
  aTokenSymbol?: string;
};

/**
 * Client stub aligned with the real readContract call pattern used by
 * verifyAaveIdentity: calls arrive as a single { address, abi, functionName,
 * args } object, so dispatch happens on functionName (+ address for the two
 * symbol reads). All five bytecode reads return the same value.
 */
function foundationStub(options: FoundationStubOptions = {}): CanonicalReadClient {
  const {
    bytecode = "0x1234",
    decimals = BigInt(6),
    underlyingSymbol = "USDC",
    pool = AAVE_V3_BASE_SEPOLIA.pool,
    reserveTokens = [AAVE_V3_BASE_SEPOLIA.usdcAToken, ZERO_ADDRESS, ZERO_ADDRESS],
    aTokenSymbol = "aUSDC",
  } = options;

  const readContract = async ({ address, functionName }: ReadContractArgs): Promise<unknown> => {
    const normalized = address.toLowerCase();
    const underlying = AAVE_V3_BASE_SEPOLIA.usdcUnderlying.toLowerCase();
    switch (functionName) {
      case "decimals":
        return decimals;
      case "symbol":
        // USDC underlying symbol read vs aUSDC probe on the observed aToken.
        return normalized === underlying ? underlyingSymbol : aTokenSymbol;
      case "getPool":
        return pool;
      case "getReserveTokensAddresses":
        return reserveTokens;
      default:
        throw new Error(`Unexpected readContract functionName: ${functionName}`);
    }
  };

  return {
    getChainId: async () => VINDEX_CHAIN_ID,
    getBlockNumber: async () => BigInt(1),
    getBytecode: async () => bytecode,
    readContract,
  } as unknown as CanonicalReadClient;
}

describe("verifyContractDeployed", () => {
  it("rejects a malformed contract address", async () => {
    const check = await verifyContractDeployed(bytecodeStub("0x1234"), "0x123", "Test Contract");
    expect(check.addressValid).toBe(false);
    expect(check.passed).toBe(false);
    expect(check.error).not.toBeNull();
  });

  it("fails when the contract has no bytecode", async () => {
    const check = await verifyContractDeployed(
      bytecodeStub("0x"),
      "0x0000000000000000000000000000000000000001",
      "Empty Contract",
    );
    expect(check.addressValid).toBe(true);
    expect(check.bytecodePresent).toBe(false);
    expect(check.passed).toBe(false);
  });

  it("passes and reports bytecode length when code is present", async () => {
    const check = await verifyContractDeployed(
      bytecodeStub("0x123456"),
      "0x0000000000000000000000000000000000000002",
      "Code Contract",
    );
    expect(check.passed).toBe(true);
    expect(check.bytecodePresent).toBe(true);
    expect(check.bytecodeLength).toBe(3);
  });

  it("fails when getBytecode returns undefined", async () => {
    const check = await verifyContractDeployed(
      bytecodeStub(undefined),
      "0x0000000000000000000000000000000000000003",
      "Missing Contract",
    );
    expect(check.addressValid).toBe(true);
    expect(check.bytecodePresent).toBe(false);
    expect(check.bytecodeLength).toBeNull();
    expect(check.passed).toBe(false);
  });
});

describe("verifyAaveFoundation", () => {
  it("reports allPassed when every contract and identity check passes", async () => {
    const report = await verifyAaveFoundation(foundationStub());
    expect(report.allPassed).toBe(true);
    expect(report.contracts).toHaveLength(5);
    expect(report.contracts.every((check) => check.passed)).toBe(true);
    expect(report.asset.usdc.decimalsVerified).toBe(true);
    expect(report.asset.usdc.symbolVerified).toBe(true);
    expect(report.asset.usdc.symbol).toBe("USDC");
    expect(report.asset.aToken.aTokenMatch).toBe(true);
    expect(report.asset.aToken.symbol).toBe("aUSDC");
    expect(report.asset.providerPoolMatch).toBe(true);
  });

  it("fails closed when the USDC decimals do not match the registry", async () => {
    const report = await verifyAaveFoundation(foundationStub({ decimals: BigInt(9) }));
    expect(report.allPassed).toBe(false);
    expect(report.asset.usdc.decimalsVerified).toBe(false);
    expect(report.asset.usdc.passed).toBe(false);
  });

  it("fails when the data provider reports a different aToken", async () => {
    const differentAToken = `0x${"11".repeat(20)}`;
    const report = await verifyAaveFoundation(
      foundationStub({
        reserveTokens: [differentAToken, ZERO_ADDRESS, ZERO_ADDRESS],
      }),
    );
    expect(report.asset.aToken.aTokenMatch).toBe(false);
    expect(report.asset.aToken.passed).toBe(false);
    expect(report.allPassed).toBe(false);
  });

  it("fails when the pool addresses provider reports a different pool", async () => {
    const report = await verifyAaveFoundation(
      foundationStub({ pool: `0x${"22".repeat(20)}` }),
    );
    expect(report.asset.providerPoolMatch).toBe(false);
    expect(report.allPassed).toBe(false);
  });
});
