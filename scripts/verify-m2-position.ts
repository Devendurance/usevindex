import "dotenv/config";

import { getServerEnv, VindexEnvError } from "../lib/vindex/env";
import { runM2PositionProof } from "../lib/vindex/m2-execution";
import type { M2ExecutionResult } from "../lib/vindex/m2-execution";
import { M2_EVIDENCE_FILE } from "../lib/vindex/m2-evidence";

const printRow = (label: string, value: string): void => {
  console.log(`${label.padEnd(32, ".")} ${value}`);
};

const printVerified = (result: Extract<M2ExecutionResult, { outcome: "VERIFIED" }>): void => {
  const { evidence } = result;

  console.log("VINDEX M2 AAVE POSITION PROOF");
  console.log();
  printRow("KeeperHub wallet", evidence.keeperHubWallet);
  printRow("Asset", `${evidence.asset} (USDC — Aave Base Sepolia)`);
  printRow(
    "Supply amount",
    `${evidence.supplyAmountFormatted} USDC (${evidence.supplyAmountBaseUnits} base units)`,
  );
  console.log();
  printRow(
    "Pre-state",
    `USDC ${evidence.preState.usdcBalance} | aUSDC ${evidence.preState.aUsdcBalance} | allowance ${evidence.preState.allowance} | block ${evidence.preState.blockNumber}`,
  );
  console.log();

  if (evidence.funding !== null) {
    printRow("Funding", `PASS (execution ${evidence.funding.executionId})`);
  } else {
    printRow("Funding", "not required");
  }
  if (evidence.approval !== null) {
    printRow("Approval", `PASS (execution ${evidence.approval.executionId})`);
  } else {
    printRow("Approval", "not required (allowance sufficient)");
  }
  if (evidence.supply !== null) {
    printRow("Supply", `PASS (execution ${evidence.supply.executionId})`);
    printRow("Supply tx", evidence.supply.transactionHash);
    printRow("Transaction link", evidence.supply.transactionLink ?? "—");
    printRow("Receipt", "success (verified)");
    printRow("Block", evidence.supply.blockNumber !== null ? String(evidence.supply.blockNumber) : "—");
  } else {
    printRow("Supply", "pre-existing position (adopted)");
  }
  console.log();
  printRow(
    "Post-state",
    `USDC ${evidence.postState.usdcBalance} | aUSDC ${evidence.postState.aUsdcBalance} | allowance ${evidence.postState.allowance} | block ${evidence.postState.blockNumber}`,
  );
  const aUsdcBefore = BigInt(evidence.preState.aUsdcBalance || "0");
  const aUsdcAfter = BigInt(evidence.postState.aUsdcBalance || "0");
  printRow("aUSDC increase", `${(aUsdcAfter - aUsdcBefore).toString()} base units`);
  printRow("Position verified", "yes");
  console.log();
  printRow("Evidence", M2_EVIDENCE_FILE);
  printRow("Result", "PASS");
};

async function main(): Promise<void> {
  let result: M2ExecutionResult;
  try {
    result = await runM2PositionProof({ env: getServerEnv() });
  } catch (error) {
    if (error instanceof VindexEnvError) {
      console.log("VINDEX M2 POSITION — ENVIRONMENT NOT CONFIGURED");
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

    case "M2_ALREADY_VERIFIED":
      console.log(
        `M2_ALREADY_VERIFIED — a verified Aave USDC position already exists (aUSDC ${result.evidence.postState.aUsdcBalance}). No new supply was executed.`,
      );
      process.exitCode = 0;
      return;

    case "M2_TOKEN_FUNDING_REQUIRED":
      console.log("VINDEX M2 POSITION — FUNDING REQUIRED");
      console.log();
      console.log(result.message);
      process.exitCode = 1;
      return;

    case "KEEPERHUB_WALLET_NOT_CONFIGURED":
    case "KEEPERHUB_WALLET_INVALID":
      console.log(result.message);
      process.exitCode = 1;
      return;

    case "BLOCKED":
      console.log("VINDEX M2 POSITION — BLOCKED");
      console.log();
      console.log(`Stage: ${result.stage}`);
      console.log(result.reason);
      process.exitCode = 1;
      return;

    case "FAILED":
      console.log("VINDEX M2 POSITION — FAILED");
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
