import Link from "next/link";
import { CircleDashed } from "lucide-react";
import { normalizeRouteParam } from "@/lib/vindex/route-params";
import { buildPreviewModel } from "@/lib/vindex/preview-model";
import { firstQueryValue } from "@/lib/vindex/routes";
import { EmptyEvidenceRow } from "@/components/vindex/evidence-panel";
import { RouteDiagram } from "@/components/vindex/route-diagram";
import { StateRail } from "@/components/vindex/state-rail";

export default async function EvacuationPage({ params, searchParams }: { params: Promise<{ executionId: string }>; searchParams: Promise<{ state?: string | string[] }> }) {
  const { executionId } = await params;
  const query = await searchParams;
  const model = buildPreviewModel("evacuation", normalizeRouteParam(executionId), firstQueryValue(query.state), "EXECUTING");
  return (
    <main id="main-content" className="route-page"><div className="content-wrap">
      <header className="route-page__heading"><p className="preview-label">PROTECTION DRILL — HIGH-SENSITIVITY POLICY</p><h1>Evacuation active</h1><p>KeeperHub is executing the protected route. Destination verification is pending.</p><p className="state-label">{model.previewState ?? "EXECUTING"}</p></header>
      <StateRail active="EVACUATING" />
      <section className="outline-panel route-card"><div className="state-heading"><span className="state-heading__mark"><CircleDashed size={22} aria-hidden="true" /></span><div><p className="data-label">EXECUTION PREVIEW</p><h2>Awaiting live execution record</h2><p className="muted">The route is visible, but no execution has been submitted in this UI preview.</p></div></div><div className="route-grid-3"><EmptyEvidenceRow title="KeeperHub execution" reason="No live record" /><EmptyEvidenceRow title="Transaction hash" reason="No live record" /><EmptyEvidenceRow title="Safe-wallet verification" reason="Not started" /></div><RouteDiagram active="Destination verification pending" /></section>
      <div className="diagnostic-actions"><Link className="secondary-button" href="/monitor">Back to monitor</Link><Link className="secondary-button" href="/audit/preview">View audit trail</Link></div>
    </div></main>
  );
}
