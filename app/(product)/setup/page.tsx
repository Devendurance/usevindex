import { SetupForm } from "@/components/forms/setup-form";
import { RouteDiagram } from "@/components/vindex/route-diagram";

export default function SetupPage() {
  return (
    <main id="main-content" className="route-page">
      <div className="content-wrap">
        <header className="route-page__heading"><h1>Set your protected route</h1><p>Choose what Vindex should watch, where protected funds should go and how much evidence is required before an exit can begin.</p></header>
        <div className="setup-layout">
          <SetupForm />
          <section className="setup-route-preview">
            <h2>Your protected route</h2>
            <div className="setup-route-preview__sequence">{["WATCH", "CONFIRM", "EXIT", "VERIFY"].map((step, index) => <div key={step}><span>0{index + 1}</span><p>{step}</p></div>)}</div>
            <div className="not-armed"><span className="state-heading__mark">—</span><strong>Not armed</strong><p className="muted">Complete the configuration to arm this position.</p></div>
            <RouteDiagram />
          </section>
        </div>
        <section className="outline-panel monitor-lower"><h2>Monitoring preview</h2><div className="route-grid-3"><div className="route-card"><p className="data-label">POSITION</p><h3>Awaiting live position data</h3><p>Once available, the current position details will appear here.</p></div><div className="route-card"><p className="data-label">SIGNALS</p><h3>Awaiting signal observations</h3><p>Signals will appear with their live provenance.</p></div><div className="route-card"><p className="data-label">EXECUTION</p><h3>Awaiting execution status</h3><p>Exit progress will appear here when a supported route exists.</p></div></div></section>
      </div>
    </main>
  );
}
