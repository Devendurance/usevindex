import "dotenv/config";

import { CANONICAL_CHAIN } from "../lib/vindex/chain";
import { getServerEnv, VindexEnvError } from "../lib/vindex/env";
import { runFoundationVerification } from "../lib/vindex/foundation";
import type { FoundationVerificationReport } from "../lib/vindex/foundation";

const printRow = (label: string, value: string): void => {
  console.log(`${label.padEnd(32, ".")} ${value}`);
};

const printReport = (report: FoundationVerificationReport): void => {
  console.log("VINDEX M0 FOUNDATION");
  console.log();

  const { chain, contracts, keeperhub, mocksDisabled, passed } = report;

  if (chain.actualChainId !== null) {
    printRow("Base Sepolia RPC", "PASS");
  } else {
    printRow("Base Sepolia RPC", `FAIL ${chain.error ?? "RPC unreachable"}`);
  }

  if (chain.chainVerified) {
    printRow(`Chain ID ${CANONICAL_CHAIN.id}`, `PASS (${chain.actualChainId})`);
  } else if (chain.actualChainId !== null) {
    printRow(`Chain ID ${CANONICAL_CHAIN.id}`, `FAIL (got ${chain.actualChainId})`);
  } else {
    printRow(`Chain ID ${CANONICAL_CHAIN.id}`, `FAIL ${chain.error ?? "unknown error"}`);
  }

  if (chain.latestBlock !== null) {
    printRow("Latest block", String(chain.latestBlock));
  } else {
    printRow("Latest block", `FAIL ${chain.error ?? "unknown error"}`);
  }
  console.log();

  if (contracts === null) {
    printRow("Aave contracts", "FAIL (chain not verified — checks skipped)");
  } else {
    for (const check of contracts.contracts) {
      printRow(check.label, check.passed ? "PASS" : `FAIL ${check.error ?? "no bytecode at address"}`);
    }

    const { usdc, aToken, providerPoolMatch } = contracts.asset;

    if (usdc.decimalsVerified) {
      printRow("USDC decimals", String(usdc.decimals));
    } else if (usdc.decimals !== null) {
      printRow("USDC decimals", `FAIL (expected ${usdc.decimalsExpected}, got ${usdc.decimals})`);
    } else {
      printRow("USDC decimals", `FAIL ${usdc.error ?? "read failed"}`);
    }

    if (usdc.symbolVerified) {
      printRow("USDC symbol", usdc.symbol ?? "");
    } else if (usdc.symbol !== null) {
      printRow("USDC symbol", `FAIL (expected ${usdc.symbolExpected}, got ${usdc.symbol})`);
    } else {
      printRow("USDC symbol", `FAIL ${usdc.error ?? "read failed"}`);
    }

    if (aToken.passed) {
      printRow("aUSDC/aToken identity", "PASS");
    } else {
      printRow(
        "aUSDC/aToken identity",
        `FAIL ${aToken.error ?? `(observed ${aToken.observedATokenAddress ?? "none"})`}`,
      );
    }

    printRow("Pool <-> provider match", providerPoolMatch ? "PASS" : "FAIL");
  }
  console.log();

  const health = keeperhub.health;
  if (health !== null && health.reachable) {
    printRow("KeeperHub reachable", "PASS");
  } else if (health !== null) {
    printRow("KeeperHub reachable", `FAIL (${health.errorCategory ?? "unreachable"})`);
  } else {
    printRow("KeeperHub reachable", `FAIL ${keeperhub.error ?? "health check failed"}`);
  }

  if (health !== null && health.authenticated) {
    printRow("KeeperHub authenticated", "PASS");
  } else if (health !== null && health.statusCode !== null) {
    printRow("KeeperHub authenticated", `FAIL (status ${health.statusCode})`);
  } else if (health !== null) {
    printRow("KeeperHub authenticated", `FAIL (${health.errorCategory ?? "unknown"})`);
  } else {
    printRow("KeeperHub authenticated", `FAIL ${keeperhub.error ?? "health check failed"}`);
  }
  console.log();

  printRow("Mocks on canonical path", mocksDisabled ? "DISABLED" : "ENABLED (unsafe)");
  console.log();

  printRow("Result", passed ? "PASS" : "FAIL");
  process.exitCode = passed ? 0 : 1;
};

async function main(): Promise<void> {
  let report: FoundationVerificationReport;
  try {
    report = await runFoundationVerification(getServerEnv());
  } catch (error) {
    if (error instanceof VindexEnvError) {
      console.log("VINDEX M0 FOUNDATION — ENVIRONMENT NOT CONFIGURED");
      console.log();
      console.log(error.message);
      process.exitCode = 1;
      return;
    }
    throw error;
  }

  printReport(report);
}

void main();
