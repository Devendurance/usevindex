// M1 evidence: sanitized, public-onchain-only proof artifact for the KeeperHub
// execution milestone. The file on disk is safe to commit or display; it must
// never contain API keys or Authorization material (assertM1EvidenceSafe).

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export const M1_EVIDENCE_FILE = "artifacts/m1-keeperhub-execution.json" as const;

export type M1Evidence = {
  milestone: "M1";
  chainId: number;
  network: string; // "Base Sepolia"
  keeperHubWallet: string;
  executionId: string;
  transactionHash: string;
  transactionLink: string | null;
  blockNumber: number | null;
  contractAddress: string; // canonical Aave USDC underlying
  functionName: string; // "approve"
  spender: string; // canonical Aave Pool
  amountBaseUnits: string; // "1"
  allowanceBefore: string; // decimal string
  allowanceAfter: string;
  gasUsedWei: string | null;
  keeperHubStatus: string; // "completed"
  onchainReceiptStatus: string; // "success"
  executedAt: string; // ISO
  verifiedAt: string; // ISO
  approvalLog: { owner: string; spender: string; value: string } | null;
  simulation: {
    success: boolean;
    gasEstimate: string | null;
    from: string | null;
    to: string | null;
  } | null;
  sponsored: boolean; // true when KeeperHub executed via its sponsored (EIP-7702) path
  executorAddress: string | null; // top-level onchain transaction target when sponsored; null otherwise
};

const asString = (value: unknown, fallback: string): string =>
  value === undefined || value === null ? fallback : String(value);

const asStringOrNull = (value: unknown): string | null =>
  value === undefined || value === null ? null : String(value);

const asNumberOrNull = (value: unknown): number | null => {
  if (value === undefined || value === null) return null;
  const number = Number(value);
  return Number.isNaN(number) ? null : number;
};

const asBoolean = (value: unknown, fallback: boolean): boolean =>
  value === undefined || value === null ? fallback : Boolean(value);

/**
 * Maps a raw input object (numbers/bigints are coerced via String()) into a
 * fully typed M1Evidence record. Optional fields default to null.
 */
export function buildM1Evidence(input: Record<string, unknown>): M1Evidence {
  const rawApprovalLog = input.approvalLog;
  const approvalLog: M1Evidence["approvalLog"] =
    typeof rawApprovalLog === "object" &&
    rawApprovalLog !== null &&
    !Array.isArray(rawApprovalLog)
      ? {
          owner: asString((rawApprovalLog as Record<string, unknown>).owner, ""),
          spender: asString((rawApprovalLog as Record<string, unknown>).spender, ""),
          value: asString((rawApprovalLog as Record<string, unknown>).value, ""),
        }
      : null;

  const rawSimulation = input.simulation;
  const simulation: M1Evidence["simulation"] =
    typeof rawSimulation === "object" &&
    rawSimulation !== null &&
    !Array.isArray(rawSimulation)
      ? {
          success: asBoolean((rawSimulation as Record<string, unknown>).success, false),
          gasEstimate: asStringOrNull((rawSimulation as Record<string, unknown>).gasEstimate),
          from: asStringOrNull((rawSimulation as Record<string, unknown>).from),
          to: asStringOrNull((rawSimulation as Record<string, unknown>).to),
        }
      : null;

  return {
    milestone: "M1",
    chainId: Number(asString(input.chainId, "0")),
    network: asString(input.network, ""),
    keeperHubWallet: asString(input.keeperHubWallet, ""),
    executionId: asString(input.executionId, ""),
    transactionHash: asString(input.transactionHash, ""),
    transactionLink: asStringOrNull(input.transactionLink),
    blockNumber: asNumberOrNull(input.blockNumber),
    contractAddress: asString(input.contractAddress, ""),
    functionName: asString(input.functionName, ""),
    spender: asString(input.spender, ""),
    amountBaseUnits: asString(input.amountBaseUnits, ""),
    allowanceBefore: asString(input.allowanceBefore, ""),
    allowanceAfter: asString(input.allowanceAfter, ""),
    gasUsedWei: asStringOrNull(input.gasUsedWei),
    keeperHubStatus: asString(input.keeperHubStatus, ""),
    onchainReceiptStatus: asString(input.onchainReceiptStatus, ""),
    executedAt: asString(input.executedAt, ""),
    verifiedAt: asString(input.verifiedAt, ""),
    approvalLog,
    simulation,
    sponsored: asBoolean(input.sponsored, false),
    executorAddress: asStringOrNull(input.executorAddress),
  };
}

/** Reads evidence from disk; null when missing, unparseable, or not milestone "M1". */
export function loadM1Evidence(path: string): M1Evidence | null {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return null;
  }

  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return null;
    }
    const record = parsed as Record<string, unknown>;
    if (record.milestone !== "M1") {
      return null;
    }
    return record as unknown as M1Evidence;
  } catch {
    return null;
  }
}

/** Writes evidence to disk, creating parent directories. Refuses secret-bearing evidence. */
export function writeM1Evidence(path: string, evidence: M1Evidence): void {
  assertM1EvidenceSafe(evidence);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
}

/**
 * True when the evidence proves a completed M1: KeeperHub reported completed,
 * the receipt was success onchain, the transaction hash is a real 32-byte hash,
 * and the post-execution allowance is exactly 1 base unit.
 */
export function isVerifiedM1Evidence(evidence: M1Evidence): boolean {
  return (
    evidence.keeperHubStatus === "completed" &&
    evidence.onchainReceiptStatus === "success" &&
    /^0x[a-fA-F0-9]{64}$/.test(evidence.transactionHash) &&
    evidence.allowanceAfter === "1"
  );
}

const FORBIDDEN_SECRET_PATTERNS = [/kh_[A-Za-z0-9_-]{6,}/, /Authorization/i, /Bearer\s+/i];

function containsForbiddenSecretPattern(value: unknown): boolean {
  if (typeof value === "string") {
    return FORBIDDEN_SECRET_PATTERNS.some((pattern) => pattern.test(value));
  }
  if (typeof value === "object" && value !== null) {
    return Object.values(value).some((nested) => containsForbiddenSecretPattern(nested));
  }
  return false;
}

/**
 * Defense in depth: every string field (recursively) must be free of API-key
 * and Authorization material before evidence is persisted. Throws otherwise.
 */
export function assertM1EvidenceSafe(evidence: M1Evidence): void {
  if (containsForbiddenSecretPattern(evidence)) {
    throw new Error("M1 evidence contains a forbidden secret pattern");
  }
}
