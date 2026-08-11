import Link from "next/link";
import { ArrowDown, ArrowRight } from "lucide-react";
import { MarketingShell } from "@/components/shell/marketing-shell";
import { ProofRow } from "@/components/vindex/proof-row";
import { ProtectedRoute } from "@/components/vindex/protected-route";
import { Receipt } from "@/components/vindex/receipt";

export default function LandingPage() {
  return (
    <MarketingShell>
      <main id="main-content">
        <section className="marketing-hero mesh-field">
          <div className="content-wrap marketing-hero__inner">
            <h1>DETECT THE THREAT.<br />EXECUTE THE ESCAPE.</h1>
            <div className="marketing-hero__route"><ProtectedRoute variant="hero" /></div>
            <p className="marketing-hero__copy">Vindex watches supported DeFi positions, confirms converging danger and routes a verified exit through KeeperHub.</p>
            <Link className="primary-cta marketing-hero__action" href="/setup">RUN A DRY RUN</Link>
            <ProofRow />
          </div>
          <Link className="down-indicator marketing-hero__down" href="#how-it-works" aria-label="Continue to how it works">
            <ArrowDown size={17} aria-hidden="true" />
          </Link>
        </section>

        <section className="landing-section" id="how-it-works">
          <div className="content-wrap landing-section--split">
            <div className="landing-section__copy">
              <p className="eyebrow section-kicker">THE PROTECTED ROUTE</p>
              <h2>From warning to a verified way out.</h2>
              <p>Vindex does not stop at a signal. It watches supported positions, confirms meaningful evidence, prepares the supported exit and leaves the destination result visible.</p>
              <Link className="text-button" href="/demo">See how the route works <ArrowRight size={16} aria-hidden="true" /></Link>
            </div>
            <div className="outline-panel route-card">
              <p className="data-label">WATCH → CONFIRM → EXIT → VERIFY</p>
              <ProtectedRoute />
              <p className="muted">One route. Separate evidence at every step. No claim of protection before verification.</p>
            </div>
          </div>
        </section>

        <section className="landing-section" id="evidence">
          <div className="content-wrap landing-section--split">
            <div className="landing-section__copy">
              <p className="eyebrow section-kicker">EVIDENCE, NOT A VAGUE ALERT</p>
              <h2>A warning is not protection until the funds have a way out.</h2>
              <p>The Rescue Receipt will organize the trigger, simulation, execution and safe-wallet verification in one record. Until live evidence exists, the interface stays explicit about what is missing.</p>
            </div>
            <Receipt />
          </div>
        </section>

        <section className="landing-section" id="for-treasuries">
          <div className="content-wrap">
            <div className="landing-section__copy">
              <p className="eyebrow section-kicker">SUPPORTED ROUTE</p>
              <h2>Protection that moves with clear limits.</h2>
              <p>Vindex’s first supported route is intentionally narrow: Base Sepolia, Aave V3, the Aave test asset and a configured safe wallet. KeeperHub is the execution layer; Vindex owns the protection policy and evidence language.</p>
            </div>
            <div className="scope-grid">
              {[['NETWORK', 'Base Sepolia'], ['PROTOCOL', 'Aave V3'], ['ASSET', 'USDC test asset'], ['DESTINATION', 'Safe wallet']].map(([label, value]) => <div className="scope-item" key={label}><span className="data-label">{label}</span><p>{value}</p></div>)}
            </div>
          </div>
        </section>

        <section className="landing-section">
          <div className="content-wrap landing-section--split">
            <div className="landing-section__copy"><p className="eyebrow section-kicker">START WITH THE ROUTE</p><h2>Your position has a way out.</h2><p>Begin with the supported configuration. Live validation and execution will arrive when the product layer is connected.</p></div>
            <div><Link className="primary-cta" href="/setup">RUN A DRY RUN <ArrowRight size={17} aria-hidden="true" /></Link></div>
          </div>
        </section>
      </main>
      <footer className="landing-footer">
        <div className="content-wrap landing-footer__inner"><span className="muted">Vindex — autonomous protection for supported DeFi positions.</span><div className="footer-links"><Link href="/demo">View demo</Link><Link href="/audit/preview">Audit trail</Link><span className="down-indicator" aria-label="Scroll down"><ArrowDown size={16} aria-hidden="true" /></span></div></div>
      </footer>
    </MarketingShell>
  );
}
