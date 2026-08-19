import "server-only";

import { VINDEX_CHAIN_ID, WrongChainError } from "./chain";
import { verifyAaveFoundation, type FoundationContractsReport } from "./contract-verification";
import type { VindexEnv } from "./env";
import { createKeeperHubClient, isKeeperHubHealthy, type KeeperHubHealth } from "./keeperhub";
import { CANONICAL_MOCKS_DISABLED } from "./mock-guard";
import { createCanonicalPublicClient, readCanonicalChainState } from "./public-client";

export type FoundationVerificationReport = {
  passed: boolean;
  checkedAt: string;
  chain: {
    expectedChainId: number;
    actualChainId: number | null;
    chainVerified: boolean;
    latestBlock: number | null;
    error: string | null;
  };
  contracts: FoundationContractsReport | null;
  keeperhub: {
    health: KeeperHubHealth | null;
    healthy: boolean;
    error: string | null;
  };
  mocksDisabled: boolean;
};

export async function runFoundationVerification(env: VindexEnv): Promise<FoundationVerificationReport> {
  const checkedAt = new Date().toISOString();
  const client = createCanonicalPublicClient(env.baseSepoliaRpcUrl);

  // Chain state — fail closed on any mismatch or read failure.
  let actualChainId: number | null = null;
  let latestBlock: number | null = null;
  let chainError: string | null = null;
  let chainVerified = false;

  try {
    const state = await readCanonicalChainState(client);
    actualChainId = state.chainId;
    latestBlock = Number(state.latestBlock);
    chainVerified = true;
  } catch (error) {
    if (error instanceof WrongChainError) {
      actualChainId = error.actualChainId;
    }
    chainError = error instanceof Error ? error.message : "Failed to read canonical chain state";
  }

  // Contract checks run only on the verified canonical chain — on any other
  // chain their results would be meaningless, so the report fails closed with
  // contracts = null. Every individual check handles its own RPC errors.
  const contracts = chainVerified ? await verifyAaveFoundation(client) : null;

  let keeperhubHealth: KeeperHubHealth | null = null;
  let keeperhubError: string | null = null;
  try {
    const keeperHubClient = createKeeperHubClient({
      apiKey: env.keeperhubApiKey,
      baseUrl: env.keeperhubApiBaseUrl,
    });
    keeperhubHealth = await keeperHubClient.healthCheck();
  } catch (error) {
    keeperhubError = error instanceof Error ? error.message : "KeeperHub health check failed";
  }
  const healthy = keeperhubHealth !== null && isKeeperHubHealthy(keeperhubHealth);

  const passed =
    chainVerified &&
    contracts !== null &&
    contracts.allPassed &&
    healthy &&
    CANONICAL_MOCKS_DISABLED;

  return {
    passed,
    checkedAt,
    chain: {
      expectedChainId: VINDEX_CHAIN_ID,
      actualChainId,
      chainVerified,
      latestBlock,
      error: chainError,
    },
    contracts,
    keeperhub: { health: keeperhubHealth, healthy, error: keeperhubError },
    mocksDisabled: CANONICAL_MOCKS_DISABLED,
  };
}
