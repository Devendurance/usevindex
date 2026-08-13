export const CANONICAL_MOCKS_DISABLED = true;

export function canonicalMockFallback(name: string): never {
  throw new Error(`Canonical runtime mock fallback is disabled (${name}). Live reads must fail closed.`);
}
