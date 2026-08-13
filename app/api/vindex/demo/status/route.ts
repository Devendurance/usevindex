import { getDb } from "@/db";
import { getDemoLifecycleStatus } from "@/lib/vindex/demo-controller";
import { getServerEnv, VindexEnvError } from "@/lib/vindex/env";
import { toApiErrorResponse } from "@/lib/vindex/errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Authoritative lifecycle view for the live website demo. Read-only except
// the idempotent self-heal inside the controller (armed policy after a
// PROTECTED event is settled once on first read).
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
    const view = await getDemoLifecycleStatus(env, getDb());
    return Response.json(view);
  } catch (error) {
    return toApiErrorResponse(error);
  }
}
