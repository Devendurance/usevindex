// M5 policy templates — explicit, versioned, server-side. Thresholds are FIXED
// constants over the real M4 metrics; they are never derived from current
// values to force a match, and never injected as inputs by the client.
//
// DRILL_HIGH_SENSITIVITY uses intentionally sensitive thresholds for a
// transparent protection drill. Matching families are drill conditions, NOT
// evidence of a real Aave exploit.

export const POLICY_TEMPLATE_VERSION = 1;

export type PolicyMode = "STANDARD" | "DRILL_HIGH_SENSITIVITY";

export type PolicyRule = {
  family: "ORACLE_PRICE_STATE" | "AAVE_RESERVE_STATE" | "POSITION_STATE";
  condition: string;
};

export type PolicyTemplate = {
  version: number;
  mode: PolicyMode;
  requiredSignals: number;
  correlationWindowSec: number;
  rules: PolicyRule[];
  thresholds: Record<string, unknown>;
};

// STANDARD — conservative expectations for a healthy Aave market.
export const STANDARD_TEMPLATE: PolicyTemplate = {
  version: POLICY_TEMPLATE_VERSION,
  mode: "STANDARD",
  requiredSignals: 2,
  correlationWindowSec: 600,
  rules: [
    {
      family: "ORACLE_PRICE_STATE",
      condition:
        "AAVE_USDC_ORACLE_PRICE outside 0.97–1.03 USD (raw < 97_000_000 or > 103_000_000, 8 decimals)",
    },
    {
      family: "AAVE_RESERVE_STATE",
      condition:
        "reserve isFrozen == true OR AAVE_RESERVE_TOTAL_ATOKEN drop >= 15% within the correlation window",
    },
    {
      family: "POSITION_STATE",
      condition: "POSITION_AUSDC_BALANCE drop >= 10% within the correlation window",
    },
  ],
  thresholds: {
    oracleMinUsd8: 97_000_000,
    oracleMaxUsd8: 103_000_000,
    reserveSupplyDropPct: 15,
    positionDropPct: 10,
  },
};

// DRILL_HIGH_SENSITIVITY — same real observations, demo-sensitive conditions.
export const DRILL_TEMPLATE: PolicyTemplate = {
  version: POLICY_TEMPLATE_VERSION,
  mode: "DRILL_HIGH_SENSITIVITY",
  requiredSignals: 2,
  correlationWindowSec: 600,
  rules: [
    {
      family: "ORACLE_PRICE_STATE",
      condition: "AAVE_USDC_ORACLE_PRICE <= 1.01 USD (raw <= 101_000_000, 8 decimals)",
    },
    {
      family: "AAVE_RESERVE_STATE",
      condition: "AAVE_RESERVE_TOTAL_VARIABLE_DEBT > 0",
    },
    {
      family: "POSITION_STATE",
      condition: "POSITION_AUSDC_BALANCE > 0",
    },
  ],
  thresholds: {
    oracleMaxUsd8: 101_000_000,
    reserveVariableDebtMin: 0,
    positionBalanceMin: 0,
    drillLabel: "PROTECTION DRILL — HIGH-SENSITIVITY POLICY",
  },
};

export const POLICY_TEMPLATES: Record<PolicyMode, PolicyTemplate> = {
  STANDARD: STANDARD_TEMPLATE,
  DRILL_HIGH_SENSITIVITY: DRILL_TEMPLATE,
};

export const POLICY_MODES = ["STANDARD", "DRILL_HIGH_SENSITIVITY"] as const;

export const DRILL_LABEL = "PROTECTION DRILL — HIGH-SENSITIVITY POLICY" as const;

export const DRILL_EXPLANATION =
  "Real measurements with intentionally sensitive thresholds. This is a protection drill, not evidence of an Aave exploit." as const;
