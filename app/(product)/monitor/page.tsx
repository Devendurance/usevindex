import { Activity, ArrowRight, CircleAlert, Play } from "lucide-react";
import Link from "next/link";
import { buildPreviewModel } from "@/lib/vindex/preview-model";
import { firstQueryValue } from "@/lib/vindex/routes";
import { EmptyEvidenceRow, EvidenceValue } from "@/components/vindex/evidence-panel";
import { RouteDiagram } from "@/components/vindex/route-diagram";
import { StateRail } from "@/components/vindex/state-rail";

export default async function MonitorPage({ searchParams }: { searchParams: Promise<{ state?: string | string[] }> }) {
  const query = await searchParams;
  const model = buildPreviewModel("monitor", null, firstQueryValue(query.state), "WATCHING");
  const monitorLabel = model.previewState === "DEGRADED" ? "MONITORING DEGRADED" : "MONITORING PREVIEW";
  const monitorCopy = model.previewState === "DEGRADED"
    ? "Live observations are stale or unavailable. No evacuation has been triggered."
    : model.previewState === "ELEVATED"
      ? "Signals are elevated in this controlled preview. No evacuation has been triggered."
      : "Monitoring active. No confirmed protection condition.";
  return (
    <main id="main-content" className="route-page">
      <div className="content-wrap">
        <header className="state-heading"><span className="state-heading__mark"><Activity size={22} aria-hidden="true" /></span><div><p className="data-label">{monitorLabel}</p><h1>Protected route</h1><p>{monitorCopy}</p></div></header>
        <StateRail active={model.previewState ?? "WATCHING"} />
        <div className="route-grid-3">
          <section className="outline-panel route-card"><h2>Decision window</h2><EvidenceValue evidence={model.state} label="Threat level" empty="Awaiting live data" /><EvidenceValue evidence={model.signals} label="Signals" empty="Awaiting live data" /><EvidenceValue evidence={model.execution} label="Next step" empty="No live decision" /><div className="evidence-line"><span>Funds moved</span><strong>No</strong></div></section>
          <section className="outline-panel route-card"><h2>Latest observations</h2><EmptyEvidenceRow title="Oracle / price state" reason="Awaiting live observation" meta="block —" /><EmptyEvidenceRow title="Aave reserve state" reason="Awaiting live observation" meta="block —" /><EmptyEvidenceRow title="Protocol event state" reason="Awaiting live observation" meta="block —" /></section>
          <section className="outline-panel route-card"><h2>Supported exit</h2><RouteDiagram /><button className="primary-cta" type="button" disabled><Play size={15} aria-hidden="true" /> RUN A DRY RUN</button><p className="form-note">Unavailable without live validation.</p></section>
        </div>
        <section className="outline-panel monitor-lower"><div className="route-card__footer"><div><p className="data-label">DECISION REASON</p><h3>Waiting for the configured policy to evaluate live observations.</h3></div><Link className="text-button" href="/audit/preview">View audit trail <ArrowRight size={15} aria-hidden="true" /></Link></div></section>
        <section className="outline-panel monitor-lower"><div className="route-card__footer"><div><p className="state-label">Signals elevated</p><p className="muted">An unusual pattern can be reviewed here when live evidence exists. No evacuation has been triggered.</p></div><CircleAlert size={22} aria-hidden="true" /></div></section>
      </div>
    </main>
  );
}
