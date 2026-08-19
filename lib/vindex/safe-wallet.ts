// Server-authoritative safe-wallet configuration service. The safe wallet is a
// separate operator-controlled EVM address that is the future evacuation
// destination. It does NOT own the Aave position.
import "server-only";

import { eq } from "drizzle-orm";
import { getAddress, isAddress } from "viem";

import type { VindexDb } from "../../db";
import { CONFIG_SINGLETON_ID, vindexConfig } from "../../db/schema";
import {
  AAVE_V3_BASE_SEPOLIA,
  AAVE_V3_BASE_SEPOLIA_FAUCET,
} from "./aave-registry";
import { VindexApiError } from "./errors";
import { isEvmAddress } from "./validation";

export const ZERO_ADDRESS = `0x${"00".repeat(20)}` as const;

const PROTECTED_SYSTEM_ADDRESSES: readonly string[] = [
  AAVE_V3_BASE_SEPOLIA.poolAddressesProvider,
  AAVE_V3_BASE_SEPOLIA.pool,
  AAVE_V3_BASE_SEPOLIA.aaveProtocolDataProvider,
  AAVE_V3_BASE_SEPOLIA.aaveOracle,
  AAVE_V3_BASE_SEPOLIA.usdcUnderlying,
  AAVE_V3_BASE_SEPOLIA.usdcAToken,
  AAVE_V3_BASE_SEPOLIA.usdcOracle,
  AAVE_V3_BASE_SEPOLIA_FAUCET,
];

export type SafeWalletValidation =
  | { valid: true; normalized: `0x${string}` }
  | { valid: false; reason: string };

export const validateSafeWallet = (
  address: string,
  executionWallet: string,
): SafeWalletValidation => {
  const trimmed = address.trim();
  if (!isEvmAddress(trimmed)) {
    return { valid: false, reason: "Use a valid 0x EVM address with 40 hexadecimal characters." };
  }
  if (trimmed.toLowerCase() === ZERO_ADDRESS) {
    return { valid: false, reason: "The safe wallet cannot be the zero address." };
  }
  // Accepts checksummed and all-lowercase forms; rejects mixed-case addresses
  // whose EIP-55 checksum does not match.
  if (!isAddress(trimmed, { strict: true })) {
    return { valid: false, reason: "The address failed EIP-55 checksum validation." };
  }
  let normalized: `0x${string}`;
  try {
    normalized = getAddress(trimmed);
  } catch {
    return { valid: false, reason: "The address failed EIP-55 checksum validation." };
  }
  if (normalized.toLowerCase() === executionWallet.toLowerCase()) {
    return {
      valid: false,
      reason: "The safe wallet must be a separate address from the KeeperHub execution wallet.",
    };
  }
  if (
    PROTECTED_SYSTEM_ADDRESSES.some(
      (systemAddress) => systemAddress.toLowerCase() === normalized.toLowerCase(),
    )
  ) {
    return {
      valid: false,
      reason: "The safe wallet cannot be an Aave or Vindex system contract address.",
    };
  }
  return { valid: true, normalized };
};

export type SafeWalletConfig = {
  safeWallet: string | null;
  configured: boolean;
  configuredAt: string | null;
  updatedAt: string | null;
};

export const getSafeWalletConfig = async (db: VindexDb): Promise<SafeWalletConfig> => {
  try {
    const rows = await db
      .select()
      .from(vindexConfig)
      .where(eq(vindexConfig.id, CONFIG_SINGLETON_ID))
      .limit(1);
    const row = rows[0];
    if (row === undefined || row.safeWallet === null) {
      return {
        safeWallet: null,
        configured: false,
        configuredAt: null,
        updatedAt: row?.updatedAt.toISOString() ?? null,
      };
    }
    return {
      safeWallet: row.safeWallet,
      configured: true,
      configuredAt: row.configuredAt?.toISOString() ?? null,
      updatedAt: row.updatedAt.toISOString(),
    };
  } catch {
    throw new VindexApiError(
      "DATABASE_UNAVAILABLE",
      "The configuration database is unavailable.",
      503,
    );
  }
};

export const setSafeWalletConfig = async (
  db: VindexDb,
  safeWallet: string,
  now: () => Date = () => new Date(),
): Promise<SafeWalletConfig> => {
  const timestamp = now();
  try {
    await db
      .insert(vindexConfig)
      .values({
        id: CONFIG_SINGLETON_ID,
        safeWallet,
        configuredAt: timestamp,
        updatedAt: timestamp,
      })
      .onConflictDoUpdate({
        target: vindexConfig.id,
        set: {
          safeWallet,
          configuredAt: timestamp,
          updatedAt: timestamp,
        },
      });
  } catch {
    throw new VindexApiError(
      "DATABASE_UNAVAILABLE",
      "The configuration database is unavailable.",
      503,
    );
  }
  return getSafeWalletConfig(db);
};

/** Normalizes/validates the PUT body: only the safeWallet field is accepted. */
export const parseConfigUpdate = (
  body: unknown,
): { safeWallet: string } | { error: VindexApiError } => {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return { error: new VindexApiError("BAD_REQUEST", "Request body must be a JSON object.") };
  }
  const keys = Object.keys(body as Record<string, unknown>);
  const unknown = keys.filter((key) => key !== "safeWallet");
  if (unknown.length > 0) {
    return {
      error: new VindexApiError(
        "UNKNOWN_FIELD",
        `Field(s) not configurable by the client: ${unknown.join(", ")}.`,
      ),
    };
  }
  const safeWallet = (body as Record<string, unknown>).safeWallet;
  if (typeof safeWallet !== "string" || safeWallet.trim() === "") {
    return { error: new VindexApiError("INVALID_SAFE_WALLET", "safeWallet must be a non-empty string.") };
  }
  return { safeWallet: safeWallet.trim() };
};
