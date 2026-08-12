import "dotenv/config";

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { eq, sql } from "drizzle-orm";

import { getDb, DbConfigError } from "../db";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { executions, simulations } from "../db/schema";
import { getServerEnv, VindexEnvError } from "../lib/vindex/env";
import { runFoundationVerification } from "../lib/vindex/foundation";
import { createKeeperHubClient } from "../lib/vindex/keeperhub";
import { canonicalPositionId } from "../lib/vindex/position-service";
import {
  armPolicy,
  disarmPolicy,
  evaluateProtectionPolicy,
  getAuditEvents,
} from "../lib/vindex/policy-service";
import { collectLiveSignalObservations } from "../lib/vindex/signal-service";
import { prepareEvacuation } from "../lib/vindex/evacuation-service";
import { getSafeWalletConfig } from "../lib/vindex/safe-wallet";

const M6_EVIDENCE_FILE = "artifacts/m6-simulation.json";

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
      console.log("VINDEX M6 SIMULATION — ENVIRONMENT NOT CONFIGURED");
      console.log();
      console.log(error.message);
      process.exit(1);
      return;
    }
    throw error;
  }

  let db;
  try {
    db = getDb();
  } catch (error) {
    if (error instanceof DbConfigError) {
      console.log("VINDEX M6 SIMULATION — DATABASE REQUIRED");
      console.log();
      console.log(error.message);
      process.exit(1);
      return;
    }
    throw error;
  }

  console.log("VINDEX M6 PRE-EXECUTION VALIDATOR + SIMULATION");
  console.log();

  try {
    await db.execute(sql`SELECT 1`);
    printPass("Database connectivity");
  } catch {
    printFail("Database connectivity", "cannot connect");
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

  const foundation = await runFoundationVerification(env);
  if (!foundation.passed) {
    printFail("M0 foundation", "not all checks passed");
    process.exit(1);
    return;
  }
  printPass("M0 foundation");

  const client = createKeeperHubClient({ apiKey: env.keeperhubApiKey, baseUrl: env.keeperhubApiBaseUrl });
  const wallet = await client.getOrganizationWallet();
  if (!wallet.hasWallet || wallet.walletAddress === null) {
    printFail("KeeperHub wallet", "not configured");
    process.exit(1);
    return;
  }
  const positionId = canonicalPositionId(wallet.walletAddress);
  printRow("Position", positionId);

  // Fresh M4 observations.
  const batch = await collectLiveSignalObservations({ env, db });
  if (batch.outcome !== "COMPLETE") {
    printFail("M4 observations", batch.diagnostics.join("; "));
    process.exit(1);
    return;
  }
  printPass("M4 fresh observations");

  // STANDARD must still be WATCHING on a healthy market.
  await disarmPolicy(db, positionId);
  await armPolicy({ env, db, positionId, mode: "STANDARD" });
  const standardView = await evaluateProtectionPolicy({ env, db, positionId });
  if (standardView.state !== "WATCHING") {
    printFail("STANDARD evaluation", `expected WATCHING, got ${standardView.state}`);
    process.exit(1);
    return;
  }
  printPass("STANDARD healthy -> WATCHING");

  // Fresh DRILL confirmed decision (real data).
  await disarmPolicy(db, positionId);
  const drillPolicy = await armPolicy({ env, db, positionId, mode: "DRILL_HIGH_SENSITIVITY" });
  await collectLiveSignalObservations({ env, db });
  const drillView = await evaluateProtectionPolicy({ env, db, positionId });
  if (drillView.state !== "CONFIRMING" || !drillView.readyForSimulation || drillView.decisionId === null) {
    printFail("DRILL confirmed decision", drillView.state);
    process.exit(1);
    return;
  }
  printPass("Current armed confirmed DRILL decision");
  printRow("Decision", drillView.decisionId);
  printRow("Re-read block", drillView.reRead?.blockNumber ?? "—");

  // Prepare the evacuation: canonical FULL_POSITION withdrawal + simulate:true.
  const prepared = await prepareEvacuation({ env, db, decisionId: drillView.decisionId });
  printRow("Preparation state", prepared.state);
  printRow("Execution", prepared.executionId);
  printRow("Simulation", prepared.simulationId ?? "—");
  printRow("Target", prepared.target);
  printRow("Asset", prepared.asset);
  printRow("Amount mode", prepared.amountMode);
  printRow("Safe wallet", prepared.safeWallet);
  printRow("Gas estimate", prepared.gasEstimate ?? "—");
  printRow("Expected withdrawal", prepared.expectedWithdrawAmount ?? "—");
  printRow("Block", prepared.blockNumber ?? "—");

  if (!prepared.readyForExecution) {
    printFail("readyForExecution", prepared.errorCode ?? "unknown");
    process.exit(1);
    return;
  }
  printPass("Simulation passed (KeeperHub simulate:true)");
  printPass("readyForExecution = true");

  // No transaction hash / keeperhub execution id may exist.
  const execRows = await db.select().from(executions).where(eq(executions.id, prepared.executionId));
  const execRow = execRows[0];
  if (execRow === undefined || execRow.txHash !== null || execRow.keeperhubExecutionId !== null || execRow.submittedAt !== null) {
    printFail("No broadcast metadata", "execution carries txHash/keeperhubExecutionId/submittedAt");
    process.exit(1);
    return;
  }
  printPass("No transaction hash / no KeeperHub execution id");

  // Persisted simulation row.
  const simRows = await db.select().from(simulations).where(eq(simulations.id, prepared.simulationId ?? ""));
  if (prepared.simulationId === null || simRows[0] === undefined) {
    printFail("Simulation persisted", "missing simulation row");
    process.exit(1);
    return;
  }
  const simulation = simRows[0];
  if (!simulation.success || simulation.wouldRevert) {
    printFail("Simulation row", "not a successful non-revert simulation");
    process.exit(1);
    return;
  }
  printPass("Simulation persisted (success, wouldRevert false)");

  // Expected amount vs current live position: consistent within accrual.
  const { getAaveUsdcPosition } = await import("../lib/vindex/aave-position");
  const { createCanonicalPublicClient } = await import("../lib/vindex/public-client");
  const live = await getAaveUsdcPosition(createCanonicalPublicClient(env.baseSepoliaRpcUrl), wallet.walletAddress);
  const expected = BigInt(prepared.expectedWithdrawAmount ?? "0");
  const liveAmount = live.aTokenBalanceBaseUnits;
  const diff = expected > liveAmount ? expected - liveAmount : liveAmount - expected;
  if (diff > BigInt(100)) {
    printFail("Expected withdrawal vs live position", `delta ${diff.toString()} base units`);
    process.exit(1);
    return;
  }
  printPass("Expected withdrawal consistent with live position");
  printRow("Live aUSDC (direct)", liveAmount.toString());

  // Idempotency: rerun returns the same prepared execution, no duplicate rows.
  const countBefore = (await db.select().from(executions).where(eq(executions.decisionId, drillView.decisionId))).length;
  const rerun = await prepareEvacuation({ env, db, decisionId: drillView.decisionId });
  const countAfter = (await db.select().from(executions).where(eq(executions.decisionId, drillView.decisionId))).length;
  if (rerun.executionId !== prepared.executionId || countAfter !== countBefore) {
    printFail("Idempotent preparation", "rerun created a different/duplicate preparation");
    process.exit(1);
    return;
  }
  printPass("Idempotent rerun (no duplicate preparation)");

  // Safe wallet pinned.
  const config = await getSafeWalletConfig(db);
  if (config.safeWallet !== drillPolicy.safeWalletSnapshot || config.safeWallet !== prepared.safeWallet) {
    printFail("Destination pinning", "safe wallet mismatch");
    process.exit(1);
    return;
  }
  printPass("Destination pinned to armed snapshot");

  // Audit chain.
  const events = await getAuditEvents(db, positionId, 50);
  const eventTypes = events.map((event) => event.eventType);
  for (const required of ["SIMULATION_STARTED", "SIMULATION_PASSED", "EXECUTION_PREPARED"]) {
    if (!eventTypes.includes(required)) {
      printFail("Audit chain", `missing ${required}`);
      process.exit(1);
      return;
    }
  }
  printPass("Audit chain (SIMULATION_STARTED/PASSED/EXECUTION_PREPARED)");

  const evidence = {
    milestone: "M6",
    chainId: 84532,
    network: "Base Sepolia",
    protocol: "Aave V3",
    positionId,
    decision: {
      id: drillView.decisionId,
      policyId: drillPolicy.id,
      policyMode: drillPolicy.mode,
      policyVersion: drillPolicy.version,
      confirmedAt: drillView.confirmedAt,
      expiresAt: drillView.expiresAt,
      readyForSimulation: drillView.readyForSimulation,
      reReadBlock: drillView.reRead?.blockNumber ?? null,
      matchedFamilies: drillView.matchedFamilies.filter((m) => m.matched).map((m) => m.family),
    },
    execution: {
      id: prepared.executionId,
      state: prepared.state,
      readyForExecution: prepared.readyForExecution,
      target: prepared.target,
      asset: prepared.asset,
      amountMode: prepared.amountMode,
      amountBaseUnits: prepared.amountBaseUnits,
      safeWallet: prepared.safeWallet,
      parametersHash: prepared.parametersHash,
      blockNumber: prepared.blockNumber,
      blockTimestamp: prepared.blockTimestamp,
    },
    simulation: {
      id: prepared.simulationId,
      success: simulation.success,
      wouldRevert: simulation.wouldRevert,
      gasEstimate: prepared.gasEstimate,
      expectedWithdrawAmount: prepared.expectedWithdrawAmount,
      preSimulationPositionAmount: liveAmount.toString(),
      blockNumber: prepared.blockNumber,
      createdAt: simulation.createdAt.toISOString(),
    },
    withdrawalParameters: {
      function: "withdraw",
      asset: "0xba50Cd2A20f6DA35D788639E581bca8d0B5d4D5f",
      amount: "type(uint256).max (full position)",
      to: prepared.safeWallet,
    },
    noBroadcastProof: {
      txHash: null,
      keeperhubExecutionId: null,
      submittedAt: null,
    },
    auditEvents: eventTypes.slice(0, 10),
    secretScanPassed: true,
    verifiedAt: new Date().toISOString(),
  };

  const serialized = JSON.stringify(evidence);
  if (serialized.includes("kh_") || /Authorization/i.test(serialized) || /Bearer\s+/i.test(serialized)) {
    printFail("Secret scan", "forbidden pattern found");
    process.exit(1);
    return;
  }
  printPass("Secret scan");

  mkdirSync(dirname(M6_EVIDENCE_FILE), { recursive: true });
  writeFileSync(M6_EVIDENCE_FILE, `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
  printPass("Evidence written");
  printRow("Evidence", M6_EVIDENCE_FILE);
  console.log();
  printRow("Result", "PASS");
  process.exit(0);
}

void main();
