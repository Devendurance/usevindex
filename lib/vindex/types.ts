export type EvidenceStatus = "available" | "unavailable";

export type Evidence<T> = {
  value: T | null;
  status: EvidenceStatus;
  reason: string;
};

export type ProtectionState =
  | "DRAFT"
  | "WATCHING"
  | "ELEVATED"
  | "DEGRADED"
  | "CONFIRMING"
  | "SIMULATING"
  | "EXECUTION_QUEUED"
  | "EXECUTING"
  | "VERIFYING"
  | "PROTECTED"
  | "BLOCKED"
  | "FAILED"
  | "EXECUTION_UNKNOWN"
  | "INTERVENTION_REQUIRED";

export type PublicState =
  | "WATCHING"
  | "ELEVATED"
  | "CONFIRMING"
  | "EVACUATING"
  | "PROTECTED"
  | "BLOCKED"
  | "EXECUTION UNKNOWN"
  | "INTERVENTION REQUIRED";

export type RouteKey =
  | "landing"
  | "demo"
  | "setup"
  | "settings"
  | "monitor"
  | "confirm"
  | "simulation"
  | "evacuation"
  | "receipt"
  | "audit"
  | "outcome";

export type PositionEvidence = {
  amount: string;
  asset: string;
  protocol: string;
};

export type SignalObservation = {
  family: string;
  value: string;
  block: string;
  observed: string;
};

export type ExecutionEvidence = {
  executionId: string;
  transactionHash: string;
  status: string;
};

export type ReceiptEvidence = {
  receiptId: string;
  destination: string;
  verification: string;
};

export type VindexViewModel = {
  mode: "ui-preview";
  route: RouteKey;
  previewState: ProtectionState | null;
  routeParam: string | null;
  scope: {
    network: "Base Sepolia";
    protocol: "Aave V3";
    asset: "USDC — Aave Base Sepolia test asset";
  };
  state: Evidence<ProtectionState>;
  position: Evidence<PositionEvidence>;
  signals: Evidence<SignalObservation[]>;
  execution: Evidence<ExecutionEvidence>;
  receipt: Evidence<ReceiptEvidence>;
};

export const unavailableEvidence = <T>(reason: string): Evidence<T> => ({
  value: null,
  status: "unavailable",
  reason,
});
