import { getDb } from "@/db";
import { getServerEnv, VindexEnvError } from "@/lib/vindex/env";
import { toApiErrorResponse } from "@/lib/vindex/errors";
import { getLatestRescueReceipt } from "@/lib/vindex/verification-service";
import { canonicalPositionId } from "@/lib/vindex/position-service";
import { createKeeperHubClient } from "@/lib/vindex/keeperhub";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Read-only: the latest Rescue Receipt for the position, if any.
export async function GET() {
  let env;
  try {
    env = getServerEnv();
  } catch (error) {
    if (error instanceof VindexEnvError) {
      return Response.json({ error: "SERVER_NOT_CONFIGURED", message: error.message }, { status: 503 });
    }
    return Response.json({ error: "SERVER_NOT_CONFIGURED", message: "Server not configured." }, { status: 503 });
  }

  try {
    const client = createKeeperHubClient({
      apiKey: env.keeperhubApiKey,
      baseUrl: env.keeperhubApiBaseUrl,
    });
    const wallet = await client.getOrganizationWallet();
    if (!wallet.hasWallet || wallet.walletAddress === null) {
      return Response.json(
        { error: "KEEPERHUB_UNAVAILABLE", message: "KeeperHub organization wallet is not configured." },
        { status: 422 },
      );
    }
    const positionId = canonicalPositionId(wallet.walletAddress);
    const receipt = await getLatestRescueReceipt(getDb(), positionId);
    return Response.json({ receipt });
  } catch (error) {
    return toApiErrorResponse(error);
  }
}
