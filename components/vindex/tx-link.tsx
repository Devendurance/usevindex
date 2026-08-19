// Canonical Base Sepolia transaction link. The href is always the plain,
// full canonical URL — never Markdown. Transaction hashes may stay truncated
// as the visible label.
export function TxLink({
  href,
  children = "Tx link",
  className,
}: {
  href: string;
  children?: React.ReactNode;
  className?: string;
}) {
  return (
    <a className={className ?? "tx-link"} href={href} target="_blank" rel="noopener noreferrer">
      {children}
    </a>
  );
}
