import Link from "next/link";
import { CircleDashed } from "lucide-react";
import { normalizeRouteParam } from "@/lib/vindex/route-params";
import { buildPreviewModel } from "@/lib/vindex/preview-model";
import { firstQueryValue } from "@/lib/vindex/routes";
import { RouteDiagram } from "@/components/vindex/route-diagram";

export default async function SimulationPage({ params, searchParams }: { params: Promise<{ simulationId: string }>; searchParams: Promise<{ state?: string | string[] }> }) {
  const { simulationId } = await params;
  const query = await searchParams;
  const model = buildPreviewModel("simulation", normalizeRouteParam(simulationId), firstQueryValue(query.state), "SIMULATING");
  return (
    <main id="main-content" className="route-page"><div className="content-wrap">
      <header className="route-page__heading"><p className="preview-label">SIMULATION ONLY</p><h1>Exit simulation</h1><p>The supported exit must pass validation before any execution can begin. No funds have moved.</p><p className="state-label">{model.previewState ?? "SIMULATING"}</p></header>
      <div className="route-grid-2"><section className="outline-panel route-card"><div className="state-heading"><span className="state-heading__mark"><CircleDashed size={22} aria-hidden="true" /></span><div><p className="data-label">SIMULATION STATUS</p><h2>Awaiting live result</h2><p className="muted">{model.routeParam === "preview" ? "No live simulation record is attached to this preview route." : "No live simulation record is attached to this route."}</p></div></div><div className="evidence-line"><span>Simulation reference</span><strong className="empty-dash">No live record</strong></div><div className="evidence-line"><span>Expected action</span><strong>Aave withdraw → Safe Wallet</strong></div><div className="evidence-line"><span>Revert reason</span><strong className="empty-dash">—</strong></div></section><section className="outline-panel route-card"><h2>Supported exit</h2><RouteDiagram active="Simulation pending" /><p className="form-note">A simulation-only result can never create a Rescue Receipt marked protected.</p></section></div>
      <div className="diagnostic-actions"><Link className="secondary-button" href="/confirm">Back to confirmation</Link><Link className="secondary-button" href="/monitor">Keep monitoring</Link></div>
    </div></main>
  );
}
