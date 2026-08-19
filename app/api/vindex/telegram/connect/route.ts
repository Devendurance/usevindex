import { getDb } from "@/db";
import { getTelegramEnv, getServerEnv, VindexEnvError } from "@/lib/vindex/env";
import { toApiErrorResponse } from "@/lib/vindex/errors";
import { createKeeperHubClient } from "@/lib/vindex/keeperhub";
import { canonicalPositionId } from "@/lib/vindex/position-service";
import { createConnectToken } from "@/lib/vindex/telegram-connect";

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
  const telegram = getTelegramEnv();
  if (telegram === null) {
    return Response.json(
      { error: "SERVER_NOT_CONFIGURED", message: "Telegram is not configured. Set TELEGRAM_BOT_TOKEN, TELEGRAM_BOT_USERNAME and TELEGRAM_WEBHOOK_SECRET." },
      { status: 503 },
    );
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
    const { token, expiresAt } = await createConnectToken(getDb(), positionId);
    return Response.json({
      token,
      botUsername: telegram.botUsername,
      connectUrl: `https://t.me/${telegram.botUsername}?start=${token}`,
      expiresAt: expiresAt.toISOString(),
    });
  } catch (error) {
    return toApiErrorResponse(error);
  }
}
