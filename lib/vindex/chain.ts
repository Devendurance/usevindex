import { baseSepolia } from "viem/chains";

export const VINDEX_CHAIN_ID = 84532;

export const CANONICAL_CHAIN = {
  id: VINDEX_CHAIN_ID,
  name: "Base Sepolia",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  testnet: true,
  explorer: { name: "BaseScan Sepolia", url: "https://sepolia.basescan.org" },
  defaultRpcUrl: "https://sepolia.base.org",
} as const;

export class WrongChainError extends Error {
  readonly actualChainId: number;

  constructor(actualChainId: number) {
    super(`Expected chain ${VINDEX_CHAIN_ID} (Base Sepolia), got ${actualChainId}.`);
    this.name = "WrongChainError";
    this.actualChainId = actualChainId;
  }
}

export function assertCanonicalChainId(chainId: number): void {
  if (chainId !== VINDEX_CHAIN_ID) {
    throw new WrongChainError(chainId);
  }
}

export { baseSepolia };
