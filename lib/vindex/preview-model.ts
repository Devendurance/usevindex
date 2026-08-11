import { previewStateFromQuery } from "./routes";
import type { ProtectionState, RouteKey, VindexViewModel } from "./types";
import { unavailableEvidence } from "./types";

const reasons = {
  state: "Live protection state will appear when the server is connected.",
  position: "Position data will appear after live chain validation.",
  signals: "Signal observations require a live RPC source.",
  execution: "KeeperHub execution data is unavailable in this UI preview.",
  receipt: "A Rescue Receipt is created only from verified execution evidence.",
};

export const buildPreviewModel = (
  route: RouteKey,
  routeParam: string | null = null,
  queryState?: string,
  fallbackState: ProtectionState | null = null,
): VindexViewModel => ({
  mode: "ui-preview",
  route,
  previewState: previewStateFromQuery(queryState, fallbackState),
  routeParam,
  scope: {
    network: "Base Sepolia",
    protocol: "Aave V3",
    asset: "USDC — Aave Base Sepolia test asset",
  },
  state: unavailableEvidence(reasons.state),
  position: unavailableEvidence(reasons.position),
  signals: unavailableEvidence(reasons.signals),
  execution: unavailableEvidence(reasons.execution),
  receipt: unavailableEvidence(reasons.receipt),
});

export const displayEvidence = <T>(evidence: { value: T | null; reason: string }, empty = "—") =>
  evidence.value === null ? empty : evidence.value;
