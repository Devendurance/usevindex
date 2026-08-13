// Typed, sanitized API errors for the M3 server surface. Raw DB/RPC stack
// traces and secrets must never reach the browser.

export type VindexErrorCode =
  | "DATABASE_UNAVAILABLE"
  | "POSITION_NOT_FOUND"
  | "POSITION_ZERO"
  | "SAFE_WALLET_NOT_CONFIGURED"
  | "INVALID_SAFE_WALLET"
  | "WRONG_CHAIN"
  | "RPC_UNAVAILABLE"
  | "RPC_PRIMARY_UNAVAILABLE"
  | "RPC_ALL_UNAVAILABLE"
  | "KEEPERHUB_UNAVAILABLE"
  | "KEEPERHUB_UNAUTHENTICATED"
  | "SIMULATION_REVERTED"
  | "SIMULATION_FAILED"
  | "SUBMISSION_UNKNOWN"
  | "EXECUTION_PENDING"
  | "EXECUTION_FAILED"
  | "IDEMPOTENCY_CONFLICT"
  | "STALE_EVIDENCE"
  | "VERIFICATION_FAILED"
  | "DESTINATION_MISMATCH"
  | "INTERVENTION_REQUIRED"
  | "LIVE_READ_FAILED"
  | "SERVER_NOT_CONFIGURED"
  | "UNKNOWN_FIELD"
  | "BAD_REQUEST"
  | "NO_ACTIVE_RUN"
  | "IN_FLIGHT_JOB"
  | "POLICY_ARMED_RECONFIGURE_REQUIRED";

export class VindexApiError extends Error {
  readonly code: VindexErrorCode;
  readonly status: number;

  constructor(code: VindexErrorCode, message: string, status = 400) {
    super(message);
    this.name = "VindexApiError";
    this.code = code;
    this.status = status;
  }
}

const DEFAULT_STATUS: Record<VindexErrorCode, number> = {
  DATABASE_UNAVAILABLE: 503,
  POSITION_NOT_FOUND: 404,
  POSITION_ZERO: 422,
  SAFE_WALLET_NOT_CONFIGURED: 422,
  INVALID_SAFE_WALLET: 400,
  WRONG_CHAIN: 502,
  RPC_UNAVAILABLE: 502,
  RPC_PRIMARY_UNAVAILABLE: 502,
  RPC_ALL_UNAVAILABLE: 503,
  KEEPERHUB_UNAVAILABLE: 502,
  KEEPERHUB_UNAUTHENTICATED: 502,
  SIMULATION_REVERTED: 422,
  SIMULATION_FAILED: 422,
  SUBMISSION_UNKNOWN: 502,
  EXECUTION_PENDING: 202,
  EXECUTION_FAILED: 502,
  IDEMPOTENCY_CONFLICT: 409,
  STALE_EVIDENCE: 422,
  VERIFICATION_FAILED: 422,
  DESTINATION_MISMATCH: 422,
  INTERVENTION_REQUIRED: 409,
  LIVE_READ_FAILED: 502,
  SERVER_NOT_CONFIGURED: 503,
  UNKNOWN_FIELD: 400,
  BAD_REQUEST: 400,
  NO_ACTIVE_RUN: 409,
  IN_FLIGHT_JOB: 409,
  POLICY_ARMED_RECONFIGURE_REQUIRED: 409,
};

export const asVindexApiError = (error: unknown): VindexApiError => {
  if (error instanceof VindexApiError) return error;
  return new VindexApiError(
    "LIVE_READ_FAILED",
    "Live data could not be read right now.",
    DEFAULT_STATUS.LIVE_READ_FAILED,
  );
};

export const toApiErrorResponse = (error: unknown): Response =>
  Response.json(
    {
      error: asVindexApiError(error).code,
      message: asVindexApiError(error).message,
    },
    { status: asVindexApiError(error).status },
  );
