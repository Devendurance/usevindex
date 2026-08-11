import { SetupForm } from "@/components/forms/setup-form";

export default function SettingsPage() {
  return (
    <main id="main-content" className="route-page">
      <div className="content-wrap">
        <header className="route-page__heading"><h1>Route settings</h1><p>Review the supported position, safe wallet and policy before revalidation. Changing an armed route requires live checks again.</p></header>
        <div className="setup-layout">
          <SetupForm settings />
          <section className="outline-panel route-card"><p className="eyebrow section-kicker">CURRENT CONFIGURATION</p><h2>Revalidation required</h2><p>Configuration values are not loaded in this UI preview. The safe wallet and protected position will appear after a future server connection.</p><div className="evidence-line"><span>Execution wallet</span><strong className="empty-dash">—</strong></div><div className="evidence-line"><span>Monitoring</span><strong>Disabled</strong></div><div className="evidence-line"><span>Policy</span><strong>Standard</strong></div></section>
        </div>
      </div>
    </main>
  );
}
