"use client";

import { usePathname } from "next/navigation";
import { PreviewLabel } from "@/components/vindex/preview-label";

// /demo is intentionally NOT in this list: the demo page is the live demo
// surface (real RPC reads, real KeeperHub writes), so the static "UI PREVIEW
// · NO WALLET, RPC, PERSISTENCE, OR TRANSACTION" bar would lie about it.
const PREVIEW_ROUTE_PATTERNS = [
  /^\/simulation\//,
  /^\/audit\//,
  /^\/receipt\//,
  /^\/evacuation\//,
  /^\/outcome\//,
  /^\/confirm/,
];

export function PreviewLabelBar() {
  const pathname = usePathname();
  const isPreview = PREVIEW_ROUTE_PATTERNS.some((pattern) => pattern.test(pathname));
  if (!isPreview) return null;
  return <PreviewLabel />;
}
