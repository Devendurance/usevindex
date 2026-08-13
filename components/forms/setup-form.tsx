"use client";

import Link from "next/link";
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

type ArmState =
  | { status: "idle" }
  | { status: "arming" }
  | { status: "armed" }
  | { status: "error"; message: string };

type DisarmState =
  | { status: "idle" }
  | { status: "disarming" }
  | { status: "error"; message: string };

// Mirror of GET /api/vindex/demo/status (DemoLifecycleStatusView). Only the
// fields rendered by this component are typed; unknown server fields are
// ignored so the summary can never claim more than the API actually reports.
type DemoStatusResponse = {
  positionId: string | null;
  lastProtectionEvent: {
    status: "PROTECTED";
    receiptId: string;
    executionId: string;
    txHash: string | null;
    keeperhubExecutionId: string | null;
    verifiedAmount: string | null;
    safeWallet: string | null;
    destination: string | null;
    completedAt: string | null;
  } | null;
  currentPosition: {
    exists: boolean;
    positionAmountBaseUnits: string;
    underlyingWalletBalance: string;
    live: boolean;
    observedAt: string | null;
  };
  protection: {
    armed: boolean;
    mode: string | null;
    policyId: string | null;
    armedAt: string | null;
  };
  validation: {
    readyToPrepare: boolean;
    readyToArm: boolean;
    readyToRunDrill: boolean;
    reasons: string[];
    inFlightJob: "PREPARING" | "DRILLING" | null;
  };
};

// Mirror of POST /api/vindex/positions/arm (PolicyView).
type ArmResponse = {
  id: string;
  positionId: string;
  mode: string;
  version: number;
  requiredSignals: number;
  correlationWindowSec: number;
  safeWalletSnapshot: string;
  isArmed: boolean;
  armedAt: string | null;
  disarmedAt: string | null;
};

const formatWallet = (address: string): string =>
  address.length >= 12 ? `${address.slice(0, 6)}…${address.slice(-4)}` : address;

// USDC has 6 decimals; plain string formatting keeps the summary exact
// without inventing shared helpers (e.g. "5000017" -> "5.000017").
const formatPositionAmount = (baseUnits: string): string =>
  (Number(baseUnits) / 1_000_000).toFixed(6);

