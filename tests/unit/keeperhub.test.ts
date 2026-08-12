import { describe, expect, it } from "vitest";
import {
  createKeeperHubClient,
  isKeeperHubHealthy,
} from "../../lib/vindex/keeperhub";

const API_KEY = "kh_SECRET_KEY_ABC";

type RecordedRequest = { url: string; headers: Headers };

/** Fetch stub that maps URL suffixes to status codes; never touches the network. */
function createRouteStub(routes: Record<string, number>): {
  fetchFn: typeof fetch;
  requests: RecordedRequest[];
} {
  const requests: RecordedRequest[] = [];
  const fetchFn: typeof fetch = async (input, init) => {
    const url = String(input);
    requests.push({ url, headers: new Headers(init?.headers) });
    const match = Object.entries(routes).find(([suffix]) => url.endsWith(suffix));
    return new Response(null, { status: match ? match[1] : 404 });
  };
  return { fetchFn, requests };
}

describe("createKeeperHubClient healthCheck", () => {
  it("never leaks the api key or auth header into the health result", async () => {
    const { fetchFn, requests } = createRouteStub({ "/api/chains": 200, "/api/keys": 200 });
    const client = createKeeperHubClient({ apiKey: API_KEY, fetchFn });
    const health = await client.healthCheck();

    const serialized = JSON.stringify(health);
    expect(serialized).not.toContain(API_KEY);
    expect(serialized).not.toContain("Bearer");

    // The public reachability probe must not carry the bearer token; the auth
    // probe must carry it.
    const chainsRequest = requests.find((request) => request.url.endsWith("/api/chains"));
    const keysRequest = requests.find((request) => request.url.endsWith("/api/keys"));
    expect(chainsRequest?.headers.get("Authorization")).toBeNull();
    expect(keysRequest?.headers.get("Authorization")).toBe(`Bearer ${API_KEY}`);
  });

  it("is healthy when both probes succeed", async () => {
    const { fetchFn } = createRouteStub({ "/api/chains": 200, "/api/keys": 200 });
    const client = createKeeperHubClient({ apiKey: API_KEY, fetchFn });
    const health = await client.healthCheck();
    expect(health.reachable).toBe(true);
    expect(health.authenticated).toBe(true);
    expect(health.errorCategory).toBeNull();
    expect(isKeeperHubHealthy(health)).toBe(true);
    expect(JSON.stringify(health)).not.toContain(API_KEY);
  });

  it("treats a reachable but unauthenticated endpoint as unhealthy", async () => {
    const { fetchFn } = createRouteStub({ "/api/chains": 200, "/api/keys": 401 });
    const client = createKeeperHubClient({ apiKey: API_KEY, fetchFn });
    const health = await client.healthCheck();
    expect(health.reachable).toBe(true);
    expect(health.authenticated).toBe(false);
    expect(health.errorCategory).toBe("unauthorized");
    expect(isKeeperHubHealthy(health)).toBe(false);
    expect(JSON.stringify(health)).not.toContain(API_KEY);
  });

  it("reports a network error when the reachability probe fails", async () => {
    const client = createKeeperHubClient({
      apiKey: API_KEY,
      fetchFn: async () => {
        throw new Error("ECONNREFUSED");
      },
    });
    const health = await client.healthCheck();
    expect(health.reachable).toBe(false);
    expect(health.authenticated).toBe(false);
    expect(health.statusCode).toBeNull();
    expect(health.errorCategory).toBe("network");
    expect(isKeeperHubHealthy(health)).toBe(false);
    expect(JSON.stringify(health)).not.toContain(API_KEY);
  });

  it("classifies kh_ prefixed keys as org keys", async () => {
    const { fetchFn } = createRouteStub({ "/api/chains": 200, "/api/keys": 200 });
    const health = await createKeeperHubClient({ apiKey: "kh_org_123", fetchFn }).healthCheck();
    expect(health.keyShape).toBe("kh_org");
  });

  it("classifies non-kh_ keys as other", async () => {
    const { fetchFn } = createRouteStub({ "/api/chains": 200, "/api/keys": 200 });
    const health = await createKeeperHubClient({ apiKey: "wfb_org_123", fetchFn }).healthCheck();
    expect(health.keyShape).toBe("other");
    expect(JSON.stringify(health)).not.toContain("wfb_org_123");
  });

  it.each([
    [429, "rate_limited"],
    [500, "server"],
    [403, "unauthorized"],
  ] as const)("maps status %i to error category %s", async (status, expectedCategory) => {
    const { fetchFn } = createRouteStub({ "/api/chains": 200, "/api/keys": status });
    const client = createKeeperHubClient({ apiKey: API_KEY, fetchFn });
    const health = await client.healthCheck();
    expect(health.reachable).toBe(true);
    expect(health.authenticated).toBe(false);
    expect(health.statusCode).toBe(status);
    expect(health.errorCategory).toBe(expectedCategory);
    expect(isKeeperHubHealthy(health)).toBe(false);
    expect(JSON.stringify(health)).not.toContain(API_KEY);
  });
});
