"use client";

import { usePathname } from "next/navigation";
import { PreviewLabel } from "@/components/vindex/preview-label";

const PREVIEW_ROUTE_PATTERNS = [
  /^\/demo$/,
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
