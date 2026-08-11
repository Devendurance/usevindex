"use client";

import { useState } from "react";
import { safeWalletError } from "@/lib/vindex/validation";

export function SetupForm({ settings = false }: { settings?: boolean }) {
  const [wallet, setWallet] = useState("");
  const [policy, setPolicy] = useState("STANDARD");
  const [monitoring, setMonitoring] = useState(false);
  const [touched, setTouched] = useState(false);
  const error = touched ? safeWalletError(wallet) : null;

  return (
    <form className="setup-form" onSubmit={(event) => event.preventDefault()} noValidate>
      <div className="form-row"><label htmlFor="position">Supported position</label><input id="position" value="Aave V3 / Base Sepolia / USDC" readOnly /></div>
      <div className="form-row">
        <label htmlFor="safe-wallet">Safe wallet</label>
        <div>
          <input id="safe-wallet" value={wallet} onChange={(event) => setWallet(event.target.value)} onBlur={() => setTouched(true)} placeholder="Enter a valid EVM address" aria-invalid={Boolean(error)} aria-describedby="safe-wallet-help safe-wallet-error" />
          <p id="safe-wallet-help" className="form-help">This is the destination Vindex will use for a supported evacuation. Check every character before continuing.</p>
          {error && <p id="safe-wallet-error" className="form-error">{error}</p>}
        </div>
      </div>
      <div className="form-row"><label htmlFor="amount">Evacuation amount</label><select id="amount" defaultValue="FULL_POSITION"><option value="FULL_POSITION">Full position</option></select></div>
      <div className="form-row"><span className="form-label">Policy mode</span><div className="choice-list"><label><input type="radio" name="policy" value="STANDARD" checked={policy === "STANDARD"} onChange={() => setPolicy("STANDARD")} /> Standard</label><label><input type="radio" name="policy" value="DRILL_HIGH_SENSITIVITY" checked={policy === "DRILL_HIGH_SENSITIVITY"} onChange={() => setPolicy("DRILL_HIGH_SENSITIVITY")} /> Protection drill / high sensitivity</label></div></div>
      <div className="form-row"><span className="form-label">Monitoring</span><label className="toggle-label"><input type="checkbox" checked={monitoring} onChange={() => setMonitoring((current) => !current)} /><span className="toggle" aria-hidden="true" /> {monitoring ? "Monitoring selected" : "Monitoring disabled"}</label></div>
      <p className="form-note">{settings ? "Saving changes requires live revalidation of the supported route." : "Complete live validation before this position can be armed."}</p>
      <div className="form-actions"><button className="primary-cta" type="submit" disabled>Save configuration</button><button className="secondary-button" type="button" disabled>Arm position</button></div>
    </form>
  );
}
