import type { ReactNode } from "react";
import { SiteNav } from "./site-nav";

export function MarketingShell({ children }: { children: ReactNode }) {
  return (
    <div className="page-shell marketing-shell mesh-field" data-page-ready="true">
      <a className="skip-link" href="#main-content">Skip to content</a>
      <SiteNav variant="marketing" />
      {children}
    </div>
  );
}
