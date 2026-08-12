import { getDb } from "@/db";
import { getServerEnv, VindexEnvError } from "@/lib/vindex/env";
import { toApiErrorResponse } from "@/lib/vindex/errors";
import { prepareEvacuation } from "@/lib/vindex/evacuation-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Accepts ONLY a decision identifier. Chain/pool/asset/amount/destination are
// derived server-side from the canonical registry and the armed policy.
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
  if (keys.some((key) => key !== "decisionId")) {
    return Response.json(
      { error: "UNKNOWN_FIELD", message: "Only the decisionId field is accepted." },
      { status: 400 },
    );
  }
  const decisionId = (body as Record<string, unknown>).decisionId;
  if (typeof decisionId !== "string" || decisionId.trim() === "") {
    return Response.json({ error: "BAD_REQUEST", message: "decisionId is required." }, { status: 400 });
  }

  try {
    const view = await prepareEvacuation({ env, db: getDb(), decisionId: decisionId.trim() });
    return Response.json(view);
  } catch (error) {
    return toApiErrorResponse(error);
  }
}
