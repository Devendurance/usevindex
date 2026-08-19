import { getDb } from "@/db";
import { getServerEnv, VindexEnvError } from "@/lib/vindex/env";
import { toApiErrorResponse } from "@/lib/vindex/errors";
import { collectLiveSignalObservations } from "@/lib/vindex/signal-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// PostgreSQL write ONLY. Never calls KeeperHub, never writes onchain.
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
    const result = await collectLiveSignalObservations({ env, db: getDb() });
    return Response.json(result);
  } catch (error) {
    return toApiErrorResponse(error);
  }
}
