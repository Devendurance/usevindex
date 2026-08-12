// Unit tests for the M2 evidence module: sanitized artifact shape, bigint
// serialization, forward-compatible parsing, verified-state predicate, and the
// recursive secret scan.

import { describe, expect, it, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import {
  buildM2Evidence,
  isVerifiedM2Evidence,
  loadM2Evidence,
  writeM2Evidence,
  assertM2EvidenceSafe,
} from "../../lib/vindex/m2-evidence";

const tempDirs: string[] = [];
afterAll(() => {
  for (const dir of tempDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function newPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "m2-evidence-"));
  tempDirs.push(dir);
  return join(dir, "artifacts", "m2-aave-position.json");
}

const BASE_INPUT = {
  milestone: "M2",
  chainId: 84532,
  network: "Base Sepolia",
  keeperHubWallet: "0x675638ddbbf8b70b906d68e3485da72c6c63d130",
  asset: "0xba50Cd2A20f6DA35D788639E581bca8d0B5d4D5f",
  aToken: "0x10F1A9D11CDf50041f3f8cB7191CBE2f31750ACC",
  pool: "0x8bAB6d1b75f19e9eD9fCe8b9BD338844fF79aE27",
  faucet: "0xD9145b5F45Ad4519c7ACcD6E0A4A82e83bB8A6Dc",
  supplyAmountBaseUnits: "5000000",
  supplyAmountFormatted: "5",
  preState: {
    usdcBalance: "0",
    aUsdcBalance: "0",
    allowance: "1",
    blockNumber: "45381247",
  },
  postState: {
    usdcBalance: "0",
    aUsdcBalance: "4999999",
    allowance: "0",
    blockNumber: "45381256",
  },
  positionVerified: true,
  verifiedAt: "2026-08-12T00:00:00.000Z",
};

function verifiedInput(): Record<string, unknown> {
  return {
    ...BASE_INPUT,
    funding: {
      required: true,
      executionId: "direct_m2_funding",
      transactionHash: `0x${"11".repeat(32)}`,
      transactionLink: null,
      sponsored: true,
      receiptVerified: true,
      blockNumber: 45381249,
      simulation: {
        intentId: "m2-funding",
        chainId: 84532,
        from: "0x675638ddbbf8b70b906d68e3485da72c6c63d130",
        to: "0xD9145b5F45Ad4519c7ACcD6E0A4A82e83bB8A6Dc",
        function: "mint",
        functionArgs: '["0xba50Cd2A20f6DA35D788639E581bca8d0B5d4D5f","0x675638ddbbf8b70b906d68e3485da72c6c63d130","5000000"]',
        success: true,
        status: "simulated",
        wouldRevert: false,
        gasEstimate: "88834",
        simulatedReturnValue: "5000000",
        observedAt: "2026-08-12T00:00:00.000Z",
      },
      mintAmountBaseUnits: "5000000",
    },
    approval: {
      required: true,
      executionId: "direct_m2_approval",
      transactionHash: `0x${"22".repeat(32)}`,
      transactionLink: null,
      sponsored: false,
      receiptVerified: true,
      blockNumber: 45381253,
      simulation: null,
      allowanceAfter: "5000000",
    },
    supply: {
      executionId: "direct_m2_supply",
      transactionHash: `0x${"33".repeat(32)}`,
      transactionLink: "https://sepolia.basescan.org/tx/0x33",
      sponsored: true,
      receiptVerified: true,
      blockNumber: 45381256,
      simulation: null,
    },
  };
}

describe("buildM2Evidence", () => {
  it("maps all fields and coerces bigints to decimal strings", () => {
    const evidence = buildM2Evidence(verifiedInput());
    expect(evidence.milestone).toBe("M2");
    expect(evidence.chainId).toBe(84532);
    expect(evidence.supplyAmountBaseUnits).toBe("5000000");
    expect(evidence.postState.aUsdcBalance).toBe("4999999");
    expect(evidence.funding?.required).toBe(true);
    expect(evidence.funding?.simulation?.simulatedReturnValue).toBe("5000000");
    expect(evidence.approval?.allowanceAfter).toBe("5000000");
    expect(evidence.supply?.transactionHash).toBe(`0x${"33".repeat(32)}`);
    expect(evidence.positionVerified).toBe(true);
  });

  it("defaults missing sections and simulation records to null", () => {
    const evidence = buildM2Evidence(BASE_INPUT);
    expect(evidence.funding).toBeNull();
    expect(evidence.approval).toBeNull();
    expect(evidence.supply).toBeNull();
  });

  it("defaults bigint simulatedReturnValue to a string", () => {
    const input = verifiedInput();
    input.funding = {
      ...(input.funding as object),
      simulation: {
        ...((input.funding as { simulation: object }).simulation as object),
        simulatedReturnValue: BigInt(5000000),
      },
    };
    const evidence = buildM2Evidence(input);
    expect(evidence.funding?.simulation?.simulatedReturnValue).toBe("5000000");
  });
});

describe("write/load roundtrip", () => {
  it("persists and reloads evidence via nested paths", () => {
    const path = newPath();
    const evidence = buildM2Evidence(verifiedInput());
    writeM2Evidence(path, evidence);
    const loaded = loadM2Evidence(path);
    expect(loaded).toEqual(evidence);
  });

  it("returns null for a missing file", () => {
    expect(loadM2Evidence(newPath())).toBeNull();
  });

  it("returns null for malformed JSON", () => {
    const path = newPath();
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, "{not json", "utf8");
    expect(loadM2Evidence(path)).toBeNull();
  });

  it("returns null when milestone is not M2", () => {
    const path = newPath();
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify({ ...BASE_INPUT, milestone: "M1" }), "utf8");
    expect(loadM2Evidence(path)).toBeNull();
  });
});

