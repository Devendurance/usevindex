import { getDb } from "@/db";
import { getServerEnv, VindexEnvError } from "@/lib/vindex/env";
import { toApiErrorResponse } from "@/lib/vindex/errors";
import { canonicalPositionId } from "@/lib/vindex/position-service";
import { armPolicy } from "@/lib/vindex/policy-service";
import type { PolicyMode } from "@/lib/vindex/policy-templates";
import { createKeeperHubClient } from "@/lib/vindex/keeperhub";
import { POLICY_MODES } from "@/lib/vindex/policy-templates";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  let env;
  try {
    env = getServerEnv();
  } catch (error) {
    if (error instanceof VindexEnvError) {
      return Response.json({ error: "SERVER_NOT_CONFIGURED", message: error.message }, { status: 503 });
    }
    return Response.json({ error: "SERVER_NOT_CONFIGURED", message: "Server not configured." }, { status: 503 });
  }

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
  if (keys.some((key) => key !== "mode")) {
    return Response.json(
      { error: "UNKNOWN_FIELD", message: "Only the mode field is accepted." },
      { status: 400 },
    );
  }
  const mode = (body as Record<string, unknown>).mode;
  if (typeof mode !== "string" || !POLICY_MODES.includes(mode as PolicyMode)) {
    return Response.json(
      { error: "BAD_REQUEST", message: `mode must be one of ${POLICY_MODES.join(", ")}.` },
      { status: 400 },
    );
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
    const policy = await armPolicy({ env, db: getDb(), positionId, mode: mode as PolicyMode });
    return Response.json(policy);
  } catch (error) {
    return toApiErrorResponse(error);
  }
}
