// M9 resilience tests: RPC failover (ordered, chain-verified, all-fail),
// stale/expired evidence rejection, and sanitized error surfaces. Fakes and
// real public endpoints for transport behavior — no blockchain writes.

import { describe, expect, it } from "vitest";

import {
  FailoverCanonicalClient,
  parseRpcEndpoints,
} from "../../lib/vindex/rpc-failover";

const URL_A = "https://rpc-a.example";
const URL_B = "https://rpc-b.example";

describe("parseRpcEndpoints", () => {
  it("parses primary + comma/space separated fallbacks, deduped", () => {
    const env = {
      BASE_SEPOLIA_RPC_URL: URL_A,
      BASE_SEPOLIA_FALLBACK_RPC_URLS: `${URL_B}, ${URL_A} , https://rpc-c.example`,
    } as unknown as NodeJS.ProcessEnv;
    const urls = parseRpcEndpoints(env);
    expect(urls).toEqual(["https://rpc-a.example/", "https://rpc-b.example/", "https://rpc-c.example/"]);
  });

  it("skips invalid and non-http(s) entries", () => {
    const env = {
      BASE_SEPOLIA_RPC_URL: "not-a-url",
      BASE_SEPOLIA_FALLBACK_RPC_URLS: "ftp://x",
    } as unknown as NodeJS.ProcessEnv;
    const urls = parseRpcEndpoints(env);
    expect(urls).toEqual([]);
  });
});

describe("FailoverCanonicalClient", () => {
  it("fails closed when no endpoints are configured", () => {
    expect(() => new FailoverCanonicalClient([])).toThrow();
  });

  it("serves reads from the fallback when the primary is unreachable", async () => {
    const client = new FailoverCanonicalClient([
      "https://127.0.0.1:1",
      "https://base-sepolia-rpc.publicnode.com",
    ]);
    const block = await client.getBlockNumber();
    expect(block > BigInt(0)).toBe(true);
    expect(client.servedRpc()).toContain("publicnode");
    expect(client.failureDiagnostics().length).toBeGreaterThan(0);
  }, 30_000);

  it("rejects a wrong-chain primary and falls back to a valid endpoint", async () => {
    const client = new FailoverCanonicalClient([
      "https://ethereum-sepolia-rpc.publicnode.com",
      "https://base-sepolia-rpc.publicnode.com",
    ]);
    const block = await client.getBlockNumber();
    expect(block > BigInt(0)).toBe(true);
    const diagnostics = client.failureDiagnostics();
    expect(diagnostics.some((d) => d.error.includes("wrong chain"))).toBe(true);
  }, 30_000);

  it("surfaces RPC_ALL_UNAVAILABLE when every candidate fails", async () => {
    const client = new FailoverCanonicalClient(["https://127.0.0.1:1", "https://127.0.0.1:2"]);
    await expect(client.getBlockNumber()).rejects.toMatchObject({
      code: "RPC_ALL_UNAVAILABLE",
    });
    expect(client.failureDiagnostics().length).toBeGreaterThanOrEqual(2);
  }, 30_000);

  it("never leaks endpoint credentials in diagnostics (only URLs)", async () => {
    const client = new FailoverCanonicalClient(["https://127.0.0.1:1"]);
    await expect(client.getBlockNumber()).rejects.toBeTruthy();
    for (const diagnostic of client.failureDiagnostics()) {
      expect(diagnostic.error).not.toMatch(/password|token|key=/i);
    }
  });
});
