import "server-only";
import { isAddress } from "viem";

export const KEEPERHUB_API_BASE_URL = "https://app.keeperhub.com";

export type KeeperHubErrorCategory =
  | "network"
  | "unauthorized"
  | "rate_limited"
  | "server"
  | "unexpected"
  | null;

export type KeeperHubHealth = {
  reachable: boolean;
  authenticated: boolean;
  keyShape: "kh_org" | "other";
  statusCode: number | null;
  errorCategory: KeeperHubErrorCategory;
  checkedAt: string;
};

export const isKeeperHubHealthy = (health: KeeperHubHealth): boolean =>
  health.reachable && health.authenticated;

export type KeeperHubClientOptions = {
  apiKey: string;
  baseUrl?: string;
  fetchFn?: typeof fetch;
};

export type KeeperHubWallet = {
  hasWallet: boolean;
  walletAddress: string | null; // validated EVM address (viem isAddress), null if absent/invalid
  walletId: string | null; // operational id only
  isActive: boolean | null;
  invalidAddress: boolean; // true when a walletAddress was returned but failed viem isAddress
  error: string | null; // safe error description, never raw response bodies
};

export type ContractCallRequest = {
  contractAddress: string;
  chainId: number;
  functionName: string;
  functionArgs: string; // JSON array string, e.g. '["0x...", "1"]'
  abi?: string; // JSON string of minimal ABI
  simulate?: boolean; // strict boolean
};

export type ContractCallSimulation = {
  httpStatus: number;
  success: boolean;
  status: string | null; // "simulated" expected
  from: string | null;
  to: string | null;
  value: string | null;
  gasEstimate: string | null; // decimal string
  simulatedReturnValue: unknown;
  wouldRevert: boolean; // false when the call would succeed; true when it would revert
  revertReason: string | null;
  error: string | null;
  idempotentReplay: boolean | null;
};

export type ContractCallSubmission = {
  httpStatus: number;
  executionId: string | null;
  status: string | null; // initial execution status ("completed"/"failed"/...)
  transactionHash: string | null;
  transactionLink: string | null;
  error: string | null;
  code: string | null; // e.g. "idempotency_conflict", "WALLET_NOT_CONFIGURED", "insufficient_scope"
  retryable: boolean | null;
  originalExecutionId: string | null;
  idempotentReplay: boolean | null;
};

export type ExecutionReceipt = {
  hash: string | null;
  chainId: number | null;
  verified: boolean | null;
  receiptStatus: string | null;
  blockNumber: number | null;
  gasUsed: string | null;
  verifiedAt: string | null;
};

export type DirectExecutionStatus = {
  httpStatus: number;
  executionId: string | null;
  status: string | null; // pending | running | completed | failed
  transactionHash: string | null;
  transactionLink: string | null;
  sponsored: boolean | null;
  gasUsedWei: string | null;
  receipts: ExecutionReceipt[];
  error: string | null;
  pollIntervalHintSec: number; // seconds from X-Poll-Interval-Hint, default 2 when header absent
  isTerminal: boolean; // status === "completed" || status === "failed"
};

export type KeeperHubClient = {
  healthCheck(): Promise<KeeperHubHealth>;
  getOrganizationWallet(): Promise<KeeperHubWallet>;
  simulateContractCall(
    request: Omit<ContractCallRequest, "simulate">,
  ): Promise<ContractCallSimulation>;
  executeContractCall(
    request: Omit<ContractCallRequest, "simulate">,
    idempotencyKey: string,
  ): Promise<ContractCallSubmission>;
  getExecutionStatus(executionId: string): Promise<DirectExecutionStatus>;
};

