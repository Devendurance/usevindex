import { getServerEnv, VindexEnvError } from "@/lib/vindex/env";
import { runFoundationVerification } from "@/lib/vindex/foundation";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(): Promise<Response> {
  try {
    const report = await runFoundationVerification(getServerEnv());
    return Response.json(report);
  } catch (error) {
    if (error instanceof VindexEnvError) {
      // VindexEnvError messages reference only variable names, never values.
      return Response.json(
        { error: "server_not_configured", message: error.message },
        { status: 503 },
      );
    }
    // Never echo the raw error — it may contain request details from third-party services.
    console.error("Foundation verification failed:", error);
    return Response.json({ error: "foundation_check_failed" }, { status: 500 });
  }
}
