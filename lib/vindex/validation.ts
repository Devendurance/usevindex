export const isEvmAddress = (value: string) => /^0x[a-fA-F0-9]{40}$/.test(value.trim());

export const safeWalletError = (value: string) => {
  if (!value.trim()) return "Enter the safe-wallet address before continuing.";
  if (!isEvmAddress(value)) return "Use a valid 0x EVM address with 40 hexadecimal characters.";
  return null;
};

// Normalizes an external transaction link into a plain https URL string before
// it is persisted or serialized. Markdown-formatted values such as
// "[https://a](https://a)" are stripped to the plain URL; anything that is not
// an https URL is rejected (null) so evidence never carries malformed links.
export const normalizeTransactionLink = (value: string | null): string | null => {
  if (value === null) return null;
  const trimmed = value.trim();
  if (trimmed === "") return null;
  const markdown = trimmed.match(/^\[[^\]]+\]\(([^)]+)\)$/);
  const candidate = markdown !== null ? markdown[1].trim() : trimmed;
  try {
    const parsed = new URL(candidate);
    if (parsed.protocol !== "https:") return null;
    return parsed.toString();
  } catch {
    return null;
  }
};