export function createKeeperHubClient(options: KeeperHubClientOptions): KeeperHubClient {
  const baseUrl = options.baseUrl ?? KEEPERHUB_API_BASE_URL;
  const fetchFn = options.fetchFn ?? fetch;
  const apiKey = options.apiKey;
  const keyShape: KeeperHubHealth["keyShape"] = apiKey.startsWith("kh_") ? "kh_org" : "other";

  // Private core request helper; M1 will build executeContractCall / getExecutionStatus on top of it.
  // Bounded requests: a stalled upstream must never hang the caller forever.
  const REQUEST_TIMEOUT_MS = 25_000;
  const request = (path: string, init: RequestInit): Promise<Response> =>
    fetchFn(`${baseUrl}${path}`, {
      ...init,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });

  // JSON variant of request: parses the body defensively, never throwing on
  // malformed/empty responses (json is null in that case).
  const requestJson = async (
    path: string,
    init: RequestInit,
  ): Promise<{ status: number; json: unknown; headers: Headers }> => {
    const response = await request(path, init);
    let json: unknown = null;
    try {
      json = await response.json();
    } catch {
      json = null;
    }
    return { status: response.status, json, headers: response.headers };
  };

  const isRecord = (value: unknown): value is Record<string, unknown> =>
    typeof value === "object" && value !== null && !Array.isArray(value);

  const asString = (value: unknown): string | null => (typeof value === "string" ? value : null);

  const asBool = (value: unknown): boolean | null => (typeof value === "boolean" ? value : null);

  const healthCheck = async (): Promise<KeeperHubHealth> => {
    const checkedAt = new Date().toISOString();

    try {
      // Public endpoint; no auth header. Only status is observed, never the body.
      await request("/api/chains", { method: "GET" });
    } catch {
      return {
        reachable: false,
        authenticated: false,
        keyShape,
        statusCode: null,
        errorCategory: "network",
        checkedAt,
      };
    }

    try {
      const response = await request("/api/keys", {
        method: "GET",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          Accept: "application/json",
        },
      });

      const statusCode = response.status;
      let authenticated = false;
      let errorCategory: KeeperHubErrorCategory = "unexpected";

      if (statusCode === 200) {
        authenticated = true;
        errorCategory = null;
      } else if (statusCode === 401 || statusCode === 403) {
        errorCategory = "unauthorized";
      } else if (statusCode === 429) {
        errorCategory = "rate_limited";
      } else if (statusCode >= 500) {
        errorCategory = "server";
      }

      return { reachable: true, authenticated, keyShape, statusCode, errorCategory, checkedAt };
    } catch {
      // The reachability probe succeeded but the auth probe failed at the network layer.
      return {
        reachable: true,
        authenticated: false,
        keyShape,
        statusCode: null,
        errorCategory: "network",
        checkedAt,
      };
    }
  };

  const getOrganizationWallet = async (): Promise<KeeperHubWallet> => {
    const unavailable = (): KeeperHubWallet => ({
      hasWallet: false,
      walletAddress: null,
      walletId: null,
      isActive: null,
      invalidAddress: false,
      error: "Failed to fetch organization wallet",
    });

    try {
      const { status, json } = await requestJson("/api/user/wallet", {
        method: "GET",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          Accept: "application/json",
        },
      });

      if (status !== 200 || !isRecord(json)) return unavailable();

      if (json.hasWallet !== true) {
        return {
          hasWallet: false,
          walletAddress: null,
          walletId: null,
          isActive: null,
          invalidAddress: false,
          error: null,
        };
      }

      const walletAddress = asString(json.walletAddress);
      const walletId = asString(json.walletId);
      const isActive = asBool(json.isActive);

      if (walletAddress === null || !isAddress(walletAddress)) {
        return {
          hasWallet: true,
          walletAddress: null,
          walletId,
          isActive,
          invalidAddress: true,
          error: "KeeperHub returned an invalid wallet address",
        };
      }

      return {
        hasWallet: true,
        walletAddress,
        walletId,
        isActive,
        invalidAddress: false,
        error: null,
      };
    } catch {
      return unavailable();
    }
  };

  const simulateContractCall = async (
    contractCall: Omit<ContractCallRequest, "simulate">,
  ): Promise<ContractCallSimulation> => {
    let httpStatus: number;
    let json: unknown;

    try {
      const response = await requestJson("/api/execute/contract-call", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify({ ...contractCall, simulate: true }),
      });
      httpStatus = response.status;
      json = response.json;
    } catch {
      return {
        httpStatus: 0,
        success: false,
        status: null,
        from: null,
        to: null,
        value: null,
        gasEstimate: null,
        simulatedReturnValue: null,
        wouldRevert: false,
        revertReason: null,
        error: "Failed to reach KeeperHub",
        idempotentReplay: null,
      };
    }

    const body = isRecord(json) ? json : {};
    // wouldRevert is present only on simulate responses and is the revert marker.
    const wouldRevert = body.wouldRevert === true;

    if (httpStatus === 200) {
      return {
        httpStatus,
        success: true,
        status: asString(body.status),
        from: asString(body.from),
        to: asString(body.to),
        value: asString(body.value),
        gasEstimate: asString(body.gasEstimate),
        simulatedReturnValue: "simulatedReturnValue" in body ? body.simulatedReturnValue : null,
        wouldRevert,
        revertReason: null,
        error: null,
        idempotentReplay: asBool(body.idempotentReplay),
      };
    }

    if (httpStatus === 400 && wouldRevert) {
      return {
        httpStatus,
        success: false,
        status: asString(body.status),
        from: asString(body.from),
        to: asString(body.to),
        value: asString(body.value),
        gasEstimate: null,
        simulatedReturnValue: null,
        wouldRevert: true,
        revertReason: asString(body.revertReason),
        error: asString(body.error) ?? `HTTP ${httpStatus}`,
        idempotentReplay: asBool(body.idempotentReplay),
      };
    }

    return {
      httpStatus,
      success: false,
      status: asString(body.status),
      from: null,
      to: null,
      value: null,
      gasEstimate: null,
      simulatedReturnValue: null,
      wouldRevert,
      revertReason: null,
      error: asString(body.error) ?? `HTTP ${httpStatus}`,
      idempotentReplay: asBool(body.idempotentReplay),
    };
  };

  const executeContractCall = async (
    contractCall: Omit<ContractCallRequest, "simulate">,
    idempotencyKey: string,
  ): Promise<ContractCallSubmission> => {
    let httpStatus: number;
    let json: unknown;

    try {
      const response = await requestJson("/api/execute/contract-call", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
          Accept: "application/json",
          "Idempotency-Key": idempotencyKey,
        },
        body: JSON.stringify(contractCall),
      });
      httpStatus = response.status;
      json = response.json;
    } catch {
      return {
        httpStatus: 0,
        executionId: null,
        status: null,
        transactionHash: null,
        transactionLink: null,
        error: "Failed to reach KeeperHub",
        code: null,
        retryable: null,
        originalExecutionId: null,
        idempotentReplay: null,
      };
    }

    const body = isRecord(json) ? json : {};

    if (httpStatus === 202) {
      return {
        httpStatus,
        executionId: asString(body.executionId),
        status: asString(body.status),
        transactionHash: null,
        transactionLink: null,
        error: null,
        code: null,
        retryable: null,
        originalExecutionId: null,
        idempotentReplay: null,
      };
    }

    if (httpStatus === 409) {
      return {
        httpStatus,
        executionId: null,
        status: null,
        transactionHash: null,
        transactionLink: null,
        error: asString(body.error) ?? `HTTP ${httpStatus}`,
        code: asString(body.code),
        retryable: asBool(body.retryable),
        originalExecutionId: asString(body.originalExecutionId),
        idempotentReplay: asBool(body.idempotentReplay),
      };
    }

    return {
      httpStatus,
      executionId: null,
      status: null,
      transactionHash: null,
      transactionLink: null,
      error: asString(body.error) ?? `HTTP ${httpStatus}`,
      code: asString(body.code),
      retryable: null,
      originalExecutionId: null,
      idempotentReplay: null,
    };
  };

  const getExecutionStatus = async (executionId: string): Promise<DirectExecutionStatus> => {
    let httpStatus: number;
    let json: unknown;
    let headers: Headers | null = null;

    try {
      const response = await requestJson(
        `/api/execute/${encodeURIComponent(executionId)}/status`,
        {
          method: "GET",
          headers: {
            Authorization: `Bearer ${apiKey}`,
            Accept: "application/json",
          },
        },
      );
      httpStatus = response.status;
      json = response.json;
      headers = response.headers;
    } catch {
      return {
        httpStatus: 0,
        executionId: null,
        status: null,
        transactionHash: null,
        transactionLink: null,
        sponsored: null,
        gasUsedWei: null,
        receipts: [],
        error: "Failed to reach KeeperHub",
        pollIntervalHintSec: 2,
        isTerminal: false,
      };
    }

    let pollIntervalHintSec = 2;
    const pollHint = headers?.get("X-Poll-Interval-Hint");
    if (pollHint !== null && pollHint !== undefined) {
      const parsed = Number.parseInt(pollHint, 10);
      if (!Number.isNaN(parsed)) {
        pollIntervalHintSec = Math.min(60, Math.max(0, parsed));
      }
    }

    const body = isRecord(json) ? json : {};
    const status = asString(body.status);
    const receipts: ExecutionReceipt[] = Array.isArray(body.receipts)
      ? body.receipts.map((receipt) => {
          if (!isRecord(receipt)) {
            return {
              hash: null,
              chainId: null,
              verified: null,
              receiptStatus: null,
              blockNumber: null,
              gasUsed: null,
              verifiedAt: null,
            };
          }
          return {
            hash: asString(receipt.hash),
            chainId: typeof receipt.chainId === "number" ? receipt.chainId : null,
            verified: asBool(receipt.verified),
            receiptStatus: asString(receipt.receiptStatus),
            blockNumber: typeof receipt.blockNumber === "number" ? receipt.blockNumber : null,
            gasUsed: asString(receipt.gasUsed),
            verifiedAt: asString(receipt.verifiedAt),
          };
        })
      : [];

    return {
      httpStatus,
      executionId: asString(body.executionId),
      status,
      transactionHash: asString(body.transactionHash),
      transactionLink: asString(body.transactionLink),
      sponsored: asBool(body.sponsored),
      gasUsedWei: asString(body.gasUsedWei),
      receipts,
      error: asString(body.error),
      pollIntervalHintSec,
      isTerminal: status === "completed" || status === "failed",
    };
  };

  return {
    healthCheck,
    getOrganizationWallet,
    simulateContractCall,
    executeContractCall,
    getExecutionStatus,
  };
}
