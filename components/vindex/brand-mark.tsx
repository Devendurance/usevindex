type BrandMarkProps = { compact?: boolean };

export function BrandMark({ compact = false }: BrandMarkProps) {
  return (
    <span className={`brand-lockup${compact ? " brand-lockup--compact" : ""}`} aria-label="Vindex">
      <svg className="brand-mark" viewBox="0 0 32 32" aria-hidden="true">
        <path d="M5 7.5 16 24 27 7.5" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />
        <path d="M10 7.5 16 16l6-8.5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" opacity=".45" />
      </svg>
      {!compact && <span className="brand-wordmark">vindex</span>}
    </span>
  );
}
