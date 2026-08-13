import Link from "next/link";
import { ArrowRight } from "lucide-react";
import { DemoRunSurface } from "@/components/dashboard/demo-run-surface";

export default function DemoPage() {
  return (
    <main id="main-content" className="route-page">
      <div className="content-wrap">
        <header className="route-page__heading"><p className="preview-label">LIVE DEMO</p><h1>See the protected route</h1><p>Detection is not the end state. This demo prepares a real test position on Base Sepolia, arms protection, runs a drill with real signal evidence and a KeeperHub-executed exit, then verifies the destination and issues a Rescue Receipt.</p></header>
        <DemoRunSurface />
        <section className="landing-section landing-section--split"><div className="landing-section__copy"><p className="eyebrow section-kicker">KEEPERHUB</p><h2>The last mile stays visible.</h2><p>Vindex owns threat interpretation and exit policy. KeeperHub is the execution layer for the supported route; every withdrawal in this demo is a real, verifiable Base Sepolia transaction.</p></div><div className="outline-panel route-card"><p className="data-label">SUPPORTED ROUTE</p><h3>Position → Aave withdrawal → Safe wallet</h3><p className="muted">No direct-RPC fallback is ever attempted.</p><Link className="text-button" href="/setup">Open setup <ArrowRight size={16} aria-hidden="true" /></Link></div></section>
      </div>
    </main>
  );
}
