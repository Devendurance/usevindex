// Typed error behavior: codes, status mapping, and sanitized responses with
// no stack traces or secrets.

import { describe, expect, it } from "vitest";

import { VindexApiError, asVindexApiError, toApiErrorResponse } from "../../lib/vindex/errors";

describe("VindexApiError", () => {
  it("carries typed codes and statuses", () => {
    const error = new VindexApiError("DATABASE_UNAVAILABLE", "db down", 503);
    expect(error.code).toBe("DATABASE_UNAVAILABLE");
    expect(error.status).toBe(503);
  });

  it("classifies unknown errors as LIVE_READ_FAILED", () => {
    const error = asVindexApiError(new Error("boom"));
    expect(error.code).toBe("LIVE_READ_FAILED");
    expect(error.status).toBe(502);
  });
});

describe("toApiErrorResponse", () => {
  it("never leaks stack traces or secrets", async () => {
    const response = toApiErrorResponse(
      new Error("secret kh_ABC123 at /secret/path: stack line 1"),
    );
    const body = (await response.json()) as { error: string; message: string };
    expect(response.status).toBe(502);
    expect(body.error).toBe("LIVE_READ_FAILED");
    expect(body.message).not.toContain("kh_ABC123");
    expect(body.message).not.toContain("/secret/path");
    expect(JSON.stringify(body)).not.toContain("at ");
  });

  it("preserves typed messages for known errors", async () => {
    const response = toApiErrorResponse(
      new VindexApiError("POSITION_NOT_FOUND", "No position snapshot is available yet.", 404),
    );
    const body = (await response.json()) as { error: string; message: string };
    expect(response.status).toBe(404);
    expect(body.error).toBe("POSITION_NOT_FOUND");
  });
});
