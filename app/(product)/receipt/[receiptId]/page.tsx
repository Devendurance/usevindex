import Link from "next/link";
import { Receipt } from "@/components/vindex/receipt";
import { AuditTimeline } from "@/components/vindex/audit-timeline";
import { normalizeRouteParam } from "@/lib/vindex/route-params";

export default async function ReceiptPage({ params }: { params: Promise<{ receiptId: string }> }) {
  const { receiptId } = await params;
  normalizeRouteParam(receiptId);
  return (
    <main id="main-content" className="route-page"><div className="content-wrap">
      <header className="route-page__heading"><p className="preview-label">SIMULATION ONLY</p><h1>Rescue Receipt</h1><p>The configured safe wallet can only be called protected after a verified result. This preview contains no live record.</p></header>
      <div className="route-grid-2"><Receipt /><AuditTimeline /></div>
      <div className="diagnostic-actions"><Link className="secondary-button" href="/monitor">Back to monitor</Link><Link className="secondary-button" href="/audit/preview">View full record</Link></div>
    </div></main>
  );
}
