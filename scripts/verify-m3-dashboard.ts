import "dotenv/config";

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { sql } from "drizzle-orm";

import { getDb, DbConfigError } from "../db";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { getAaveUsdcPosition } from "../lib/vindex/aave-position";
import { AAVE_V3_BASE_SEPOLIA } from "../lib/vindex/aave-registry";
import { getServerEnv, VindexEnvError } from "../lib/vindex/env";
import { runFoundationVerification } from "../lib/vindex/foundation";
import { createKeeperHubClient } from "../lib/vindex/keeperhub";
import { refreshCurrentProtectedPosition } from "../lib/vindex/position-service";
import { createCanonicalPublicClient } from "../lib/vindex/public-client";
import { getSafeWalletConfig } from "../lib/vindex/safe-wallet";

const M3_EVIDENCE_FILE = "artifacts/m3-live-dashboard.json";

const printRow = (label: string, value: string): void => {
  console.log(`${label.padEnd(32, ".")} ${value}`);
};

const printPass = (label: string): void => printRow(label, "PASS");
const printFail = (label: string, value: string): void => printRow(label, `FAIL ${value}`);

async function main(): Promise<void> {
  let env;
  try {
    env = getServerEnv();
  } catch (error) {
    if (error instanceof VindexEnvError) {
      console.log("VINDEX M3 DASHBOARD — ENVIRONMENT NOT CONFIGURED");
      console.log();
      console.log(error.message);
      process.exit(1);
      return;
    }
    throw error;
  }

  // 1. Database connectivity (M3_DATABASE_REQUIRED on absence).
  let db;
  try {
    db = getDb();
  } catch (error) {
    if (error instanceof DbConfigError) {
      console.log("VINDEX M3 DASHBOARD — M3_DATABASE_REQUIRED");
      console.log();
      console.log(error.message);
      process.exit(1);
      return;
    }
    throw error;
  }

  console.log("VINDEX M3 LIVE DASHBOARD VERIFICATION");
  console.log();

  let dbOk = false;
  try {
    await db.execute(sql`SELECT 1`);
    dbOk = true;
  } catch {
    dbOk = false;
  }
  if (dbOk) {
    printPass("Database connectivity");
  } else {
    printFail("Database connectivity", "cannot connect");
    console.log("Run: npm run db:migrate (DATABASE_URL must point at a reachable PostgreSQL)");
    process.exit(1);
    return;
  }

  try {
    await migrate(db, { migrationsFolder: "./drizzle" });
    printPass("Migrations");
  } catch {
    printFail("Migrations", "failed to apply");
    process.exit(1);
    return;
  }

  // 2. M0 foundation.
  const foundation = await runFoundationVerification(env);
  printPass("M0 foundation") ;
  if (!foundation.passed) {
    printFail("M0 foundation", "not all checks passed");
    process.exit(1);
    return;
  }

  // 3. KeeperHub wallet.
  const keeperHubClient = createKeeperHubClient({
    apiKey: env.keeperhubApiKey,
    baseUrl: env.keeperhubApiBaseUrl,
  });
  const wallet = await keeperHubClient.getOrganizationWallet();
  if (!wallet.hasWallet || wallet.invalidAddress || wallet.walletAddress === null) {
    printFail("KeeperHub wallet", "not configured or invalid");
    process.exit(1);
    return;
  }
  printPass("KeeperHub wallet");
  printRow("Execution wallet", wallet.walletAddress);

  // 4. Live Aave position (direct chain reads).
  const rpc = createCanonicalPublicClient(env.baseSepoliaRpcUrl);
  let live;
  try {
    live = await getAaveUsdcPosition(rpc, wallet.walletAddress);
  } catch (error) {
    printFail("Live position read", error instanceof Error ? error.message : "failed");
    process.exit(1);
    return;
  }
  printRow("Live aUSDC (direct)", `${live.aTokenBalanceBaseUnits.toString()} base units`);
  if (live.aTokenBalanceBaseUnits <= BigInt(0)) {
    printFail("Non-zero position", "aUSDC balance is zero — no current protected position");
    process.exit(1);
    return;
  }
  printPass("Non-zero position");

  // 5. Refresh + persist through the service.
  let model;
  try {
    model = await refreshCurrentProtectedPosition({ env, db });
  } catch (error) {
    printFail("Position refresh", error instanceof Error ? error.message : "failed");
    process.exit(1);
    return;
  }
  printPass("Position refresh + persist");

  // 6. Safe-wallet configuration.
  const config = await getSafeWalletConfig(db);
  printRow("Safe wallet configured", config.configured ? "yes" : "no");
  if (config.safeWallet !== null) {
    printRow("Safe wallet", config.safeWallet);
    const safePosition = await getAaveUsdcPosition(rpc, config.safeWallet);
    printRow(
      "Safe wallet USDC",
      `${safePosition.underlyingBalanceBaseUnits.toString()} base units (${safePosition.underlyingBalanceFormatted})`,
    );
  } else {
    printRow("Safe wallet USDC", "n/a (not configured)");
  }

  // 7. API model vs chain-derived source. The USDC balance is exact (it does
  // not accrue); the aUSDC position accrues via Aave's liquidity index between
  // observation blocks, so a small documented-accounting tolerance applies
  // when the blocks differ.
  const direct = await getAaveUsdcPosition(rpc, wallet.walletAddress);
  const ACCRUAL_TOLERANCE = BigInt(10);
  const usdcExact =
    model.position.executionWalletUsdcBalance.baseUnits ===
    direct.underlyingBalanceBaseUnits.toString();
  const positionDelta =
    BigInt(model.position.suppliedBalance.baseUnits) - direct.aTokenBalanceBaseUnits;
  const positionWithinTolerance =
    positionDelta >= -ACCRUAL_TOLERANCE && positionDelta <= ACCRUAL_TOLERANCE;
  const identityMatches =
    model.position.asset.address.toLowerCase() === AAVE_V3_BASE_SEPOLIA.usdcUnderlying.toLowerCase() &&
    model.position.positionToken.address.toLowerCase() === AAVE_V3_BASE_SEPOLIA.usdcAToken.toLowerCase() &&
    model.position.executionWallet.toLowerCase() === wallet.walletAddress.toLowerCase();
  if (usdcExact && positionWithinTolerance && identityMatches) {
    printPass("API model matches chain");
    printRow(
      "aUSDC model vs direct delta",
      `${positionDelta.toString()} base units (block ${model.position.blockNumber} vs ${direct.latestBlockNumber.toString()})`,
    );
  } else {
    printFail(
      "API model matches chain",
      `usdcExact=${usdcExact} positionWithinTolerance=${positionWithinTolerance} identityMatches=${identityMatches}`,
    );
    process.exit(1);
    return;
  }

  // 8. Serialized amounts — only the amount fields must be lossless decimal
  // strings (no exponent notation, no float coercion).
  const amountFields = [
    model.position.suppliedBalance.baseUnits,
    model.position.executionWalletUsdcBalance.baseUnits,
    model.position.executionWalletNativeBalance.wei,
    model.position.blockNumber,
    ...(model.position.safeWalletUsdcBalance !== null
      ? [model.position.safeWalletUsdcBalance.baseUnits]
      : []),
  ];
  const hasExponent = amountFields.some((value) => /[eE]/.test(value));
  if (hasExponent) {
    printFail("Serialized amounts", "exponent notation found — lossy number serialization");
    process.exit(1);
    return;
  }
  if (!amountFields.every((value) => /^\d+$/.test(value))) {
    printFail("Serialized amounts", "non-decimal amount serialization");
    process.exit(1);
    return;
  }
  const serialized = JSON.stringify(model);
  if (serialized.includes("kh_") || /Authorization/i.test(serialized) || /Bearer\s+/i.test(serialized)) {
    printFail("Secret scan", "forbidden pattern found in the model");
    process.exit(1);
    return;
  }
  printPass("Serialized amounts (lossless strings)");
  printPass("Secret scan");

  // 9. Readiness.
  const readiness = model.readiness;
  printRow("Network valid", readiness.networkValid ? "yes" : "no");
  printRow("Contracts valid", readiness.contractsValid ? "yes" : "no");
  printRow("Execution wallet valid", readiness.executionWalletValid ? "yes" : "no");
  printRow("Position exists", readiness.positionExists ? "yes" : "no");
  printRow("Safe wallet configured", readiness.safeWalletConfigured ? "yes" : "no");
  printRow("Safe wallet valid", readiness.safeWalletValid ? "yes" : "no");
  printRow("KeeperHub healthy", readiness.keeperHubHealthy ? "yes" : "no");
  printRow("Ready for monitoring", readiness.readyForMonitoring ? "yes" : "no");

  // 10. Evidence artifact.
  const evidence = {
    milestone: "M3",
    chainId: model.position.chainId,
    network: model.position.networkName,
    protocol: model.position.protocol,
    executionWallet: model.position.executionWallet,
    safeWallet: model.position.safeWallet,
    asset: model.position.asset.address,
    aToken: model.position.positionToken.address,
    livePositionBaseUnits: model.position.suppliedBalance.baseUnits,
    livePositionFormatted: model.position.suppliedBalance.formatted,
    executionWalletUsdcBaseUnits: model.position.executionWalletUsdcBalance.baseUnits,
    executionWalletNativeWei: model.position.executionWalletNativeBalance.wei,
    safeWalletUsdcBaseUnits: model.position.safeWalletUsdcBalance?.baseUnits ?? null,
    blockNumber: model.position.blockNumber,
    blockTimestamp: model.position.blockTimestamp,
    observedAt: model.position.observedAt,
    positionExists: readiness.positionExists,
    safeWalletConfigured: readiness.safeWalletConfigured,
    readyForMonitoring: readiness.readyForMonitoring,
  };
  mkdirSync(dirname(M3_EVIDENCE_FILE), { recursive: true });
  writeFileSync(M3_EVIDENCE_FILE, `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
  printPass("Evidence written");
  printRow("Evidence", M3_EVIDENCE_FILE);
  console.log();
  printRow("Result", readiness.readyForMonitoring ? "PASS" : "READY_FOR_MONITORING_FALSE");
  process.exit(readiness.readyForMonitoring ? 0 : 1);
}

void main();
