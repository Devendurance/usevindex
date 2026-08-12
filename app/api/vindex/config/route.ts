import { getDb } from "@/db";
import { VINDEX_CHAIN_ID } from "@/lib/vindex/chain";
import { getServerEnv, VindexEnvError, type VindexEnv } from "@/lib/vindex/env";
import { toApiErrorResponse } from "@/lib/vindex/errors";
import { canonicalPositionId } from "@/lib/vindex/position-service";
import { assertSafeWalletChangeAllowed } from "@/lib/vindex/policy-service";
import {
  getSafeWalletConfig,
  parseConfigUpdate,
  setSafeWalletConfig,
  validateSafeWallet,
} from "@/lib/vindex/safe-wallet";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const executionWalletFrom = async (env: VindexEnv) => {
  const { createKeeperHubClient } = await import("@/lib/vindex/keeperhub");
  const client = createKeeperHubClient({
    apiKey: env.keeperhubApiKey,
    baseUrl: env.keeperhubApiBaseUrl,
  });
  const wallet = await client.getOrganizationWallet();
  return wallet.walletAddress;
};

export async function GET() {
  let env;
  try {
    env = getServerEnv();
  } catch (error) {
    if (error instanceof VindexEnvError) {
      return Response.json(
        { error: "SERVER_NOT_CONFIGURED", message: error.message },
        { status: 503 },
      );
    }
    return Response.json({ error: "SERVER_NOT_CONFIGURED", message: "Server not configured." }, { status: 503 });
  }

  try {
    const db = getDb();
    const config = await getSafeWalletConfig(db);
    const executionWallet = await executionWalletFrom(env).catch(() => null);
    return Response.json({
      safeWallet: config.safeWallet,
      configured: config.configured,
      chainId: VINDEX_CHAIN_ID,
      executionWallet,
      configuredAt: config.configuredAt,
      updatedAt: config.updatedAt,
    });
  } catch (error) {
    return toApiErrorResponse(error);
  }
}

export async function PUT(request: Request) {
  let env;
  try {
    env = getServerEnv();
  } catch (error) {
    if (error instanceof VindexEnvError) {
      return Response.json(
        { error: "SERVER_NOT_CONFIGURED", message: error.message },
        { status: 503 },
      );
    }
    return Response.json({ error: "SERVER_NOT_CONFIGURED", message: "Server not configured." }, { status: 503 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "BAD_REQUEST", message: "Request body must be valid JSON." }, { status: 400 });
  }

  const parsed = parseConfigUpdate(body);
  if ("error" in parsed) {
    return Response.json(
      { error: parsed.error.code, message: parsed.error.message },
      { status: parsed.error.status },
    );
  }

  const executionWallet = await executionWalletFrom(env).catch(() => null);
  const validation = validateSafeWallet(parsed.safeWallet, executionWallet ?? "");
  if (!validation.valid) {
    return Response.json(
      { error: "INVALID_SAFE_WALLET", message: validation.reason },
      { status: 400 },
    );
  }

  try {
    const db = getDb();
    // While a protection policy is armed, the safe wallet is pinned to the
    // armed snapshot — changing it requires a disarm first.
    const positionId = canonicalPositionId(executionWallet ?? "");
    if (positionId !== "") {
      await assertSafeWalletChangeAllowed(db, positionId);
    }
    const config = await setSafeWalletConfig(db, validation.normalized);
    return Response.json({
      safeWallet: config.safeWallet,
      configured: config.configured,
      chainId: VINDEX_CHAIN_ID,
      executionWallet,
      configuredAt: config.configuredAt,
      updatedAt: config.updatedAt,
    });
  } catch (error) {
    return toApiErrorResponse(error);
  }
}
