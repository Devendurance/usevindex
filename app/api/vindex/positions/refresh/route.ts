import { getDb } from "@/db";
import { getServerEnv, VindexEnvError } from "@/lib/vindex/env";
import { toApiErrorResponse } from "@/lib/vindex/errors";
import { refreshCurrentProtectedPosition } from "@/lib/vindex/position-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// READS ONLY. This route never funds, approves, supplies, withdraws, or
// executes any KeeperHub write — the position service has no write capability.
export async function POST() {
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
    const model = await refreshCurrentProtectedPosition({ env, db: getDb() });
    return Response.json(model);
  } catch (error) {
    return toApiErrorResponse(error);
  }
}
