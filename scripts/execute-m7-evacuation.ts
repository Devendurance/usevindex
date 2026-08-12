import "dotenv/config";

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { eq, sql } from "drizzle-orm";

import { getDb, DbConfigError } from "../db";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { executions } from "../db/schema";
import { getServerEnv, VindexEnvError } from "../lib/vindex/env";
import { runFoundationVerification } from "../lib/vindex/foundation";
import { createKeeperHubClient } from "../lib/vindex/keeperhub";
import { canonicalPositionId } from "../lib/vindex/position-service";
import {
  armPolicy,
  disarmPolicy,
  evaluateProtectionPolicy,
  getAuditEvents,
  type EvaluationView,
} from "../lib/vindex/policy-service";
import { collectLiveSignalObservations } from "../lib/vindex/signal-service";
import { prepareEvacuation } from "../lib/vindex/evacuation-service";
import { executeEvacuation, m7IdempotencyKey } from "../lib/vindex/execution-service";
import { AAVE_V3_BASE_SEPOLIA, MAX_UINT256 } from "../lib/vindex/aave-registry";

const M7_EVIDENCE_FILE = "artifacts/m7-execution.json";

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
      console.log("VINDEX M7 EVACUATION — ENVIRONMENT NOT CONFIGURED");
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
      console.log("VINDEX M7 EVACUATION — DATABASE REQUIRED");
      console.log();
      console.log(error.message);
      process.exit(1);
      return;
    }
    throw error;
  }

  console.log("VINDEX M7 REAL KEEPERHUB EVACUATION");
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

  // M7_ALREADY_EXECUTED: if this position already reached
  // EXECUTED_VERIFYING_DESTINATION, exit with ZERO writes — the prerequisites
  // below (non-zero position) can no longer pass after withdrawal.
  {
    const { getLatestExecutionState } = await import("../lib/vindex/execution-service");
    const latest = await getLatestExecutionState(db, positionId);
    if (
      latest !== null &&
      (latest.outcome === "EXECUTED_VERIFYING_DESTINATION" || latest.outcome === "PROTECTED" || latest.outcome === "INTERVENTION_REQUIRED") &&
      latest.transactionHash !== null
    ) {
      console.log(`M7_ALREADY_EXECUTED — this evacuation already reached a terminal executed state (${latest.outcome}, tx ${latest.transactionHash}, KeeperHub execution ${latest.keeperhubExecutionId ?? "unknown"}). Zero writes performed.`);
      process.exit(0);
      return;
    }
  }

  // Fresh M4 observations.
  const batch = await collectLiveSignalObservations({ env, db });
  if (batch.outcome !== "COMPLETE") {
    printFail("M4 observations", batch.diagnostics.join("; "));
    process.exit(1);
    return;
  }
  printPass("M4 fresh observations");

  // Current confirmed decision (reuse if still valid, else fresh drill flow).
  let decisionView: EvaluationView = await evaluateProtectionPolicy({ env, db, positionId });
  if (decisionView.state !== "CONFIRMING" || !decisionView.readyForSimulation) {
    console.log("No current confirmed decision — running the M5 DRILL flow with real observations.");
    await disarmPolicy(db, positionId);
    await armPolicy({ env, db, positionId, mode: "DRILL_HIGH_SENSITIVITY" });
    await collectLiveSignalObservations({ env, db });
    decisionView = await evaluateProtectionPolicy({ env, db, positionId });
    if (decisionView.state !== "CONFIRMING" || !decisionView.readyForSimulation || decisionView.decisionId === null) {
      printFail("Confirmed decision", decisionView.state);
      process.exit(1);
      return;
    }
  }
  if (decisionView.decisionId === null) {
    printFail("Confirmed decision", "no decision id");
    process.exit(1);
    return;
  }
  printPass("Current confirmed decision");
  printRow("Decision", decisionView.decisionId);

  // Prepared execution (reuse or prepare fresh).
  const existing = await db
    .select()
    .from(executions)
    .where(eq(executions.decisionId, decisionView.decisionId))
    .limit(1);
  let executionRow = existing[0] ?? null;

  if (executionRow === null || executionRow.status !== "SIMULATION_PASSED") {
    if (executionRow !== null && executionRow.txHash !== null) {
      printFail("Execution", `already broadcast (${executionRow.txHash})`);
      process.exit(1);
      return;
    }
    console.log("No usable prepared execution — running the M6 preparation (simulate:true).");
    const prepared = await prepareEvacuation({ env, db, decisionId: decisionView.decisionId });
    if (!prepared.readyForExecution) {
      printFail("Preparation", prepared.errorCode ?? "not ready");
      process.exit(1);
      return;
    }
    executionRow = (await db.select().from(executions).where(eq(executions.id, prepared.executionId)))[0] ?? null;
    if (executionRow === null) {
      printFail("Preparation", "row missing");
      process.exit(1);
      return;
    }
  }
  printPass("Prepared execution (SIMULATION_PASSED)");
  printRow("Execution", executionRow.id);

  const safeWallet = executionRow.safeWallet;
  const idempotencyKey = m7IdempotencyKey(executionRow.id, executionRow.parametersHash);

  console.log();
  console.log("INTENDED ACTION");
  console.log("---------------");
  printRow("Chain", "Base Sepolia (84532)");
  printRow("Target", AAVE_V3_BASE_SEPOLIA.pool);
  printRow("Function", "withdraw(address,uint256,address)");
  printRow("Asset", AAVE_V3_BASE_SEPOLIA.usdcUnderlying);
  printRow("Amount", `${MAX_UINT256} (type(uint256).max — full position)`);
  printRow("Destination", safeWallet);
  printRow("Execution layer", "KeeperHub direct execution");
  printRow("Idempotency key", idempotencyKey);
  console.log();

  // If already executed, exit cleanly with ZERO writes.
  if (executionRow.status === "EXECUTED_VERIFYING_DESTINATION") {
    console.log(`M7_ALREADY_EXECUTED — this evacuation already reached EXECUTED_VERIFYING_DESTINATION (tx ${executionRow.txHash}). Zero writes performed.`);
    process.exit(0);
    return;
  }

  // THE broadcast.
  const result = await executeEvacuation({ env, db, executionId: executionRow.id });
  printRow("Outcome", result.outcome);
  printRow("KeeperHub execution id", result.keeperhubExecutionId ?? "—");
  printRow("KeeperHub status", result.status ?? "—");
  if (result.transactionHash !== null) {
    printRow("Transaction hash", result.transactionHash);
  }
  if (result.transactionLink !== null) {
    printRow("Transaction link", result.transactionLink);
  }
  if (result.actualWithdrawAmount !== null) {
    printRow("Actual withdrawn", `${result.actualWithdrawAmount} base units`);
  }
  printRow("Block", result.blockNumber ?? "—");

  if (result.outcome !== "EXECUTED_VERIFYING_DESTINATION") {
    printFail("Execution", result.errorCode ?? result.outcome);
    process.exit(1);
    return;
  }
  printPass("EXECUTED_VERIFYING_DESTINATION");

  // Re-read the authoritative execution row for evidence (pre-state snapshot etc.).
  const finalRow = (await db.select().from(executions).where(eq(executions.id, executionRow.id)))[0] ?? executionRow;
  const events = await getAuditEvents(db, positionId, 50);
  const eventTypes = events.map((event) => event.eventType);
  for (const required of ["KEEPERHUB_SUBMISSION_REQUESTED", "KEEPERHUB_EXECUTION_ACCEPTED", "TRANSACTION_CONFIRMED", "WITHDRAW_EVENT_VERIFIED", "DESTINATION_VERIFICATION_PENDING"]) {
    if (!eventTypes.includes(required)) {
      printFail("Audit chain", `missing ${required}`);
      process.exit(1);
      return;
    }
  }
  printPass("Audit chain");

  const evidence = {
    milestone: "M7",
    chainId: 84532,
    network: "Base Sepolia",
    protocol: "Aave V3",
    positionId,
    decision: {
      id: decisionView.decisionId,
      policyId: decisionView.policy?.id ?? null,
      policyMode: decisionView.policy?.mode ?? null,
      policyVersion: decisionView.policy?.version ?? null,
      confirmedAt: decisionView.confirmedAt,
      expiresAt: decisionView.expiresAt,
    },
    execution: {
      id: finalRow.id,
      state: result.outcome,
      target: finalRow.target,
      asset: AAVE_V3_BASE_SEPOLIA.usdcUnderlying,
      safeWallet,
      parametersHash: finalRow.parametersHash,
      idempotencyKey: finalRow.idempotencyKey ?? idempotencyKey,
      broadcastRequestHash: finalRow.broadcastRequestHash,
      prePositionAmount: finalRow.prePositionAmount,
      preSafeWalletBalance: finalRow.preSafeWalletBalance,
      preBlockNumber: finalRow.preBlockNumber,
    },
    keeperhub: {
      executionId: result.keeperhubExecutionId,
      status: result.status,
      sponsored: result.sponsored,
      transactionHash: result.transactionHash,
      transactionLink: result.transactionLink,
    },
    onchain: {
      receiptStatus: "success",
      blockNumber: result.blockNumber,
      actualWithdrawAmount: result.actualWithdrawAmount,
      postPositionAmount: result.postPositionAmount,
      withDrawEventVerified: true,
    },
    auditEvents: eventTypes.slice(0, 12),
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

  mkdirSync(dirname(M7_EVIDENCE_FILE), { recursive: true });
  writeFileSync(M7_EVIDENCE_FILE, `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
  printPass("Evidence written");
  printRow("Evidence", M7_EVIDENCE_FILE);
  console.log();
  printRow("Result", "PASS");
  process.exit(0);
}

void main();
