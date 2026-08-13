// Client-safe signal family labels (no server-only import — used from
// client components on the monitor dashboard and the rescue receipt).

export const FAMILY_METRIC_LABEL: Record<string, string> = {
  ORACLE_PRICE_STATE: "Oracle Price State",
  AAVE_RESERVE_STATE: "Aave Reserve State",
  POSITION_STATE: "Position State",
};

export const formatFamilyLabel = (family: string): string =>
  FAMILY_METRIC_LABEL[family] ?? family.replace(/_/g, " ");
