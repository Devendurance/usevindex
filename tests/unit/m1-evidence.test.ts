// Unit tests for the M1 evidence artifact: field mapping/coercion, disk
// persistence, verification predicate, and secret-pattern defense.

import { describe, expect, it, afterAll } from "vitest";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  assertM1EvidenceSafe,
  buildM1Evidence,
  isVerifiedM1Evidence,
  loadM1Evidence,
  writeM1Evidence,
  type M1Evidence,
} from "../../lib/vindex/m1-evidence";

const WALLET = "0x675638ddbbf8b70b906d68e3485da72c6c63d130";
const USDC = "0xba50Cd2A20f6DA35D788639E581bca8d0B5d4D5f";
const POOL = "0x8bAB6d1b75f19e9eD9fCe8b9BD338844fF79aE27";
const TX = `0x${"ab".repeat(32)}`;

const tmp = mkdtempSync(join(tmpdir(), "m1-evidence-"));

afterAll(() => {
  rmSync(tmp, { recursive: true, force: true });
});

/** Input covering every M1Evidence field; allowanceBefore is a bigint on purpose. */
function verifiedInput(): Record<string, unknown> {
  return {
    milestone: "M1",
    chainId: 84532,
    network: "Base Sepolia",
    keeperHubWallet: WALLET,
    executionId: "direct_m1_1",
    transactionHash: TX,
    transactionLink: `https://sepolia.basescan.org/tx/${TX}`,
    blockNumber: 42,
    contractAddress: USDC,
    functionName: "approve",
    spender: POOL,
    amountBaseUnits: "1",
    allowanceBefore: BigInt(0),
    allowanceAfter: "1",
    gasUsedWei: "95603",
    keeperHubStatus: "completed",
    onchainReceiptStatus: "success",
    executedAt: "2026-01-01T00:00:00.000Z",
    verifiedAt: "2026-01-01T00:00:00.000Z",
    approvalLog: { owner: WALLET, spender: POOL, value: "1" },
    sponsored: false,
    executorAddress: null,
  };
}

const verifiedEvidence = (): M1Evidence => buildM1Evidence(verifiedInput());

describe("buildM1Evidence", () => {
  it("maps every required field and coerces strings (bigint allowanceBefore -> '0')", () => {
    const evidence = buildM1Evidence(verifiedInput());

    expect(evidence.milestone).toBe("M1");
    expect(evidence.chainId).toBe(84532);
    expect(evidence.network).toBe("Base Sepolia");
    expect(evidence.keeperHubWallet).toBe(WALLET);
    expect(evidence.executionId).toBe("direct_m1_1");
    expect(evidence.transactionHash).toBe(TX);
    expect(evidence.transactionLink).toBe(`https://sepolia.basescan.org/tx/${TX}`);
    expect(evidence.blockNumber).toBe(42);
    expect(evidence.contractAddress).toBe(USDC);
    expect(evidence.functionName).toBe("approve");
    expect(evidence.spender).toBe(POOL);
    expect(evidence.amountBaseUnits).toBe("1");
    expect(evidence.allowanceBefore).toBe("0"); // bigint BigInt(0) coerced via String()
    expect(evidence.allowanceAfter).toBe("1");
    expect(evidence.gasUsedWei).toBe("95603");
    expect(evidence.keeperHubStatus).toBe("completed");
    expect(evidence.onchainReceiptStatus).toBe("success");
    expect(evidence.executedAt).toBe("2026-01-01T00:00:00.000Z");
    expect(evidence.verifiedAt).toBe("2026-01-01T00:00:00.000Z");
    expect(evidence.approvalLog).toEqual({ owner: WALLET, spender: POOL, value: "1" });
    expect(evidence.sponsored).toBe(false);
    expect(evidence.executorAddress).toBeNull();
  });

  it("defaults sponsored to false and executorAddress to null when omitted", () => {
    const input = verifiedInput();
    delete input.sponsored;
    delete input.executorAddress;

    const evidence = buildM1Evidence(input);
    expect(evidence.sponsored).toBe(false);
    expect(evidence.executorAddress).toBeNull();
  });

  it("preserves explicit sponsored true and a non-null executorAddress", () => {
    const executor = "0x5af5194b4b0909eb978e3cf1e25333852277f07d";
    const evidence = buildM1Evidence({
      ...verifiedInput(),
      sponsored: true,
      executorAddress: executor,
    });

    expect(evidence.sponsored).toBe(true);
    expect(evidence.executorAddress).toBe(executor);
  });

  it("defaults simulation to null when omitted", () => {
    const input = verifiedInput();
    delete input.simulation;

    const evidence = buildM1Evidence(input);
    expect(evidence.simulation).toBeNull();
  });

  it("preserves a provided simulation object", () => {
    const evidence = buildM1Evidence({
      ...verifiedInput(),
      simulation: { success: true, gasEstimate: "65000", from: WALLET, to: USDC },
    });

    expect(evidence.simulation).toEqual({
      success: true,
      gasEstimate: "65000",
      from: WALLET,
      to: USDC,
    });
  });

  it("coerces a bigint blockNumber through Number()", () => {
    const evidence = buildM1Evidence({ ...verifiedInput(), blockNumber: BigInt(42) });
    expect(evidence.blockNumber).toBe(42);
  });
});

