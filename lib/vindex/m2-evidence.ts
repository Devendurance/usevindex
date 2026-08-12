// M2 evidence: sanitized, public-onchain-only proof artifact for the Aave USDC
// position milestone. The file on disk is safe to commit or display; it must
// never contain API keys or Authorization material (assertM2EvidenceSafe).
// Bigint values serialize as decimal strings.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export const M2_EVIDENCE_FILE = "artifacts/m2-aave-position.json" as const;

export type M2SimulationRecord = {
  intentId: string; // e.g. "m2-funding", "m2-approve", "m2-supply"
  chainId: number;
  from: string | null;
  to: string | null;
  function: string;
  functionArgs: string; // JSON string
  success: boolean;
  status: string | null;
  wouldRevert: boolean;
  gasEstimate: string | null;
  simulatedReturnValue: unknown; // scalar or null; never serialize raw bodies
  observedAt: string;
};

export type M2WriteRecord = {
  executionId: string;
  transactionHash: string;
  transactionLink: string | null;
  sponsored: boolean;
  receiptVerified: boolean;
  blockNumber: number | null;
};

export type M2Evidence = {
  milestone: "M2";
  chainId: number;
  network: string; // "Base Sepolia"
  keeperHubWallet: string;
  asset: string; // Aave-market USDC underlying
  aToken: string;
  pool: string;
  faucet: string;
  supplyAmountBaseUnits: string; // decimal string
  supplyAmountFormatted: string; // e.g. "5"
  preState: {
    usdcBalance: string;
    aUsdcBalance: string;
    allowance: string;
    blockNumber: string;
  };
  funding:
    | (M2WriteRecord & {
        required: boolean;
        simulation: M2SimulationRecord | null;
        mintAmountBaseUnits: string | null;
      })
    | null;
  approval:
    | (M2WriteRecord & {
        required: boolean;
        simulation: M2SimulationRecord | null;
        allowanceAfter: string;
      })
    | null;
  supply: (M2WriteRecord & { simulation: M2SimulationRecord | null }) | null;
  postState: {
    usdcBalance: string;
    aUsdcBalance: string;
    allowance: string;
    blockNumber: string;
  };
  positionVerified: boolean;
  verifiedAt: string;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

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

/** Coerces a scalar simulation return value; bigints become decimal strings. */
const asScalarOrNull = (value: unknown): unknown => {
  if (value === undefined) return null;
  return typeof value === "bigint" ? value.toString() : value;
};

const buildSimulation = (raw: unknown): M2SimulationRecord | null => {
  if (!isRecord(raw)) return null;
  return {
    intentId: asString(raw.intentId, ""),
    chainId: Number(asString(raw.chainId, "0")),
    from: asStringOrNull(raw.from),
    to: asStringOrNull(raw.to),
    function: asString(raw.function, ""),
    functionArgs: asString(raw.functionArgs, ""),
    success: asBoolean(raw.success, false),
    status: asStringOrNull(raw.status),
    wouldRevert: asBoolean(raw.wouldRevert, false),
    gasEstimate: asStringOrNull(raw.gasEstimate),
    simulatedReturnValue: asScalarOrNull(raw.simulatedReturnValue),
    observedAt: asString(raw.observedAt, ""),
  };
};

const buildWriteRecord = (raw: unknown): M2WriteRecord | null => {
  if (!isRecord(raw)) return null;
  return {
    executionId: asString(raw.executionId, ""),
    transactionHash: asString(raw.transactionHash, ""),
    transactionLink: asStringOrNull(raw.transactionLink),
    sponsored: asBoolean(raw.sponsored, false),
    receiptVerified: asBoolean(raw.receiptVerified, false),
    blockNumber: asNumberOrNull(raw.blockNumber),
  };
};

const buildState = (raw: unknown): M2Evidence["preState"] => {
  if (!isRecord(raw)) {
    return { usdcBalance: "", aUsdcBalance: "", allowance: "", blockNumber: "" };
  }
  return {
    usdcBalance: asString(raw.usdcBalance, ""),
    aUsdcBalance: asString(raw.aUsdcBalance, ""),
    allowance: asString(raw.allowance, ""),
    blockNumber: asString(raw.blockNumber, ""),
  };
};

const buildFunding = (raw: unknown): M2Evidence["funding"] => {
  if (!isRecord(raw)) return null;
  const write = buildWriteRecord(raw);
  if (write === null) return null;
  return {
    ...write,
    required: asBoolean(raw.required, false),
    simulation: buildSimulation(raw.simulation),
    mintAmountBaseUnits: asStringOrNull(raw.mintAmountBaseUnits),
  };
};

const buildApproval = (raw: unknown): M2Evidence["approval"] => {
  if (!isRecord(raw)) return null;
  const write = buildWriteRecord(raw);
  if (write === null) return null;
  return {
    ...write,
    required: asBoolean(raw.required, false),
    simulation: buildSimulation(raw.simulation),
    allowanceAfter: asString(raw.allowanceAfter, ""),
  };
};

const buildSupply = (raw: unknown): M2Evidence["supply"] => {
  if (!isRecord(raw)) return null;
  const write = buildWriteRecord(raw);
  if (write === null) return null;
  return { ...write, simulation: buildSimulation(raw.simulation) };
};

/**
 * Maps a raw input object (numbers/bigints are coerced via String()) into a
 * fully typed M2Evidence record. Sections and optional fields default to null;
 * missing keys are tolerated for forward compatibility with older files.
 */
export function buildM2Evidence(input: Record<string, unknown>): M2Evidence {
  return {
    milestone: "M2",
    chainId: Number(asString(input.chainId, "0")),
    network: asString(input.network, ""),
    keeperHubWallet: asString(input.keeperHubWallet, ""),
    asset: asString(input.asset, ""),
    aToken: asString(input.aToken, ""),
    pool: asString(input.pool, ""),
    faucet: asString(input.faucet, ""),
    supplyAmountBaseUnits: asString(input.supplyAmountBaseUnits, ""),
    supplyAmountFormatted: asString(input.supplyAmountFormatted, ""),
    preState: buildState(input.preState),
    funding: buildFunding(input.funding),
    approval: buildApproval(input.approval),
    supply: buildSupply(input.supply),
    postState: buildState(input.postState),
    positionVerified: asBoolean(input.positionVerified, false),
    verifiedAt: asString(input.verifiedAt, ""),
  };
}

/** Reads evidence from disk; null when missing, unparseable, or not milestone "M2". */
export function loadM2Evidence(path: string): M2Evidence | null {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return null;
  }

  try {
    const parsed: unknown = JSON.parse(raw);
    if (!isRecord(parsed) || parsed.milestone !== "M2") {
      return null;
    }
    return parsed as unknown as M2Evidence;
  } catch {
    return null;
  }
}

/** Writes evidence to disk, creating parent directories. Refuses secret-bearing evidence. */
export function writeM2Evidence(path: string, evidence: M2Evidence): void {
  assertM2EvidenceSafe(evidence);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
}

/**
 * True when the evidence proves a verified M2 position: verification reported
 * success onchain, an aUSDC balance greater than zero was observed, and the
 * supply transaction is a real 32-byte hash.
 */
export function isVerifiedM2Evidence(evidence: M2Evidence): boolean {
  const aUsdcBalance = /^\d+$/.test(evidence.postState.aUsdcBalance)
    ? BigInt(evidence.postState.aUsdcBalance)
    : BigInt(0);
  return (
    evidence.positionVerified === true &&
    aUsdcBalance > BigInt(0) &&
    (evidence.supply === null ||
      /^0x[a-fA-F0-9]{64}$/.test(evidence.supply.transactionHash))
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
 * Defense in depth: every string value (recursively, covering nested sections)
 * must be free of API-key and Authorization material before evidence is
 * persisted. Throws otherwise.
 */
export function assertM2EvidenceSafe(evidence: M2Evidence): void {
  if (containsForbiddenSecretPattern(evidence)) {
    throw new Error("M2 evidence contains a forbidden secret pattern");
  }
}
