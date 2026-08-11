import Link from "next/link";
import { CircleDashed, ShieldCheck } from "lucide-react";
import { buildPreviewModel } from "@/lib/vindex/preview-model";
import { firstQueryValue } from "@/lib/vindex/routes";
import { EmptyEvidenceRow } from "@/components/vindex/evidence-panel";
import { RouteDiagram } from "@/components/vindex/route-diagram";
import { StateRail } from "@/components/vindex/state-rail";

export default async function ConfirmPage({ searchParams }: { searchParams: Promise<{ state?: string | string[] }> }) {
  const query = await searchParams;
  const model = buildPreviewModel("confirm", null, firstQueryValue(query.state), "CONFIRMING");
  return (
    <main id="main-content" className="route-page">
      <div className="content-wrap">
        <header className="route-page__heading"><p className="preview-label">PROTECTION DRILL — HIGH-SENSITIVITY POLICY</p><h1>Confirmation in progress</h1><p>Vindex is re-checking live state and simulating the supported exit. No funds have moved.</p></header>
        <StateRail active={model.previewState ?? "CONFIRMING"} />
        <div className="route-grid-2">
          <section className="outline-panel route-card"><h2>Converging evidence</h2><EmptyEvidenceRow title="Oracle / price state" reason="Awaiting confirmation re-read" /><EmptyEvidenceRow title="Aave reserve state" reason="Awaiting confirmation re-read" /><EmptyEvidenceRow title="Protocol event state" reason="Awaiting confirmation re-read" /><div className="evidence-line"><span>Consensus rule</span><strong className="empty-dash">—</strong></div></section>
          <section className="outline-panel route-card"><h2>Pre-execution checks</h2>{["Position still exists", "Duplicate evacuation check", "Exit simulation", "KeeperHub reachability"].map((label) => <div className="check-line" key={label}><span className="check-line__icon"><CircleDashed size={16} aria-hidden="true" /></span><span>{label}</span><strong className="muted">Awaiting live validation</strong></div>)}<RouteDiagram active="Simulation pending" /></section>
        </div>
        <section className="outline-panel monitor-lower"><div className="route-card__footer"><div><p className="data-label">NEXT SAFE ACTION</p><h3>Keep the position under observation while the evidence is checked.</h3></div><Link className="secondary-button" href="/simulation/preview">View simulation preview <ShieldCheck size={16} aria-hidden="true" /></Link></div></section>
      </div>
    </main>
  );
}
