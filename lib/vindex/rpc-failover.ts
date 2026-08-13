// Read-only Base Sepolia RPC failover. Ordered candidate endpoints:
// BASE_SEPOLIA_RPC_URL (primary) then optional BASE_SEPOLIA_FALLBACK_RPC_URLS
// (comma/space separated). Every candidate is verified against chainId 84532
// before use; wrong-chain candidates are rejected; transport/read failures
// move to the next candidate. If all fail, RPC_ALL_UNAVAILABLE is surfaced.
// There is intentionally NO write-path RPC fallback — KeeperHub is the only
// execution layer.
import "server-only";

import { createPublicClient, http, type PublicClient } from "viem";
import { baseSepolia, VINDEX_CHAIN_ID, WrongChainError } from "./chain";
import { VindexApiError } from "./errors";

export type FailoverReadClient = {
  getChainId(): Promise<number>;
  getBlockNumber(): Promise<bigint>;
  getBytecode(params: { address: `0x${string}` }): Promise<`0x${string}` | undefined>;
  readContract(params: {
    address: `0x${string}`;
    abi: readonly unknown[];
    functionName: string;
    args?: readonly unknown[];
  }): Promise<unknown>;
  getBalance(params: { address: `0x${string}` }): Promise<bigint>;
  getTransactionReceipt(params: { hash: `0x${string}` }): Promise<{
    status: "success" | "reverted";
    from: `0x${string}`;
    to: `0x${string}` | null;
    blockNumber: bigint;
    logs: Array<{ address: string; topics: `0x${string}`[]; data: string }>;
  }>;
  getBlock(params: { blockNumber: bigint }): Promise<{ timestamp: bigint }>;
};

export const parseRpcEndpoints = (env: NodeJS.ProcessEnv = process.env): string[] => {
  const raw = [env.BASE_SEPOLIA_RPC_URL?.trim(), ...(env.BASE_SEPOLIA_FALLBACK_RPC_URLS ?? "").split(/[\s,]+/)]
    .map((value) => value?.trim())
    .filter((value): value is string => Boolean(value));
  const seen = new Set<string>();
  const endpoints: string[] = [];
  for (const value of raw) {
    try {
      const parsed = new URL(value);
      if (parsed.protocol !== "https:" && parsed.protocol !== "http:") continue;
      const normalized = parsed.toString();
      if (!seen.has(normalized)) {
        seen.add(normalized);
        endpoints.push(normalized);
      }
    } catch {
      // invalid endpoint entries are skipped
    }
  }
  return endpoints;
};

type CandidateClient = {
  url: string;
  client: PublicClient;
  verified: boolean;
  dead: boolean;
  lastError: string | null;
};

type ReadParams = Parameters<PublicClient["readContract"]>[0];

export class FailoverCanonicalClient implements FailoverReadClient {
  private readonly candidates: CandidateClient[];
  private servedBy: string | null = null;
  private failures: Array<{ url: string; error: string }> = [];

  constructor(rpcUrls: string[]) {
    if (rpcUrls.length === 0) {
      throw new VindexApiError("RPC_ALL_UNAVAILABLE", "No Base Sepolia RPC endpoints configured.", 503);
    }
    this.candidates = rpcUrls.map((url) => ({
      url,
      client: createPublicClient({
        chain: baseSepolia,
        transport: http(url, { timeout: 10_000 }),
        batch: { multicall: true },
      }) as PublicClient,
      verified: false,
      dead: false,
      lastError: null,
    }));
  }

  /** The URL that served the most recent successful call, if any. */
  servedRpc(): string | null {
    return this.servedBy;
  }

  /** Ordered diagnostics of candidate failures (URLs only — never secrets). */
  failureDiagnostics(): Array<{ url: string; error: string }> {
    return [...this.failures];
  }

  private async execute<T>(call: (client: PublicClient) => Promise<T>): Promise<T> {
    for (const candidate of this.candidates) {
      if (candidate.dead) continue;

      // Verify chain identity before use; a wrong-chain endpoint is rejected.
      if (!candidate.verified) {
        try {
          const chainId = await candidate.client.getChainId();
          if (chainId !== VINDEX_CHAIN_ID) {
            candidate.dead = true;
            candidate.lastError = `wrong chain ${chainId}`;
            this.failures.push({ url: candidate.url, error: `wrong chain ${chainId}` });
            continue;
          }
          candidate.verified = true;
        } catch (error) {
          candidate.lastError = error instanceof Error ? error.message : "chain verification failed";
          this.failures.push({ url: candidate.url, error: candidate.lastError });
          continue;
        }
      }

      try {
        const result = await call(candidate.client);
        this.servedBy = candidate.url;
        return result;
      } catch (error) {
        if (error instanceof WrongChainError) {
          candidate.dead = true;
          candidate.lastError = error.message;
          this.failures.push({ url: candidate.url, error: error.message });
          continue;
        }
        candidate.lastError = error instanceof Error ? error.message : "RPC call failed";
        this.failures.push({ url: candidate.url, error: candidate.lastError });
      }
    }
    throw new VindexApiError(
      "RPC_ALL_UNAVAILABLE",
      "All Base Sepolia RPC endpoints are unavailable.",
      503,
    );
  }

  getChainId(): Promise<number> {
    return this.execute((client) => client.getChainId());
  }

  getBlockNumber(): Promise<bigint> {
    return this.execute((client) => client.getBlockNumber());
  }

  getBytecode(params: { address: `0x${string}` }): Promise<`0x${string}` | undefined> {
    return this.execute((client) => client.getBytecode(params));
  }

  readContract(params: ReadParams): Promise<unknown> {
    return this.execute((client) => client.readContract(params));
  }

  getBalance(params: { address: `0x${string}` }): Promise<bigint> {
    return this.execute((client) => client.getBalance(params));
  }

  getTransactionReceipt(params: { hash: `0x${string}` }): Promise<FailoverReadClient["getTransactionReceipt"] extends (p: { hash: `0x${string}` }) => Promise<infer T> ? T : never> {
    return this.execute((client) =>
      client.getTransactionReceipt(params).then((receipt) => ({
        status: receipt.status,
        from: receipt.from,
        to: receipt.to,
        blockNumber: receipt.blockNumber,
        logs: receipt.logs.map((log) => ({
          address: log.address,
          topics: log.topics,
          data: log.data,
        })),
      })),
    );
  }

  getBlock(params: { blockNumber: bigint }): Promise<{ timestamp: bigint }> {
    return this.execute((client) =>
      client.getBlock({ blockNumber: params.blockNumber }).then((block) => ({ timestamp: block.timestamp })),
    );
  }
}

export const createFailoverPublicClient = (
  env: NodeJS.ProcessEnv = process.env,
): FailoverCanonicalClient => new FailoverCanonicalClient(parseRpcEndpoints(env));

