import { getDb } from "@/db";
import { prepareDemoRoute } from "@/lib/vindex/demo-controller";
import { getServerEnv, VindexEnvError } from "@/lib/vindex/env";
import { toApiErrorResponse } from "@/lib/vindex/errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Starts (or resumes/adopts) the live demo position preparation in the
// background. No body is accepted — the demo surface is explicit and never
// exposes arbitrary transaction parameters.
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
  if (keys.length > 0) {
    return Response.json(
      { error: "UNKNOWN_FIELD", message: "No request fields are accepted." },
      { status: 400 },
    );
  }

  try {
    const result = await prepareDemoRoute(env, getDb());
    return Response.json(result);
  } catch (error) {
    return toApiErrorResponse(error);
  }
}
