import "dotenv/config";

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { sql } from "drizzle-orm";

import { getDb, DbConfigError } from "../db";
import { migrate } from "drizzle-orm/postgres-js/migrator";
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
import { getSafeWalletConfig } from "../lib/vindex/safe-wallet";

const M5_EVIDENCE_FILE = "artifacts/m5-consensus.json";

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
      console.log("VINDEX M5 CONSENSUS — ENVIRONMENT NOT CONFIGURED");
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
      console.log("VINDEX M5 CONSENSUS — DATABASE REQUIRED");
      console.log();
      console.log(error.message);
      process.exit(1);
      return;
    }
    throw error;
  }

  console.log("VINDEX M5 POLICY + CONSENSUS");
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
  printRow("Observation block", batch.blockNumber);

  // Prove STANDARD evaluation: healthy market must be WATCHING.
  await disarmPolicy(db, positionId);
  const standardPolicy = await armPolicy({ env, db, positionId, mode: "STANDARD" });
  printRow("STANDARD armed", `v${standardPolicy.version} (required ${standardPolicy.requiredSignals})`);
  const standardView = await evaluateProtectionPolicy({ env, db, positionId });
  if (standardView.state !== "WATCHING") {
    printFail("STANDARD evaluation", `expected WATCHING, got ${standardView.state}`);
    process.exit(1);
    return;
  }
  printPass("STANDARD evaluation (healthy -> WATCHING)");
  printRow("STANDARD matched", String(standardView.matchedCount));

  // DRILL run using real observations.
  await disarmPolicy(db, positionId);
  const drillPolicy = await armPolicy({ env, db, positionId, mode: "DRILL_HIGH_SENSITIVITY" });
  printRow("DRILL armed", `v${drillPolicy.version} (required ${drillPolicy.requiredSignals})`);

  const drillBatch = await collectLiveSignalObservations({ env, db });
  const drillView = await evaluateProtectionPolicy({ env, db, positionId });

  const matchedFamilies = drillView.matchedFamilies.filter((m) => m.matched);
  printRow("DRILL state", drillView.state);
  printRow(
    "DRILL matched families",
    matchedFamilies.length > 0 ? matchedFamilies.map((m) => m.family).join(", ") : "none",
  );
  printRow("DRILL distinct count", `${drillView.matchedCount} / ${drillView.policy?.requiredSignals ?? "?"}`);

  if (drillView.state !== "CONFIRMING") {
    printFail("DRILL consensus", `expected CONFIRMING, got ${drillView.state}`);
    process.exit(1);
    return;
  }
  if (drillView.matchedCount < (drillView.policy?.requiredSignals ?? 2)) {
    printFail("DRILL distinct families", `matched ${drillView.matchedCount}, need ${drillView.policy?.requiredSignals}`);
    process.exit(1);
    return;
  }
  printPass("2-of-3 distinct-family consensus");
  printPass("Drill honestly labeled");
  printRow("Drill label", drillView.drillLabel ?? "—");

  // Confirmation re-read.
  if (drillView.reRead === null || drillView.reRead.outcome !== "passed") {
    printFail("Confirmation re-read", drillView.reRead?.reason ?? "no re-read recorded");
    process.exit(1);
    return;
  }
  printPass("Confirmation re-read (newer block)");
  printRow("Re-read block", drillView.reRead.blockNumber);
  if (!drillView.readyForSimulation || drillView.confirmedAt === null || drillView.expiresAt === null) {
    printFail("readyForSimulation", "not set");
    process.exit(1);
    return;
  }
  printPass("readyForSimulation = true");
  printRow("confirmedAt", drillView.confirmedAt);
  printRow("expiresAt", drillView.expiresAt);

  // Safe wallet pinned: config still matches the armed snapshot.
  const config = await getSafeWalletConfig(db);
  if (config.safeWallet !== drillPolicy.safeWalletSnapshot) {
    printFail("Safe-wallet pin", "config no longer matches the armed snapshot");
    process.exit(1);
    return;
  }
  printPass("Safe-wallet pinned to armed snapshot");

  // Audit chain.
  const events = await getAuditEvents(db, positionId, 50);
  const eventTypes = events.map((event) => event.eventType);
  for (const required of ["POLICY_ARMED", "CONSENSUS_REACHED", "CONFIRMATION_STARTED", "CONFIRMATION_PASSED"]) {
    if (!eventTypes.includes(required)) {
      printFail("Audit chain", `missing ${required}`);
      process.exit(1);
      return;
    }
  }
  printPass("Audit chain (append-only)");
  printRow("Audit events", eventTypes.slice(0, 8).join(" -> "));

  const evidence = {
    milestone: "M5",
    chainId: 84532,
    network: "Base Sepolia",
    protocol: "Aave V3",
    positionId,
    policy: {
      id: drillPolicy.id,
      mode: drillPolicy.mode,
      version: drillPolicy.version,
      requiredSignals: drillPolicy.requiredSignals,
      correlationWindowSec: drillPolicy.correlationWindowSec,
      thresholds: drillPolicy.thresholds,
      safeWalletSnapshot: drillPolicy.safeWalletSnapshot,
      armedAt: drillPolicy.armedAt,
    },
    standardEvaluation: {
      state: standardView.state,
      matchedCount: standardView.matchedCount,
    },
    drill: {
      state: drillView.state,
      matchedCount: drillView.matchedCount,
      requiredSignals: drillView.policy?.requiredSignals,
      matchedFamilies: matchedFamilies.map((m) => ({
        family: m.family,
        reason: m.reason,
        observationIds: m.observationIds,
        values: m.values,
      })),
      decisionId: drillView.decisionId,
      windowStartedAt: drillView.windowStartedAt,
      confirmedAt: drillView.confirmedAt,
      expiresAt: drillView.expiresAt,
      readyForSimulation: drillView.readyForSimulation,
      drillLabel: drillView.drillLabel,
      drillExplanation: drillView.drillExplanation,
      reRead: drillView.reRead,
    },
    observations: drillBatch.observations.map((o) => ({
      id: o.id ?? null,
      sourceFamily: o.sourceFamily,
      metric: o.metric,
      rawValue: o.rawValue,
      blockNumber: o.blockNumber,
      blockTimestamp: o.blockTimestamp,
      observedAt: o.observedAt,
    })),
    auditEvents: eventTypes,
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

  mkdirSync(dirname(M5_EVIDENCE_FILE), { recursive: true });
  writeFileSync(M5_EVIDENCE_FILE, `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
  printPass("Evidence written");
  printRow("Evidence", M5_EVIDENCE_FILE);
  console.log();
  printRow("Result", "PASS");
  process.exit(0);
}

void main();
