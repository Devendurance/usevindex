import { describe, expect, it } from "vitest";
import {
  assertCanonicalChainId,
  CANONICAL_CHAIN,
  VINDEX_CHAIN_ID,
  WrongChainError,
} from "../../lib/vindex/chain";
import {
  readCanonicalChainState,
  type CanonicalReadClient,
} from "../../lib/vindex/public-client";

function captureError(fn: () => unknown): unknown {
  try {
    fn();
  } catch (error) {
    return error;
  }
  throw new Error("Expected the function to throw");
}

describe("chain constants", () => {
  it("exports the canonical chain id 84532 (Base Sepolia)", () => {
    expect(VINDEX_CHAIN_ID).toBe(84532);
  });

  it("describes the canonical chain as the Base Sepolia testnet with ETH", () => {
    expect(CANONICAL_CHAIN.id).toBe(84532);
    expect(CANONICAL_CHAIN.name).toBe("Base Sepolia");
    expect(CANONICAL_CHAIN.testnet).toBe(true);
    expect(CANONICAL_CHAIN.nativeCurrency.symbol).toBe("ETH");
  });
});

describe("assertCanonicalChainId", () => {
  it("does not throw for the canonical chain id", () => {
    expect(() => assertCanonicalChainId(84532)).not.toThrow();
  });

  it("throws WrongChainError with the actual chain id for other chains", () => {
    const error = captureError(() => assertCanonicalChainId(1));
    expect(error).toBeInstanceOf(WrongChainError);
    expect(error).toMatchObject({ actualChainId: 1 });
    expect((error as WrongChainError).message).toContain("84532");
  });
});

describe("readCanonicalChainState", () => {
  it("rejects with WrongChainError when the client is on a non-canonical chain", async () => {
    const client = { getChainId: async () => 1 } as unknown as CanonicalReadClient;
    const result = readCanonicalChainState(client);
    await expect(result).rejects.toBeInstanceOf(WrongChainError);
    await expect(result).rejects.toMatchObject({ actualChainId: 1 });
    await expect(result).rejects.toThrow(/84532/);
  });

  it("resolves chain id and latest block on the canonical chain", async () => {
    const client = {
      getChainId: async () => 84532,
      getBlockNumber: async () => BigInt(9999),
    } as unknown as CanonicalReadClient;
    await expect(readCanonicalChainState(client)).resolves.toEqual({
      chainId: 84532,
      latestBlock: BigInt(9999),
    });
  });
});
