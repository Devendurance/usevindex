import { getDb } from "@/db";
import { getServerEnv, VindexEnvError } from "@/lib/vindex/env";
import { toApiErrorResponse } from "@/lib/vindex/errors";
import { canonicalPositionId } from "@/lib/vindex/position-service";
import { armPolicy, disarmPolicy, evaluateProtectionPolicy } from "@/lib/vindex/policy-service";
import { createKeeperHubClient } from "@/lib/vindex/keeperhub";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Accepts NO signal values or custom thresholds — the drill uses the fixed
// DRILL_HIGH_SENSITIVITY template and real M4 observations only.
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

  const raw = await request.text().catch(() => "");
  if (raw.trim() !== "") {
    return Response.json(
      { error: "BAD_REQUEST", message: "/drills/start accepts no body — the drill policy and thresholds are fixed server-side." },
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

    // Arm (or reuse) the DRILL policy — rerun-safe: arming an already-armed
    // DRILL policy returns the existing armed policy.
    await armPolicy({ env, db: getDb(), positionId, mode: "DRILL_HIGH_SENSITIVITY" });

    // Fresh M4 collection, then evaluate with confirmation re-read.
    const { collectLiveSignalObservations } = await import("@/lib/vindex/signal-service");
    const db = getDb();
    await collectLiveSignalObservations({ env, db });

    const view = await evaluateProtectionPolicy({ env, db, positionId });
    return Response.json(view);
  } catch (error) {
    return toApiErrorResponse(error);
  }
}

export async function DELETE() {
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
    const result = await disarmPolicy(getDb(), positionId);
    return Response.json(result);
  } catch (error) {
    return toApiErrorResponse(error);
  }
}
