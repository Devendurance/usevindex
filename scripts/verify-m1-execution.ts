import "dotenv/config";

import { getServerEnv, VindexEnvError } from "../lib/vindex/env";
import { runM1ExecutionProof } from "../lib/vindex/m1-execution";
import type { M1ExecutionResult } from "../lib/vindex/m1-execution";
import { AAVE_V3_BASE_SEPOLIA } from "../lib/vindex/aave-registry";
import { M1_EVIDENCE_FILE } from "../lib/vindex/m1-evidence";

const printRow = (label: string, value: string): void => {
  console.log(`${label.padEnd(32, ".")} ${value}`);
};

const printVerified = (result: Extract<M1ExecutionResult, { outcome: "VERIFIED" }>): void => {
  const { evidence } = result;

  console.log("VINDEX M1 KEEPERHUB EXECUTION PROOF");
  console.log();
  printRow("KeeperHub wallet", evidence.keeperHubWallet);
  printRow("Execution mode", evidence.sponsored ? "sponsored (EIP-7702)" : "direct");
  if (evidence.sponsored) {
    printRow("Executor address", evidence.executorAddress ?? "—");
  }
  printRow("Token contract", AAVE_V3_BASE_SEPOLIA.usdcUnderlying);
  printRow("Spender", AAVE_V3_BASE_SEPOLIA.pool);
  printRow("Function", evidence.functionName);
  printRow("Amount", `${evidence.amountBaseUnits} base unit (0.000001 USDC)`);
  console.log();
  printRow("Allowance before", evidence.allowanceBefore);
  printRow("Simulation", evidence.simulation?.success === true ? "PASS" : "—");
  printRow("Execution id", evidence.executionId);
  printRow("Terminal status", evidence.keeperHubStatus);
  printRow("Transaction hash", evidence.transactionHash);
  printRow("Transaction link", evidence.transactionLink ?? "—");
  printRow("Gas used (wei)", evidence.gasUsedWei ?? "—");
  console.log();
  printRow("Receipt status", evidence.onchainReceiptStatus);
  printRow("Block", evidence.blockNumber !== null ? String(evidence.blockNumber) : "—");
  printRow("Allowance after", evidence.allowanceAfter);
  console.log();
  printRow("Evidence", M1_EVIDENCE_FILE);
  printRow("Result", "PASS");
};

async function main(): Promise<void> {
  let result: M1ExecutionResult;
  try {
    result = await runM1ExecutionProof({ env: getServerEnv() });
  } catch (error) {
    if (error instanceof VindexEnvError) {
      console.log("VINDEX M1 EXECUTION — ENVIRONMENT NOT CONFIGURED");
      console.log();
      console.log(error.message);
      process.exitCode = 1;
      return;
    }
    throw error;
  }

  switch (result.outcome) {
    case "VERIFIED":
      printVerified(result);
      process.exitCode = 0;
      return;

    case "M1_ALREADY_VERIFIED":
      console.log(
        `M1_ALREADY_VERIFIED — a verified M1 transaction already exists (tx ${result.evidence.transactionHash}). No new transaction was broadcast.`,
      );
      process.exitCode = 0;
      return;

    case "KEEPERHUB_WALLET_NOT_CONFIGURED":
    case "KEEPERHUB_WALLET_INVALID":
      console.log(result.message);
      process.exitCode = 1;
      return;

    case "BLOCKED":
      console.log("VINDEX M1 EXECUTION — BLOCKED");
      console.log();
      console.log(`Stage: ${result.stage}`);
      console.log(result.reason);
      process.exitCode = 1;
      return;

    case "FAILED":
      console.log("VINDEX M1 EXECUTION — FAILED");
      console.log();
      console.log(`Stage: ${result.stage}`);
      if (result.executionId !== undefined) {
        console.log(`Execution id: ${result.executionId}`);
      }
      console.log(result.reason);
      process.exitCode = 1;
      return;
  }
}

void main();
