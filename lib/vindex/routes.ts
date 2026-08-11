import type { ProtectionState, RouteKey } from "./types";

export type RouteDefinition = {
  key: RouteKey;
  href: string;
  label: string;
  description: string;
};

export const routeDefinitions: RouteDefinition[] = [
  { key: "landing", href: "/", label: "Landing", description: "The protected route, explained." },
  { key: "demo", href: "/demo", label: "Demo", description: "A visual walkthrough of the route." },
  { key: "setup", href: "/setup", label: "Setup", description: "Configure a supported position." },
  { key: "settings", href: "/settings", label: "Settings", description: "Reconfigure a protected route." },
  { key: "monitor", href: "/monitor", label: "Monitor", description: "Watch current protection state." },
  { key: "confirm", href: "/confirm", label: "Confirm", description: "Review converging evidence." },
  { key: "simulation", href: "/simulation/preview", label: "Simulation", description: "Review a simulation-only result." },
  { key: "evacuation", href: "/evacuation/preview", label: "Evacuation", description: "Follow an execution preview." },
  { key: "receipt", href: "/receipt/preview", label: "Receipt", description: "Inspect receipt anatomy." },
  { key: "audit", href: "/audit/preview", label: "Audit trail", description: "Inspect the evidence chain." },
  { key: "outcome", href: "/outcome/preview", label: "Outcome", description: "Understand blocked outcomes." },
];

export const publicStates: Array<{ label: string; state: ProtectionState | null }> = [
  { label: "WATCHING", state: "WATCHING" },
  { label: "ELEVATED", state: "ELEVATED" },
  { label: "CONFIRMING", state: "CONFIRMING" },
  { label: "EVACUATING", state: "EXECUTING" },
  { label: "PROTECTED", state: "PROTECTED" },
];

export const firstQueryValue = (value: string | string[] | undefined) =>
  Array.isArray(value) ? value[0] : value;

export const previewStateFromQuery = (value: string | undefined, fallback: ProtectionState | null = null) => {
  const normalized = value?.toUpperCase().replace(/-/g, "_");
  const allowed: ProtectionState[] = [
    "WATCHING",
    "ELEVATED",
    "DEGRADED",
    "CONFIRMING",
    "SIMULATING",
    "EXECUTION_QUEUED",
    "EXECUTING",
    "VERIFYING",
    "PROTECTED",
    "BLOCKED",
    "FAILED",
    "EXECUTION_UNKNOWN",
    "INTERVENTION_REQUIRED",
  ];
  return normalized && allowed.includes(normalized as ProtectionState)
    ? (normalized as ProtectionState)
    : fallback;
};
