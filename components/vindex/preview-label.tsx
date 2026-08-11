export function PreviewLabel({ children = "UI PREVIEW · NO WALLET, RPC, PERSISTENCE, OR TRANSACTION" }: { children?: string }) {
  return <p className="preview-label preview-label--quiet">{children}</p>;
}
