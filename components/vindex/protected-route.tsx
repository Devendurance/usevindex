type ProtectedRouteProps = {
  compact?: boolean;
  variant?: "default" | "hero";
};

export function ProtectedRoute({ compact = false, variant = "default" }: ProtectedRouteProps) {
  const isHero = variant === "hero";

  return (
    <div
      className={`protected-route${compact ? " protected-route--compact" : ""}${isHero ? " protected-route--hero" : ""}`}
      aria-label={isHero ? "Protected Route to a safe wallet" : "Protected Route: Watch, Confirm, Exit, Verify"}
    >
      <div className="protected-route__line" aria-hidden="true">
        {isHero ? (
          <svg viewBox="0 0 520 96" preserveAspectRatio="none">
            <path d="M20 58 C 86 26, 130 82, 204 52 S 328 27, 426 48" />
            <path d="M409 37 431 49 411 62" />
          </svg>
        ) : (
          <svg viewBox="0 0 760 140" preserveAspectRatio="none">
            <path d="M8 100 C 115 62, 120 113, 198 83 S 355 80, 446 84 S 577 91, 660 35" />
            <path d="M646 29 668 31 656 47" />
          </svg>
        )}
      </div>
      {!compact && !isHero && (
        <div className="protected-route__labels" aria-hidden="true">
          <span>WATCH</span><span>CONFIRM</span><span>SAFE WALLET</span>
        </div>
      )}
    </div>
  );
}
