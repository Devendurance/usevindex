// Safe-wallet validation: valid addresses accepted, forbidden addresses
// rejected, and persistence round-trip in the isolated test database.

import { describe, expect, it, afterAll } from "vitest";
import { getAddress } from "viem";

import { AAVE_V3_BASE_SEPOLIA, AAVE_V3_BASE_SEPOLIA_FAUCET } from "../../lib/vindex/aave-registry";
import { vindexConfig } from "../../db/schema";
import {
  ZERO_ADDRESS,
  getSafeWalletConfig,
  parseConfigUpdate,
  setSafeWalletConfig,
  validateSafeWallet,
} from "../../lib/vindex/safe-wallet";
import { closeTestDb, getTestDb } from "./helpers/test-db";

const EXECUTION_WALLET = "0x675638ddbbf8b70b906d68e3485da72c6c63d130";
const WALLET_OTHER = "0x9999999999999999999999999999999999999999";

// A valid, separate, operator-owned style address used as the safe wallet in
// tests (not the real configured one — tests run in the isolated vindex_test db).
const SAFE_WALLET = "0x1111111111111111111111111111111111111111";

describe("validateSafeWallet", () => {
  it("accepts a valid separate EVM address and checksums it", () => {
    const result = validateSafeWallet(SAFE_WALLET, EXECUTION_WALLET);
    expect(result.valid).toBe(true);
    if (result.valid) {
      expect(result.normalized).toBe(getAddress(SAFE_WALLET));
    }
  });

  it("rejects a malformed address", () => {
    const result = validateSafeWallet("0x123", EXECUTION_WALLET);
    expect(result.valid).toBe(false);
  });

  it("rejects the zero address", () => {
    const result = validateSafeWallet(ZERO_ADDRESS, EXECUTION_WALLET);
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.reason).toContain("zero address");
  });

  it("rejects the KeeperHub execution wallet", () => {
    const result = validateSafeWallet(EXECUTION_WALLET, EXECUTION_WALLET);
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.reason).toContain("execution wallet");
  });

  it("rejects the Aave Pool as the safe wallet", () => {
    const result = validateSafeWallet(AAVE_V3_BASE_SEPOLIA.pool, EXECUTION_WALLET);
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.reason).toContain("system contract");
  });

  it("rejects the protected USDC as the safe wallet", () => {
    const result = validateSafeWallet(AAVE_V3_BASE_SEPOLIA.usdcUnderlying, EXECUTION_WALLET);
    expect(result.valid).toBe(false);
  });

  it("rejects aUSDC as the safe wallet", () => {
    const result = validateSafeWallet(AAVE_V3_BASE_SEPOLIA.usdcAToken, EXECUTION_WALLET);
    expect(result.valid).toBe(false);
  });

  it("rejects the addresses provider, oracle, data provider and faucet", () => {
    for (const address of [
      AAVE_V3_BASE_SEPOLIA.poolAddressesProvider,
      AAVE_V3_BASE_SEPOLIA.aaveOracle,
      AAVE_V3_BASE_SEPOLIA.aaveProtocolDataProvider,
      AAVE_V3_BASE_SEPOLIA.usdcOracle,
      AAVE_V3_BASE_SEPOLIA_FAUCET,
    ]) {
      const result = validateSafeWallet(address, EXECUTION_WALLET);
      expect(result.valid).toBe(false);
    }
  });

  it("rejects an EIP-55 mismatched checksum", () => {
    const checksummed = getAddress(EXECUTION_WALLET);
    const letter = checksummed.match(/[a-fA-F]/)?.[0] ?? "a";
    const broken = checksummed.replace(
      letter,
      letter === letter.toUpperCase() ? letter.toLowerCase() : letter.toUpperCase(),
    );
    const result = validateSafeWallet(broken, WALLET_OTHER);
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.reason).toContain("checksum");
  });
});

describe("parseConfigUpdate (client cannot override server-owned fields)", () => {
  it("accepts only the safeWallet field", () => {
    const parsed = parseConfigUpdate({ safeWallet: SAFE_WALLET });
    expect("safeWallet" in parsed).toBe(true);
    if ("safeWallet" in parsed) expect(parsed.safeWallet).toBe(SAFE_WALLET);
  });

  it("rejects attempts to override chainId", () => {
    const parsed = parseConfigUpdate({ safeWallet: SAFE_WALLET, chainId: 1 });
    expect("error" in parsed).toBe(true);
  });

  it("rejects attempts to override the execution wallet", () => {
    const parsed = parseConfigUpdate({ safeWallet: SAFE_WALLET, executionWallet: "0x2222222222222222222222222222222222222222" });
    expect("error" in parsed).toBe(true);
  });

  it("rejects attempts to override protocol contracts", () => {
    const parsed = parseConfigUpdate({
      safeWallet: SAFE_WALLET,
      poolAddress: "0x3333333333333333333333333333333333333333",
      assetAddress: "0x4444444444444444444444444444444444444444",
    });
    expect("error" in parsed).toBe(true);
  });

  it("rejects a missing or non-string safeWallet", () => {
    expect("error" in parseConfigUpdate({})).toBe(true);
    expect("error" in parseConfigUpdate({ safeWallet: 42 })).toBe(true);
  });
});

describe("config persistence (isolated test database)", () => {
  const dbAvailable = Boolean(process.env.DATABASE_URL?.trim());

  afterAll(async () => {
    await closeTestDb();
  });

  it.skipIf(!dbAvailable)("persists the safe wallet and survives a re-read", async () => {
    const db = await getTestDb();
    const saved = await setSafeWalletConfig(db, SAFE_WALLET);
    expect(saved.configured).toBe(true);
    expect(saved.safeWallet).toBe(getAddress(SAFE_WALLET));
    expect(saved.configuredAt).not.toBeNull();

    const reread = await getSafeWalletConfig(db);
    expect(reread.safeWallet).toBe(getAddress(SAFE_WALLET));
    expect(reread.configured).toBe(true);
    expect(reread.updatedAt).not.toBeNull();
  });

  it.skipIf(!dbAvailable)("reports not configured before any save", async () => {
    const db = await getTestDb();
    await db.delete(vindexConfig);
    const config = await getSafeWalletConfig(db);
    expect(config.configured).toBe(false);
    expect(config.safeWallet).toBeNull();
  });
});