export function SetupForm({ settings = false }: { settings?: boolean }) {
  const [wallet, setWallet] = useState("");
  const [policy, setPolicy] = useState("STANDARD");
  const [monitoring, setMonitoring] = useState(false);
  const [touched, setTouched] = useState(false);
  const [config, setConfig] = useState<ConfigResponse | null>(null);
  const [configError, setConfigError] = useState<string | null>(null);
  const [save, setSave] = useState<SaveState>({ status: "idle" });
  const [status, setStatus] = useState<DemoStatusResponse | null>(null);
  const [statusError, setStatusError] = useState<string | null>(null);
  const [arm, setArm] = useState<ArmState>({ status: "idle" });
  const [disarm, setDisarm] = useState<DisarmState>({ status: "idle" });
  // Set from the arm response so the summary never flashes "NOT ARMED" while
  // the re-fetched status still reports the pre-arm state.
  const [armConfirmation, setArmConfirmation] = useState<{ mode: string } | null>(null);

  const localError = touched ? safeWalletError(wallet) : null;
  const canSubmit = wallet.trim() !== "" && safeWalletError(wallet) === null && save.status !== "saving";

  const readStatus = useCallback(async (): Promise<DemoStatusResponse | null> => {
    try {
      const response = await fetch("/api/vindex/demo/status", { cache: "no-store" });
      const parsed = (await response.json().catch(() => null)) as DemoStatusResponse | null;
      return response.ok && parsed !== null ? parsed : null;
    } catch {
      return null;
    }
  }, []);

  const refreshStatus = useCallback(async () => {
    const parsed = await readStatus();
    if (parsed === null) {
      setStatusError("Live protection state is unavailable.");
      return;
    }
    setStatus(parsed);
    setStatusError(null);
  }, [readStatus]);

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
    void readStatus().then((parsed) => {
      if (cancelled) return;
      if (parsed === null) {
        setStatusError("Live protection state is unavailable.");
        return;
      }
      setStatus(parsed);
      setStatusError(null);
    });
    return () => {
      cancelled = true;
    };
  }, [readStatus]);

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
        // The configured safe wallet gates arming; refresh the authoritative view.
        void refreshStatus();
      } catch {
        setSave({ status: "error", message: "Saving the safe wallet failed." });
      }
    },
    [canSubmit, refreshStatus, wallet],
  );

  const armPosition = useCallback(async () => {
    if (arm.status === "arming") return;
    setArm({ status: "arming" });
    setDisarm({ status: "idle" });
    try {
      const response = await fetch("/api/vindex/positions/arm", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mode: policy }),
        cache: "no-store",
      });
      const body = (await response.json().catch(() => null)) as (ArmResponse & { message?: string }) | null;
      if (!response.ok || body === null) {
        setArm({ status: "error", message: body?.message ?? "Arming the position failed." });
        return;
      }
      setArmConfirmation({ mode: body.mode });
      setArm({ status: "armed" });
      void refreshStatus();
    } catch {
      setArm({ status: "error", message: "Arming the position failed." });
    }
  }, [arm.status, refreshStatus, policy]);

  const disarmPosition = useCallback(async () => {
    if (disarm.status === "disarming") return;
    setDisarm({ status: "disarming" });
    setArm({ status: "idle" });
    try {
      const response = await fetch("/api/vindex/positions/disarm", {
        method: "POST",
        cache: "no-store",
      });
      const body = (await response.json().catch(() => null)) as { message?: string } | null;
      if (!response.ok) {
        setDisarm({ status: "error", message: body?.message ?? "Disarming the position failed." });
        return;
      }
      setArmConfirmation(null);
      setDisarm({ status: "idle" });
      void refreshStatus();
    } catch {
      setDisarm({ status: "error", message: "Disarming the position failed." });
    }
  }, [disarm.status, refreshStatus]);

  const canArm = status?.validation.readyToArm === true && arm.status === "idle" && status.protection.armed === false;
  const blockingReason = status !== null && !status.validation.readyToArm ? (status.validation.reasons[0] ?? null) : null;

  // Summary values derive strictly from the API view: "NOT ARMED" is only ever
  // claimed when protection.armed is false (and no fresh arm confirmation is
  // pending), and a protection event is only claimed when lastProtectionEvent
  // carries a PROTECTED status with a receipt id.
  const protectionEvent = status?.lastProtectionEvent ?? null;
  const showProtectionEvent =
    protectionEvent !== null && protectionEvent.status === "PROTECTED" && protectionEvent.receiptId !== "";

  const positionLabel =
    status === null ? "—" : status.currentPosition.exists ? `${formatPositionAmount(status.currentPosition.positionAmountBaseUnits)} USDC` : "NONE / 0";

  const justArmed = armConfirmation !== null;
  const statusArmed = status?.protection.armed === true;
  const armedMode = statusArmed && status.protection.mode !== null ? status.protection.mode : (armConfirmation?.mode ?? null);
  let protectionLabel = "—";
  if (statusArmed || justArmed) {
    protectionLabel = `ARMED — ${armedMode ?? "UNKNOWN"}${justArmed ? ", WATCHING" : ""}`;
  } else if (status !== null) {
    protectionLabel = "NOT ARMED";
  }

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
      <section className="outline-panel setup-state-summary" aria-label="Live protection state">
        <div className="evidence-line">
          <span className="data-label">Last protection event</span>
          <strong>
            {showProtectionEvent ? (
              <Link className="text-button" href={`/receipt/${protectionEvent.receiptId}`}>PROTECTED</Link>
            ) : (
              "NONE"
            )}
          </strong>
        </div>
        <div className="evidence-line">
          <span className="data-label">Current position</span>
          <strong>{positionLabel}</strong>
        </div>
        <div className="evidence-line">
          <span className="data-label">Current protection</span>
          <strong>{protectionLabel}</strong>
        </div>
      </section>
      {statusError !== null && <p className="form-help">{statusError}</p>}
      <p className="form-note">{settings ? "Saving changes requires live revalidation of the supported route." : "Complete live validation before this position can be armed."}</p>
      <div className="form-actions">
        <button className="primary-cta" type="submit" disabled={!canSubmit}>
          {save.status === "saving" ? "Saving…" : "Save configuration"}
        </button>
        {status?.protection.armed === true ? (
          <button className="secondary-button" type="button" onClick={() => void disarmPosition()} disabled={disarm.status === "disarming"}>
            {disarm.status === "disarming" ? "Disarming…" : "Disarm"}
          </button>
        ) : (
          <button className="secondary-button" type="button" onClick={() => void armPosition()} disabled={!canArm}>
            {arm.status === "arming" ? "Arming…" : "Arm position"}
          </button>
        )}
      </div>
      {blockingReason !== null && <p className="form-help">{blockingReason}</p>}
      {arm.status === "error" && <p className="form-error">{arm.message}</p>}
      {disarm.status === "error" && <p className="form-error">{disarm.message}</p>}
    </form>
  );
}
