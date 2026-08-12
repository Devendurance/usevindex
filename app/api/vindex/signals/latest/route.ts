import { getDb } from "@/db";
import { getServerEnv, VindexEnvError } from "@/lib/vindex/env";
import { toApiErrorResponse } from "@/lib/vindex/errors";
import { canonicalPositionId } from "@/lib/vindex/position-service";
import { getLatestSignalObservations } from "@/lib/vindex/signal-service";
import { createKeeperHubClient } from "@/lib/vindex/keeperhub";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

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
    const result = await getLatestSignalObservations(getDb(), positionId.trim());
    return Response.json(result);
  } catch (error) {
    return toApiErrorResponse(error);
  }
}
