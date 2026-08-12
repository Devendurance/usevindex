"use client";

import { useCallback, useEffect, useState } from "react";
import { safeWalletError } from "@/lib/vindex/validation";

type ConfigResponse = {
  safeWallet: string | null;
  configured: boolean;
  chainId: number;
  executionWallet: string | null;
  configuredAt: string | null;
  updatedAt: string | null;
};

type SaveState =
  | { status: "idle" }
  | { status: "saving" }
  | { status: "saved"; config: ConfigResponse }
  | { status: "error"; message: string };

const formatWallet = (address: string): string =>
  address.length >= 12 ? `${address.slice(0, 6)}…${address.slice(-4)}` : address;

export function SetupForm({ settings = false }: { settings?: boolean }) {
  const [wallet, setWallet] = useState("");
  const [policy, setPolicy] = useState("STANDARD");
  const [monitoring, setMonitoring] = useState(false);
  const [touched, setTouched] = useState(false);
  const [config, setConfig] = useState<ConfigResponse | null>(null);
  const [configError, setConfigError] = useState<string | null>(null);
  const [save, setSave] = useState<SaveState>({ status: "idle" });

  const localError = touched ? safeWalletError(wallet) : null;
  const canSubmit = wallet.trim() !== "" && safeWalletError(wallet) === null && save.status !== "saving";

  useEffect(() => {
    let cancelled = false;
    fetch("/api/vindex/config", { cache: "no-store" })
      .then(async (response) => {
        const parsed = (await response.json().catch(() => null)) as ConfigResponse | null;
        if (cancelled) return;
        if (!response.ok || parsed === null) {
          setConfigError("Configuration is unavailable.");
          return;
        }
        setConfig(parsed);
        if (parsed.safeWallet !== null) setWallet(parsed.safeWallet);
        setConfigError(null);
      })
      .catch(() => {
        if (!cancelled) setConfigError("Configuration is unavailable.");
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const saveConfiguration = useCallback(
    async (event: React.FormEvent) => {
      event.preventDefault();
      if (!canSubmit) return;
      setSave({ status: "saving" });
      try {
        const response = await fetch("/api/vindex/config", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ safeWallet: wallet.trim() }),
          cache: "no-store",
        });
        const body = (await response.json().catch(() => null)) as ConfigResponse & { error?: string; message?: string } | null;
        if (!response.ok || body === null) {
          setSave({ status: "error", message: body?.message ?? "Saving the safe wallet failed." });
          return;
        }
        setConfig(body);
        setSave({ status: "saved", config: body });
        setTouched(false);
      } catch {
        setSave({ status: "error", message: "Saving the safe wallet failed." });
      }
    },
    [canSubmit, wallet],
  );

  return (
    <form className="setup-form" onSubmit={(event) => void saveConfiguration(event)} noValidate>
      <div className="form-row">
        <label htmlFor="position">Supported position</label>
        <input id="position" value="Aave V3 / Base Sepolia / USDC" readOnly />
      </div>
      <div className="form-row">
        <label htmlFor="execution-wallet">KeeperHub execution wallet</label>
        <div>
          <input
            id="execution-wallet"
            value={config?.executionWallet !== null && config !== null ? formatWallet(config.executionWallet) : "—"}
            readOnly
            aria-describedby="execution-wallet-help"
          />
          <p id="execution-wallet-help" className="form-help">
            Your Aave position is owned by the KeeperHub execution wallet. This wallet performs the supported rescue transactions.
          </p>
        </div>
      </div>
      <div className="form-row">
        <label htmlFor="safe-wallet">Safe wallet</label>
        <div>
          <input
            id="safe-wallet"
            value={wallet}
            onChange={(event) => {
              setWallet(event.target.value);
              setSave({ status: "idle" });
            }}
            onBlur={() => setTouched(true)}
            placeholder="Enter a valid EVM address"
            aria-invalid={Boolean(localError)}
            aria-describedby="safe-wallet-help safe-wallet-error"
          />
          <p id="safe-wallet-help" className="form-help">
            This separate address is where Vindex will send the supported asset during an evacuation. Your Aave position is owned by the KeeperHub execution wallet above — this is only the emergency destination.
          </p>
          {localError !== null && <p id="safe-wallet-error" className="form-error">{localError}</p>}
          {save.status === "error" && <p className="form-error">{save.message}</p>}
          {save.status === "saved" && (
            <p className="form-help">
              Saved at {save.config.updatedAt ?? "—"}. The safe wallet will be revalidated before any protection policy is armed.
            </p>
          )}
          {configError !== null && <p className="form-error">{configError}</p>}
        </div>
      </div>
      <div className="form-row">
        <label htmlFor="amount">Evacuation amount</label>
        <select id="amount" defaultValue="FULL_POSITION"><option value="FULL_POSITION">Full position</option></select>
      </div>
      <div className="form-row">
        <span className="form-label">Policy mode</span>
        <div className="choice-list">
          <label><input type="radio" name="policy" value="STANDARD" checked={policy === "STANDARD"} onChange={() => setPolicy("STANDARD")} /> Standard</label>
          <label><input type="radio" name="policy" value="DRILL_HIGH_SENSITIVITY" checked={policy === "DRILL_HIGH_SENSITIVITY"} onChange={() => setPolicy("DRILL_HIGH_SENSITIVITY")} /> Protection drill / high sensitivity</label>
        </div>
      </div>
      <div className="form-row">
        <span className="form-label">Monitoring</span>
        <label className="toggle-label">
          <input type="checkbox" checked={monitoring} onChange={() => setMonitoring((current) => !current)} />
          <span className="toggle" aria-hidden="true" /> {monitoring ? "Monitoring selected" : "Monitoring disabled"}
        </label>
      </div>
      <p className="form-note">{settings ? "Saving changes requires live revalidation of the supported route." : "Complete live validation before this position can be armed."}</p>
      <div className="form-actions">
        <button className="primary-cta" type="submit" disabled={!canSubmit}>
          {save.status === "saving" ? "Saving…" : "Save configuration"}
        </button>
        <button className="secondary-button" type="button" disabled>Arm position</button>
      </div>
    </form>
  );
}
