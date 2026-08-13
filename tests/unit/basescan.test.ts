// Canonical BaseScan Sepolia links: href is always derived from the full
// verified transaction hash and is always a plain URL — Markdown is impossible.

import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";

import { buildBaseScanTxUrl, safeBaseScanTxUrl } from "../../lib/vindex/basescan";

const HASH = "0x22670c665c86ad8d782fa1ff954ff4b6bf20a29d66a715378ed9d90efdff0806";
const EXPECTED = `https://sepolia.basescan.org/tx/${HASH}`;

describe("buildBaseScanTxUrl", () => {
  it("builds the canonical href from the full hash", () => {
    expect(buildBaseScanTxUrl(HASH)).toBe(EXPECTED);
  });

  it("trims surrounding whitespace", () => {
    expect(buildBaseScanTxUrl(`  ${HASH}  `)).toBe(EXPECTED);
  });

  it("rejects invalid hashes", () => {
    expect(() => buildBaseScanTxUrl("0x1234")).toThrow();
    const upperHex = `0x${HASH.slice(2).toUpperCase()}`;
    expect(() => buildBaseScanTxUrl(upperHex)).not.toThrow(); // hex letters may be upper-case
    expect(() => buildBaseScanTxUrl(`${HASH}ff`)).toThrow(); // 65 hex chars
    expect(() => buildBaseScanTxUrl("https://sepolia.basescan.org/tx/abc")).toThrow();
    expect(() => buildBaseScanTxUrl("")).toThrow();
  });
});

describe("safeBaseScanTxUrl", () => {
  it("returns null instead of throwing", () => {
    expect(safeBaseScanTxUrl(null)).toBeNull();
    expect(safeBaseScanTxUrl("0x1234")).toBeNull();
    expect(safeBaseScanTxUrl(HASH)).toBe(EXPECTED);
  });
});

describe("TxLink markup", () => {
  it("renders a plain anchor with target/rel and no Markdown", async () => {
    const source = await readFile("components/vindex/tx-link.tsx", "utf8");
    expect(source).toContain('target="_blank"');
    expect(source).toContain('rel="noopener noreferrer"');
    expect(source).toContain("href=");
    // The component must render an <a>, never a Markdown "[url](url)" string.
    expect(source).not.toMatch(/\[[^\]]+\]\(/);
    expect(source).not.toMatch(/`\[|\[https?:\/\//);
  });
});