describe("isVerifiedM2Evidence", () => {
  it("is true for a verified position", () => {
    expect(isVerifiedM2Evidence(buildM2Evidence(verifiedInput()))).toBe(true);
  });

  it("is false when positionVerified is false", () => {
    const evidence = buildM2Evidence({ ...verifiedInput(), positionVerified: false });
    expect(isVerifiedM2Evidence(evidence)).toBe(false);
  });

  it("is false when aUsdc balance is zero", () => {
    const input = verifiedInput();
    input.postState = { ...(input.postState as object), aUsdcBalance: "0" };
    expect(isVerifiedM2Evidence(buildM2Evidence(input))).toBe(false);
  });

  it("is false when aUsdc balance is unparseable", () => {
    const input = verifiedInput();
    input.postState = { ...(input.postState as object), aUsdcBalance: "abc" };
    expect(isVerifiedM2Evidence(buildM2Evidence(input))).toBe(false);
  });

  it("is true for an adopted position without a supply record", () => {
    const evidence = buildM2Evidence(BASE_INPUT);
    expect(isVerifiedM2Evidence(evidence)).toBe(true);
  });
});

describe("assertM2EvidenceSafe", () => {
  it("throws when a kh_ key pattern appears anywhere, including nested sections", () => {
    const input = verifiedInput();
    input.supply = {
      ...(input.supply as object),
      simulation: {
        intentId: "m2-supply",
        chainId: 84532,
        from: null,
        to: null,
        function: "supply",
        functionArgs: "kh_ABCDEF0123456789",
        success: true,
        status: "simulated",
        wouldRevert: false,
        gasEstimate: "100",
        simulatedReturnValue: null,
        observedAt: "x",
      },
    };
    const evidence = buildM2Evidence(input);
    expect(() => assertM2EvidenceSafe(evidence)).toThrow("forbidden secret pattern");
  });

  it("throws on Authorization and Bearer substrings", () => {
    const input = verifiedInput();
    input.funding = {
      ...(input.funding as object),
      simulation: {
        intentId: "m2-funding",
        chainId: 84532,
        from: null,
        to: null,
        function: "mint",
        functionArgs: "Authorization: Bearer kh_XXX",
        success: true,
        status: "simulated",
        wouldRevert: false,
        gasEstimate: "1",
        simulatedReturnValue: null,
        observedAt: "x",
      },
    };
    expect(() => assertM2EvidenceSafe(buildM2Evidence(input))).toThrow("forbidden secret pattern");
  });

  it("passes on clean verified evidence", () => {
    expect(() => assertM2EvidenceSafe(buildM2Evidence(verifiedInput()))).not.toThrow();
  });
});
