import { getDb } from "@/db";
import { getServerEnv, VindexEnvError } from "@/lib/vindex/env";
import { toApiErrorResponse } from "@/lib/vindex/errors";
import { getRescueReceipt } from "@/lib/vindex/verification-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Read-only.
export async function GET(_request: Request, ctx: { params: Promise<{ id: string }> }) {
  let env;
  try {
    env = getServerEnv();
  } catch (error) {
    if (error instanceof VindexEnvError) {
      return Response.json({ error: "SERVER_NOT_CONFIGURED", message: error.message }, { status: 503 });
    }
    return Response.json({ error: "SERVER_NOT_CONFIGURED", message: "Server not configured." }, { status: 503 });
  }
  void env;

  try {
    const { id } = await ctx.params;
    const receipt = await getRescueReceipt(getDb(), id);
    if (receipt === null) {
      return Response.json({ error: "POSITION_NOT_FOUND", message: "Receipt not found." }, { status: 404 });
    }
    return Response.json(receipt);
  } catch (error) {
    return toApiErrorResponse(error);
  }
}
