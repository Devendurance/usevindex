import { CANONICAL_CHAIN } from "./chain";

const TX_HASH_PATTERN = /^0x[a-fA-F0-9]{64}$/;

export const buildBaseScanTxUrl = (txHash: string): string => {
  const trimmed = txHash.trim();
  if (!TX_HASH_PATTERN.test(trimmed)) {
    throw new Error(`Not a valid transaction hash: ${trimmed}`);
  }
  return `${CANONICAL_CHAIN.explorer.url}/tx/${trimmed}`;
};

export const safeBaseScanTxUrl = (txHash: string | null): string | null => {
  if (txHash === null) return null;
  try {
    return buildBaseScanTxUrl(txHash);
  } catch {
    return null;
  }
};
