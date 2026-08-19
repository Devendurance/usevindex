import Image from "next/image";
import Link from "next/link";
import { ArrowDown, ArrowRight, MoveUpRight } from "lucide-react";
import { MarketingShell } from "@/components/shell/marketing-shell";
import { ProofRow } from "@/components/vindex/proof-row";
import { ProtectedRoute } from "@/components/vindex/protected-route";
import { Receipt } from "@/components/vindex/receipt";

export default function LandingPage() {
  return (
    <MarketingShell>
      <main id="main-content">
        <section className="marketing-hero">
          <Image
            className="marketing-hero__background"
            src="/images/vindex-exit-corridor.png"
            alt=""
            fill
            sizes="100vw"
            loading="eager"
            fetchPriority="high"
          />
          <div className="marketing-hero__veil" aria-hidden="true" />
          <div className="content-wrap marketing-hero__inner">
            <h1>Detect the threat.<br />Execute the escape.</h1>
            <p className="marketing-hero__copy">Vindex watches supported DeFi positions, confirms converging danger and routes a verified exit through KeeperHub.</p>
            <Link className="primary-cta marketing-hero__action" href="/setup">RUN A DRY RUN</Link>
            <ProofRow />
          </div>
          <Link className="down-indicator marketing-hero__down" href="#how-it-works" aria-label="Continue to how it works">
            <ArrowDown size={17} aria-hidden="true" />
          </Link>
        </section>

        <section className="landing-section scroll-reveal" id="how-it-works" data-scroll-reveal="true">
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

        <section className="landing-section scroll-reveal" id="evidence" data-scroll-reveal="true">
          <div className="content-wrap landing-section--split">
            <div className="landing-section__copy">
              <p className="eyebrow section-kicker">EVIDENCE, NOT A VAGUE ALERT</p>
              <h2>A warning is not protection until the funds have a way out.</h2>
              <p>The Rescue Receipt will organize the trigger, simulation, execution and safe-wallet verification in one record. Until live evidence exists, the interface stays explicit about what is missing.</p>
            </div>
            <Receipt />
          </div>
        </section>

        <section className="landing-section scroll-reveal" id="for-treasuries" data-scroll-reveal="true">
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

        <section className="landing-section scroll-reveal" data-scroll-reveal="true">
          <div className="content-wrap landing-section--split">
            <div className="landing-section__copy"><p className="eyebrow section-kicker">START WITH THE ROUTE</p><h2>Your position has a way out.</h2><p>Begin with the supported configuration. Live validation and execution will arrive when the product layer is connected.</p></div>
            <div><Link className="primary-cta" href="/setup">RUN A DRY RUN <ArrowRight size={17} aria-hidden="true" /></Link></div>
          </div>
        </section>
      </main>
      <footer className="landing-footer scroll-reveal" data-scroll-reveal="true">
        <div className="landing-footer__surface">
          <div className="content-wrap landing-footer__grid">
            <div className="landing-footer__statement">
              <p className="eyebrow">AUTONOMOUS PROTECTION</p>
              <h2>Every supported position deserves a verified way out.</h2>
              <p>Vindex watches the route from converging threat signals to KeeperHub execution and safe-wallet proof.</p>
            </div>
            <nav className="landing-footer__nav" aria-label="Footer navigation">
              <p className="data-label">NAVIGATION</p>
              <Link href="/#how-it-works">How it works</Link>
              <Link href="/#for-treasuries">For treasuries</Link>
              <Link href="/demo">View demo</Link>
              <Link href="/audit/preview">Audit trail</Link>
            </nav>
            <div className="landing-footer__socials">
              <p className="data-label">SOCIAL</p>
              <a href="https://github.com/Devendurance/usevindex" target="_blank" rel="noreferrer">GitHub <MoveUpRight size={16} aria-hidden="true" /></a>
              <a href="https://x.com/devendyyy" target="_blank" rel="noreferrer">X <MoveUpRight size={16} aria-hidden="true" /></a>
            </div>
            <div className="landing-footer__brand" aria-hidden="true">
              <span>VINDEX</span>
              <strong>Protection that moves.</strong>
            </div>
          </div>
        </div>
        <div className="landing-footer__rail">
          <div className="content-wrap landing-footer__rail-inner">
            <span>© 2026 Vindex. All rights reserved.</span>
            <span>WATCH → CONFIRM → EXIT → VERIFY</span>
          </div>
        </div>
      </footer>
    </MarketingShell>
  );
}
