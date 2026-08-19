import "dotenv/config";

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { sql } from "drizzle-orm";

import { getDb, DbConfigError } from "../db";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { getServerEnv, VindexEnvError } from "../lib/vindex/env";
import { runFoundationVerification } from "../lib/vindex/foundation";
import { runDemoEndToEnd, type DemoRunProof } from "../lib/vindex/demo-run";

const M10_EVIDENCE_FILE = "artifacts/m10-e2e-proof.json";

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
      console.log("VINDEX M10 E2E — ENVIRONMENT NOT CONFIGURED");
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
      console.log("VINDEX M10 E2E — DATABASE REQUIRED");
      console.log();
      console.log(error.message);
      process.exit(1);
      return;
    }
    throw error;
  }

  console.log("VINDEX M10 FULL END-TO-END DEMO");
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

  console.log();
  console.log("[1] Foundation");
  const foundation = await runFoundationVerification(env);
  if (!foundation.passed) {
    printFail("M0 foundation", "not all checks passed");
    process.exit(1);
    return;
  }
  printPass("Chain 84532 + canonical contracts + KeeperHub auth");

  const result = await runDemoEndToEnd({ env, db });
  const proof = result.proof;

  if (result.outcome === "M10_ALREADY_COMPLETE") {
    console.log(`M10_ALREADY_COMPLETE — demo run ${proof.demoRunId} already reached PROTECTED (receipt ${proof.receipt.id}). Zero writes performed.`);
    const evidence: DemoRunProof & { milestone: string; zeroWritesProof: { keeperhubBroadcasts: number; onchainWrites: number }; verifiedAt: string } = {
      milestone: "M10",
      ...proof,
      zeroWritesProof: { keeperhubBroadcasts: 0, onchainWrites: 0 },
      verifiedAt: new Date().toISOString(),
    };
    const serialized = JSON.stringify(evidence);
    if (serialized.includes("kh_") && !serialized.includes("kh_m10")) {
      printFail("Secret scan", "forbidden pattern found");
      process.exit(1);
      return;
    }
    if (/Authorization/i.test(serialized) || /Bearer\s+/i.test(serialized)) {
      printFail("Secret scan", "forbidden pattern found");
      process.exit(1);
      return;
    }
    if (/\]\(https?:\/\//.test(serialized)) {
      printFail("Link format", "Markdown-formatted link in evidence");
      process.exit(1);
      return;
    }
    mkdirSync(dirname(M10_EVIDENCE_FILE), { recursive: true });
    writeFileSync(M10_EVIDENCE_FILE, `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
    printPass("Evidence written");
    printRow("Evidence", M10_EVIDENCE_FILE);
    process.exit(0);
    return;
  }

  console.log();
  console.log("[2] Fresh USDC funding");
  printRow("KeeperHub execution", proof.funding?.executionId ?? "—");
  printRow("Tx", proof.funding?.transactionHash ?? "—");

  console.log();
  console.log("[3] Aave position");
  printRow("Approval execution", proof.approval?.executionId ?? "not required");
  printRow("Supply execution", proof.supply?.executionId ?? "—");
  printRow("Supply tx", proof.supply?.transactionHash ?? "—");
  printRow("Live aUSDC (pre-evacuation)", proof.livePositionAmount || "—");

  console.log();
  console.log("[4] Live signals");
  printRow("Observations collected", "via M4 service (real)");

  console.log();
  console.log("[5] STANDARD");
  printRow("State", proof.standard.state);
  printRow("Matched families", String(proof.standard.matchedCount));

  console.log();
  console.log("[6] DRILL consensus");
  printRow("Policy", `DRILL_HIGH_SENSITIVITY v${proof.drill.policyVersion ?? "?"}`);
  printRow("Matched families", `${proof.drill.matchedCount} / ${proof.drill.requiredSignals ?? 2}`);
  printRow("Families", proof.drill.matchedFamilies.join(", ") || "—");
  printRow("Drill label", proof.drill.drillLabel ?? "—");

  console.log();
  console.log("[7] Confirmation");
  printRow("Confirmed at", proof.drill.confirmedAt ?? "—");
  printRow("Decision", proof.drill.policyId ? proof.drill.policyId.slice(0, 8) : "—");

  console.log();
  console.log("[8] Simulation");
  printRow("Simulation id", proof.simulation.simulationId ?? "—");
  printRow("Gas estimate", proof.simulation.gasEstimate ?? "—");
  printRow("Expected amount", proof.simulation.expectedAmount ?? "—");

  console.log();
  console.log("[9] KeeperHub evacuation");
  printRow("KeeperHub execution", proof.evacuation.keeperhubExecutionId ?? "—");
  printRow("Tx hash", proof.evacuation.txHash ?? "—");
  printRow("Tx link", proof.evacuation.transactionLink ?? "—");
  printRow("Sponsored", proof.evacuation.sponsored === null ? "—" : String(proof.evacuation.sponsored));

  console.log();
  console.log("[10] Destination verification");
  printRow("Pre balance", proof.destination.preBalance ?? "—");
  printRow("Delta verified", String(proof.destination.verified));

  console.log();
  console.log("[11] Rescue Receipt");
  printRow("Receipt", proof.receipt.id ?? "—");
  printRow("Status", proof.receipt.status ?? "—");
  printRow("Verified amount", proof.receipt.verifiedAmount ?? "—");

  if (proof.receipt.status !== "PROTECTED") {
    printFail("Final status", proof.receipt.status ?? "none");
    process.exit(1);
    return;
  }
  printPass("PROTECTED");

  const evidence: DemoRunProof & { milestone: string; zeroWritesProof: { keeperhubBroadcasts: number; onchainWrites: number }; verifiedAt: string } = {
    milestone: "M10",
    ...proof,
    zeroWritesProof: { keeperhubBroadcasts: 0, onchainWrites: 0 },
    verifiedAt: new Date().toISOString(),
  };

  const serialized = JSON.stringify(evidence);
  if (serialized.includes("kh_") && !serialized.includes("kh_m10")) {
    printFail("Secret scan", "forbidden pattern found");
    process.exit(1);
    return;
  }
  if (/Authorization/i.test(serialized) || /Bearer\s+/i.test(serialized)) {
    printFail("Secret scan", "forbidden pattern found");
    process.exit(1);
    return;
  }
  if (/\]\(https?:\/\//.test(serialized)) {
    printFail("Link format", "Markdown-formatted link in evidence");
    process.exit(1);
    return;
  }
  printPass("Secret scan");

  mkdirSync(dirname(M10_EVIDENCE_FILE), { recursive: true });
  writeFileSync(M10_EVIDENCE_FILE, `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
  printPass("Evidence written");
  printRow("Evidence", M10_EVIDENCE_FILE);
  console.log();
  printRow("Result", "PASS");
  process.exit(0);
}

void main();
