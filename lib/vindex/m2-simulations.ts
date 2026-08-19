// M2 simulation evidence: persisted BEFORE any real broadcast and immutable
// afterwards, so a pre-broadcast simulation can never be overwritten by a
// post-broadcast re-run.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { M2SimulationRecord } from "./m2-evidence";

export const M2_SIMULATIONS_DIR = "artifacts/m2-simulations" as const;

export function simulationPath(intentId: string, dir: string = M2_SIMULATIONS_DIR): string {
  return `${dir}/${intentId}.json`;
}

export function writeSimulationBeforeBroadcast(
  intentId: string,
  record: M2SimulationRecord,
  dir: string = M2_SIMULATIONS_DIR,
): void {
  const path = simulationPath(intentId, dir);
  if (existsSync(path)) {
    throw new Error(`Simulation evidence already persisted for ${intentId}`);
  }
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(record, null, 2)}\n`, "utf8");
}

export function loadSimulation(intentId: string, dir: string = M2_SIMULATIONS_DIR): M2SimulationRecord | null {
  let raw: string;
  try {
    raw = readFileSync(simulationPath(intentId, dir), "utf8");
  } catch {
    return null;
  }

  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return null;
    }
    return parsed as M2SimulationRecord;
  } catch {
    return null;
  }
}

export function hasSimulation(intentId: string, dir: string = M2_SIMULATIONS_DIR): boolean {
  return existsSync(simulationPath(intentId, dir));
}
