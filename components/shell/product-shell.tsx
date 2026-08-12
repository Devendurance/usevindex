import type { ReactNode } from "react";
import { SiteNav } from "./site-nav";
import { PreviewLabelBar } from "./preview-label-bar";

export function ProductShell({ children }: { children: ReactNode }) {
  return (
    <div className="page-shell product-shell mesh-field" data-page-ready="true">
      <a className="skip-link" href="#main-content">Skip to content</a>
      <SiteNav variant="product" />
      <div className="content-wrap product-preview-bar"><PreviewLabelBar /></div>
      {children}
    </div>
  );
}
