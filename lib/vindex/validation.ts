export const isEvmAddress = (value: string) => /^0x[a-fA-F0-9]{40}$/.test(value.trim());

export const safeWalletError = (value: string) => {
  if (!value.trim()) return "Enter the safe-wallet address before continuing.";
  if (!isEvmAddress(value)) return "Use a valid 0x EVM address with 40 hexadecimal characters.";
  return null;
};
