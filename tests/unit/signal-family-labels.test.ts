// P1 matched-family readability: human labels, one stacked row per family,
// and the component never re-introduces the run-on "FAMILYreason" markup.

import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";

import { FAMILY_METRIC_LABEL, formatFamilyLabel } from "../../lib/signal-family-labels";

describe("family labels", () => {
  it("maps the three signal families to readable labels", () => {
    expect(FAMILY_METRIC_LABEL.ORACLE_PRICE_STATE).toBe("Oracle Price State");
    expect(FAMILY_METRIC_LABEL.AAVE_RESERVE_STATE).toBe("Aave Reserve State");
    expect(FAMILY_METRIC_LABEL.POSITION_STATE).toBe("Position State");
  });

  it("falls back to a spaced enum name for unknown families", () => {
    expect(formatFamilyLabel("SOME_NEW_FAMILY")).toBe("SOME NEW FAMILY");
  });

  it("labels are human-readable (no raw enum names)", () => {
    expect(formatFamilyLabel("ORACLE_PRICE_STATE")).not.toContain("_");
    expect(FAMILY_METRIC_LABEL.AAVE_RESERVE_STATE.toLowerCase()).toContain("aave");
  });
});

describe("MatchedFamilyList markup", () => {
  it("renders a separate row per family with the reason on its own line", async () => {
    const source = await readFile("components/vindex/matched-family-list.tsx", "utf8");
    expect(source).toContain("formatFamilyLabel");
    expect(source).toContain("key={family.family}");
    // The reason must be its own element, not concatenated with the family name.
    expect(source).not.toMatch(/\{family\.family\}\{family\.reason\}|<strong>\{family\.family\}<span>/);
    // No server-only import (client component).
    expect(source).not.toContain("server-only");
  });

  it("monitor and receipt use the shared component instead of inline lists", async () => {
    const monitor = await readFile("components/dashboard/monitor-dashboard.tsx", "utf8");
    expect(monitor).toContain("<MatchedFamilyList");
    expect(monitor).not.toMatch(/<ul className="muted">[\s\S]*matchedFamilies\.map/);
    const receipt = await readFile("components/dashboard/rescue-receipt-live.tsx", "utf8");
    expect(receipt).toContain("<MatchedFamilyList");
  });
});