describe("writeM1Evidence / loadM1Evidence round-trip", () => {
  it("creates the file in a nested directory and reads it back equal", () => {
    const path = join(tmp, "artifacts", "m1.json");
    const evidence = verifiedEvidence();

    writeM1Evidence(path, evidence);

    expect(existsSync(path)).toBe(true);
    expect(loadM1Evidence(path)).toEqual(evidence);
  });

  it("returns null for a missing file", () => {
    expect(loadM1Evidence(join(tmp, "does-not-exist.json"))).toBeNull();
  });

  it("returns null for malformed JSON", () => {
    const path = join(tmp, "malformed.json");
    writeFileSync(path, "not json {{{", "utf8");
    expect(loadM1Evidence(path)).toBeNull();
  });

  it("returns null when milestone is not M1", () => {
    const path = join(tmp, "not-m1.json");
    writeFileSync(path, JSON.stringify({ milestone: "M0" }), "utf8");
    expect(loadM1Evidence(path)).toBeNull();
  });
});

describe("isVerifiedM1Evidence", () => {
  it("is false when keeperHubStatus is not completed", () => {
    expect(isVerifiedM1Evidence({ ...verifiedEvidence(), keeperHubStatus: "failed" })).toBe(false);
  });

  it("is false when onchainReceiptStatus is not success", () => {
    expect(
      isVerifiedM1Evidence({ ...verifiedEvidence(), onchainReceiptStatus: "reverted" }),
    ).toBe(false);
  });

  it("is false when transactionHash is not 0x + 64 hex chars", () => {
    expect(isVerifiedM1Evidence({ ...verifiedEvidence(), transactionHash: "0x123" })).toBe(false);
    expect(isVerifiedM1Evidence({ ...verifiedEvidence(), transactionHash: "" })).toBe(false);
  });

  it("is false when allowanceAfter is not 1", () => {
    expect(isVerifiedM1Evidence({ ...verifiedEvidence(), allowanceAfter: "0" })).toBe(false);
    expect(isVerifiedM1Evidence({ ...verifiedEvidence(), allowanceAfter: "2" })).toBe(false);
  });

  it("is true for a full verified evidence object", () => {
    expect(isVerifiedM1Evidence(verifiedEvidence())).toBe(true);
  });
});

describe("assertM1EvidenceSafe", () => {
  it("throws when any string field contains a kh_ key pattern", () => {
    expect(() =>
      assertM1EvidenceSafe({ ...verifiedEvidence(), allowanceAfter: "kh_ABC123456" }),
    ).toThrow(/forbidden secret pattern/);
  });

  it("throws when the secret pattern is nested inside approvalLog", () => {
    expect(() =>
      assertM1EvidenceSafe({
        ...verifiedEvidence(),
        approvalLog: { owner: WALLET, spender: POOL, value: "kh_LEAKED_KEY" },
      }),
    ).toThrow(/forbidden secret pattern/);
  });

  it("throws when any string field contains Authorization material", () => {
    expect(() =>
      assertM1EvidenceSafe({ ...verifiedEvidence(), transactionLink: "https://example.com/Authorization" }),
    ).toThrow(/forbidden secret pattern/);
    expect(() =>
      assertM1EvidenceSafe({ ...verifiedEvidence(), executedAt: "Bearer secret-token" }),
    ).toThrow(/forbidden secret pattern/);
  });

  it("passes for the verified evidence", () => {
    expect(() => assertM1EvidenceSafe(verifiedEvidence())).not.toThrow();
  });
});
