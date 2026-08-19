import { getDb } from "@/db";
import { getServerEnv, VindexEnvError } from "@/lib/vindex/env";
import { toApiErrorResponse } from "@/lib/vindex/errors";
import { executeEvacuation } from "@/lib/vindex/execution-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Accepts ONLY a prepared execution ID. Every transaction parameter is derived
// server-side from the persisted canonical intent.
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
  if (keys.some((key) => key !== "executionId")) {
    return Response.json(
      { error: "UNKNOWN_FIELD", message: "Only the executionId field is accepted." },
      { status: 400 },
    );
  }
  const executionId = (body as Record<string, unknown>).executionId;
  if (typeof executionId !== "string" || executionId.trim() === "") {
    return Response.json({ error: "BAD_REQUEST", message: "executionId is required." }, { status: 400 });
  }

  try {
    const result = await executeEvacuation({ env, db: getDb(), executionId: executionId.trim() });
    return Response.json(result);
  } catch (error) {
    return toApiErrorResponse(error);
  }
}
