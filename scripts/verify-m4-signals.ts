import "dotenv/config";

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { eq } from "drizzle-orm";
import { sql } from "drizzle-orm";

import { getDb, DbConfigError } from "../db";
import { signalObservations } from "../db/schema";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { getServerEnv, VindexEnvError } from "../lib/vindex/env";
import { runFoundationVerification } from "../lib/vindex/foundation";
import {
  collectLiveSignalObservations,
  getLatestSignalObservations,
  getSignalHistory,
  SIGNAL_FAMILIES,
} from "../lib/vindex/signal-service";

const M4_EVIDENCE_FILE = "artifacts/m4-live-signals.json";

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
      console.log("VINDEX M4 SIGNALS — ENVIRONMENT NOT CONFIGURED");
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
      console.log("VINDEX M4 SIGNALS — DATABASE REQUIRED");
      console.log();
      console.log(error.message);
      process.exit(1);
      return;
    }
    throw error;
  }

  console.log("VINDEX M4 LIVE SIGNAL INGESTION");
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

  // Collect a real batch.
  const batch = await collectLiveSignalObservations({ env, db });
  if (batch.outcome === "FAILED") {
    printFail("Collection", batch.diagnostics.join("; "));
    process.exit(1);
    return;
  }
  printRow("Collection outcome", batch.outcome);
  printRow("Block", batch.blockNumber);
  printRow("Block timestamp", batch.blockTimestamp ?? "—");
  printRow("Families", batch.familiesCollected.join(", "));
  printRow("Persisted", String(batch.persistedCount));
  printRow("Duplicates", String(batch.duplicateCount));

  const familyCoverage = SIGNAL_FAMILIES.every((family) => batch.familiesCollected.includes(family));
  if (batch.outcome !== "COMPLETE" || !familyCoverage) {
    printFail(
      "Family coverage",
      `expected all of ${SIGNAL_FAMILIES.join(", ")}, got ${batch.familiesCollected.join(", ") || "none"}`,
    );
    process.exit(1);
    return;
  }
  printPass("Family coverage (oracle + reserve + position)");

  // Provenance: every observation must carry block + timestamp.
  const missingProvenance = batch.observations.filter(
    (observation) => observation.blockNumber === "" || observation.blockTimestamp === null,
  );
  if (missingProvenance.length > 0) {
    printFail("Block provenance", `${missingProvenance.length} observation(s) lack block/timestamp`);
    process.exit(1);
    return;
  }
  printPass("Block provenance");

  // No invented previous values on the first sample of a metric.
  const firstSamples = batch.observations.filter(
    (observation) => observation.metadata.previousValue === undefined,
  );
  printRow("First samples without previous", String(firstSamples.length));

  // Dedup proof: inserting the exact same (positionId, metric, contract, block)
  // again must not create a duplicate row.
  const sample = batch.observations[0];
  const beforeCount = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(signalObservations)
    .where(
      eq(signalObservations.positionId, sample.positionId),
    );
  const duplicateProbe = {
    positionId: sample.positionId,
    chainId: sample.chainId,
    protocol: sample.protocol,
    sourceFamily: sample.sourceFamily,
    metric: sample.metric,
    rawValue: sample.rawValue,
    normalizedValue: sample.normalizedValue,
    severity: sample.severity,
    contractAddress: sample.contractAddress,
    blockNumber: sample.blockNumber,
    blockTimestamp: sample.blockTimestamp !== null ? new Date(sample.blockTimestamp) : null,
    observedAt: new Date(sample.observedAt),
    rpcSource: sample.rpcSource,
    metadataJson: JSON.stringify(sample.metadata),
  };
  await db.insert(signalObservations).values(duplicateProbe).onConflictDoNothing();
  const afterCount = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(signalObservations)
    .where(eq(signalObservations.positionId, sample.positionId));
  if (afterCount[0].count !== beforeCount[0].count) {
    printFail("Dedup", "duplicate insert created a new row");
    process.exit(1);
    return;
  }
  printPass("Dedup (same metric+block does not duplicate)");

  // Query layer.
  const latest = await getLatestSignalObservations(db, batch.positionId);
  if (latest.latest.length === 0) {
    printFail("Latest query", "no observations returned");
    process.exit(1);
    return;
  }
  printPass("Latest query");
  printRow("Freshness", latest.freshness);
  printRow("Latest metrics", latest.latest.map((observation) => observation.metric).join(", "));

  const history = await getSignalHistory(db, batch.positionId, { limit: 20 });
  if (history.length < batch.observations.length) {
    printFail("History query", `expected >= ${batch.observations.length}, got ${history.length}`);
    process.exit(1);
    return;
  }
  printPass("History query");
  printRow("History count", String(history.length));

  // Secret scan on the evidence payload.
  const evidence = {
    milestone: "M4",
    chainId: batch.chainId,
    network: "Base Sepolia",
    protocol: "Aave V3",
    positionId: batch.positionId,
    batch: {
      outcome: batch.outcome,
      blockNumber: batch.blockNumber,
      blockTimestamp: batch.blockTimestamp,
      observedAt: batch.observedAt,
      rpcSource: batch.rpcSource,
      familiesCollected: batch.familiesCollected,
      persistedCount: batch.persistedCount,
      duplicateCount: batch.duplicateCount,
      diagnostics: batch.diagnostics,
    },
    observations: batch.observations.map((observation) => ({
      id: observation.id ?? null,
      sourceFamily: observation.sourceFamily,
      metric: observation.metric,
      rawValue: observation.rawValue,
      normalizedValue: observation.normalizedValue,
      contractAddress: observation.contractAddress,
      blockNumber: observation.blockNumber,
      blockTimestamp: observation.blockTimestamp,
      observedAt: observation.observedAt,
      metadata: observation.metadata,
    })),
    persistenceProof: {
      dedupVerified: true,
      historyCount: history.length,
      latestFreshness: latest.freshness,
    },
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

  mkdirSync(dirname(M4_EVIDENCE_FILE), { recursive: true });
  writeFileSync(M4_EVIDENCE_FILE, `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
  printPass("Evidence written");
  printRow("Evidence", M4_EVIDENCE_FILE);
  console.log();
  printRow("Result", "PASS");
  process.exit(0);
}

void main();
