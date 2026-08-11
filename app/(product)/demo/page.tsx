import Link from "next/link";
import { ArrowRight } from "lucide-react";

const steps = [
  ["01", "WATCH", "Independent signals monitor the supported position while the system waits for meaningful evidence."],
  ["02", "CONFIRM", "Vindex does not evacuate on one unexplained anomaly. Evidence is re-checked before a route begins."],
  ["03", "EXIT", "A supported route is prepared through KeeperHub. In this preview, no execution is submitted."],
  ["04", "VERIFY", "A route is not protected until the configured safe wallet receives a verified result."],
];

export default function DemoPage() {
  return (
    <main id="main-content" className="route-page">
      <div className="content-wrap">
        <header className="route-page__heading"><p className="preview-label">SIMULATION ONLY</p><h1>See the protected route</h1><p>Detection is not the end state. This walkthrough shows how Vindex separates observation, confirmation, execution and proof without pretending that live data exists.</p></header>
        <div className="demo-sequence">{steps.map(([number, title, body]) => <section className="demo-step" key={title}><span className="demo-step__number">{number}</span><h2>{title}</h2><p>{body}</p></section>)}</div>
        <section className="landing-section landing-section--split"><div className="landing-section__copy"><p className="eyebrow section-kicker">KEEPERHUB</p><h2>The last mile stays visible.</h2><p>Vindex owns threat interpretation and exit policy. KeeperHub is the future execution layer for the supported route; no wallet or transaction is connected in this preview.</p></div><div className="outline-panel route-card"><p className="data-label">SUPPORTED ROUTE</p><h3>Position → Aave withdrawal → Safe wallet</h3><p className="muted">No direct-RPC fallback was attempted.</p><Link className="text-button" href="/setup">Open setup <ArrowRight size={16} aria-hidden="true" /></Link></div></section>
      </div>
    </main>
  );
}
