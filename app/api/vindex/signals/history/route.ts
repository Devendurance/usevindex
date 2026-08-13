import { getDb } from "@/db";
import { getServerEnv, VindexEnvError } from "@/lib/vindex/env";
import { toApiErrorResponse } from "@/lib/vindex/errors";
import { canonicalPositionId } from "@/lib/vindex/position-service";
import {
  getSignalHistory,
  type SignalMetric,
  type SignalSourceFamily,
} from "@/lib/vindex/signal-service";
import { createKeeperHubClient } from "@/lib/vindex/keeperhub";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const FAMILY_WHITELIST = new Set<SignalSourceFamily>([
  "ORACLE_PRICE_STATE",
  "AAVE_RESERVE_STATE",
  "POSITION_STATE",
]);

// Read-only: never mutates anything.
export async function GET(request: Request) {
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
    const url = new URL(request.url);
    const positionParam = url.searchParams.get("positionId");
    let positionId = positionParam ?? null;
    if (positionId === null) {
      const client = createKeeperHubClient({
        apiKey: env.keeperhubApiKey,
        baseUrl: env.keeperhubApiBaseUrl,
      });
      const wallet = await client.getOrganizationWallet();
      if (wallet.hasWallet && wallet.walletAddress !== null) {
        positionId = canonicalPositionId(wallet.walletAddress);
      }
    }
    if (positionId === null || positionId.trim() === "") {
      return Response.json(
        { error: "BAD_REQUEST", message: "positionId is required." },
        { status: 400 },
      );
    }

    const family = url.searchParams.get("family") as SignalSourceFamily | null;
    if (family !== null && !FAMILY_WHITELIST.has(family)) {
      return Response.json(
        { error: "BAD_REQUEST", message: "family must be one of ORACLE_PRICE_STATE, AAVE_RESERVE_STATE, POSITION_STATE." },
        { status: 400 },
      );
    }
    const metric = url.searchParams.get("metric") as SignalMetric | null;
    const limitRaw = url.searchParams.get("limit");
    const limit = limitRaw !== null ? Number.parseInt(limitRaw, 10) : undefined;

    const history = await getSignalHistory(getDb(), positionId.trim(), {
      family: family ?? undefined,
      metric: metric ?? undefined,
      limit: Number.isFinite(limit) ? limit : undefined,
    });
    return Response.json({ positionId: positionId.trim(), count: history.length, observations: history });
  } catch (error) {
    return toApiErrorResponse(error);
  }
}
