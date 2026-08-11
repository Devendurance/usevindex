import Link from "next/link";
import { AuditTimeline } from "@/components/vindex/audit-timeline";
import { normalizeRouteParam } from "@/lib/vindex/route-params";

export default async function AuditPage({ params }: { params: Promise<{ positionId: string }> }) {
  const { positionId } = await params;
  normalizeRouteParam(positionId);
  return (
    <main id="main-content" className="route-page"><div className="content-wrap">
      <header className="route-page__heading"><p className="eyebrow section-kicker">AUDIT TRAIL</p><h1>Full record</h1><p>Every decision and execution step will become a record the user can inspect. This preview is waiting for persisted evidence.</p></header>
      <AuditTimeline />
      <div className="diagnostic-actions"><Link className="secondary-button" href="/monitor">Back to monitor</Link><Link className="secondary-button" href="/receipt/preview">View Rescue Receipt</Link></div>
    </div></main>
  );
}
