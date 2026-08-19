import "server-only";
import { createPublicClient, http, type HttpTransport, type PublicClient } from "viem";
import { baseSepolia, CANONICAL_CHAIN, assertCanonicalChainId } from "./chain";

export type CanonicalReadClient = Pick<
  PublicClient,
  | "getChainId"
  | "getBlockNumber"
  | "getBytecode"
  | "readContract"
  | "getBalance"
  | "getTransactionReceipt"
>;

export function createCanonicalPublicClient(
  rpcUrl?: string,
): PublicClient<HttpTransport, typeof baseSepolia> {
  return createPublicClient({
    chain: baseSepolia,
    transport: http(rpcUrl ?? CANONICAL_CHAIN.defaultRpcUrl),
    batch: { multicall: true },
  });
}

export async function readCanonicalChainState(
  client: CanonicalReadClient,
): Promise<{ chainId: number; latestBlock: bigint }> {
  const chainId = await client.getChainId();
  assertCanonicalChainId(chainId);
  const latestBlock = await client.getBlockNumber();
  return { chainId, latestBlock };
}
