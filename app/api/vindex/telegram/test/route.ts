import { getDb } from "@/db";
import { getServerEnv, VindexEnvError } from "@/lib/vindex/env";
import { toApiErrorResponse } from "@/lib/vindex/errors";
import { createKeeperHubClient } from "@/lib/vindex/keeperhub";
import { sendTestAlert } from "@/lib/vindex/notification-service";
import { canonicalPositionId } from "@/lib/vindex/position-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST() {
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
    const client = createKeeperHubClient({ apiKey: env.keeperhubApiKey, baseUrl: env.keeperhubApiBaseUrl });
    const wallet = await client.getOrganizationWallet();
    if (!wallet.hasWallet || wallet.walletAddress === null) {
      return Response.json(
        { error: "KEEPERHUB_UNAVAILABLE", message: "KeeperHub organization wallet is not configured." },
        { status: 422 },
      );
    }
    const positionId = canonicalPositionId(wallet.walletAddress);
    const outcome = await sendTestAlert({ db: getDb(), positionId });
    if (outcome.delivered) {
      return Response.json({ outcome });
    }
    if (outcome.deduplicated) {
      return Response.json({ error: "IDEMPOTENCY_CONFLICT", message: "A test alert was already delivered." }, { status: 409 });
    }
    return Response.json({ error: "TELEGRAM_ALERT_FAILED", message: "The test alert could not be delivered." }, { status: 502 });
  } catch (error) {
    return toApiErrorResponse(error);
  }
}
