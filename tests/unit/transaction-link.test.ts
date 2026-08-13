// transactionLink normalization: persisted evidence must always expose a plain
// https URL, never Markdown-formatted "[url](url)" values.

import { describe, expect, it } from "vitest";

import { normalizeTransactionLink } from "../../lib/vindex/validation";

const TX_HASH = "0x14e84855f63b09831fc7e23ccc31f009acf6f73fb5eb483e745d0954d2777cc5";
const PLAIN_URL = `https://sepolia.basescan.org/tx/${TX_HASH}`;

describe("normalizeTransactionLink", () => {
  it("passes a plain https URL through unchanged", () => {
    expect(normalizeTransactionLink(PLAIN_URL)).toBe(PLAIN_URL);
  });

  it("strips Markdown link formatting to the plain URL", () => {
    expect(normalizeTransactionLink(`[${PLAIN_URL}](${PLAIN_URL})`)).toBe(PLAIN_URL);
    expect(normalizeTransactionLink(`[BaseScan](${PLAIN_URL})`)).toBe(PLAIN_URL);
  });

  it("rejects null, empty and non-https values", () => {
    expect(normalizeTransactionLink(null)).toBeNull();
    expect(normalizeTransactionLink("   ")).toBeNull();
    expect(normalizeTransactionLink("http://sepolia.basescan.org/tx/abc")).toBeNull();
    expect(normalizeTransactionLink("not-a-url")).toBeNull();
    expect(normalizeTransactionLink(`[${PLAIN_URL}](http://insecure.example)`)).toBeNull();
  });
});

describe("evidence serialization", () => {
  it("the receipt builder never emits Markdown-formatted links", async () => {
    const source = await import("fs/promises").then((fs) =>
      fs.readFile("lib/vindex/verification-service.ts", "utf8"),
    );
    expect(source).toContain("normalizeTransactionLink");
    expect(source).not.toMatch(/"\[https?:\/\//);
  });

  it("the execution service normalizes links at the persistence boundary", async () => {
    const source = await import("fs/promises").then((fs) =>
      fs.readFile("lib/vindex/execution-service.ts", "utf8"),
    );
    expect(source).toContain("normalizeTransactionLink");
    expect(source).not.toMatch(/"\[https?:\/\//);
  });
});
