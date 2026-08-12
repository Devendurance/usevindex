import { describe, expect, it } from "vitest";
import { CANONICAL_MOCKS_DISABLED, canonicalMockFallback } from "../../lib/vindex/mock-guard";

function captureError(fn: () => unknown): unknown {
  try {
    fn();
  } catch (error) {
    return error;
  }
  throw new Error("Expected the function to throw");
}

describe("canonical mock guard", () => {
  it("disables canonical runtime mocks", () => {
    expect(CANONICAL_MOCKS_DISABLED).toBe(true);
  });

  it("throws a fail-closed error naming the mocked method", () => {
    const error = captureError(() => canonicalMockFallback("balanceOf"));
    expect(error).toBeInstanceOf(Error);
    const message = (error as Error).message;
    expect(message).toContain("disabled");
    expect(message).toContain("balanceOf");
  });
});
