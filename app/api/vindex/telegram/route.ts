import { getDb } from "@/db";
import { getServerEnv, VindexEnvError } from "@/lib/vindex/env";
import { toApiErrorResponse, VindexApiError } from "@/lib/vindex/errors";
import { createKeeperHubClient } from "@/lib/vindex/keeperhub";
import { canonicalPositionId } from "@/lib/vindex/position-service";
import {
  disconnectTelegram,
  getTelegramStatus,
  updateTelegramToggles,
} from "@/lib/vindex/telegram-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const resolvePositionId = async () => {
  const env = getServerEnv();
  const client = createKeeperHubClient({ apiKey: env.keeperhubApiKey, baseUrl: env.keeperhubApiBaseUrl });
  const wallet = await client.getOrganizationWallet();
  if (!wallet.hasWallet || wallet.walletAddress === null) {
    throw new VindexApiError(
      "KEEPERHUB_UNAVAILABLE",
      "KeeperHub organization wallet is not configured.",
      422,
    );
  }
  return canonicalPositionId(wallet.walletAddress);
};

const withEnv = async <T>(fn: () => Promise<T>): Promise<Response> => {
  try {
    return Response.json(await fn());
  } catch (error) {
    if (error instanceof VindexEnvError) {
      return Response.json({ error: "SERVER_NOT_CONFIGURED", message: error.message }, { status: 503 });
    }
    return toApiErrorResponse(error);
  }
};

export async function GET() {
  return withEnv(async () => getTelegramStatus(getDb(), await resolvePositionId()));
}

export async function PATCH(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "BAD_REQUEST", message: "Request body must be valid JSON." }, { status: 400 });
  }
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return Response.json({ error: "BAD_REQUEST", message: "Request body must be a JSON object." }, { status: 400 });
  }
  const keys = Object.keys(body as Record<string, unknown>);
  if (keys.some((key) => key !== "riskAlertsEnabled" && key !== "withdrawalAlertsEnabled")) {
    return Response.json(
      { error: "UNKNOWN_FIELD", message: "Only riskAlertsEnabled and withdrawalAlertsEnabled are accepted." },
      { status: 400 },
    );
  }
  const record = body as Record<string, unknown>;
  const toggles: { riskAlertsEnabled?: boolean; withdrawalAlertsEnabled?: boolean } = {};
  for (const key of ["riskAlertsEnabled", "withdrawalAlertsEnabled"] as const) {
    if (record[key] !== undefined) {
      if (typeof record[key] !== "boolean") {
        return Response.json({ error: "BAD_REQUEST", message: `${key} must be a boolean.` }, { status: 400 });
      }
      toggles[key] = record[key];
    }
  }
  return withEnv(async () =>
    updateTelegramToggles(getDb(), await resolvePositionId(), toggles),
  );
}

export async function DELETE() {
  return withEnv(async () => disconnectTelegram(getDb(), await resolvePositionId()));
}
