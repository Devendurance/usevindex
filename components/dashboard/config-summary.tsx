"use client";

import { useEffect, useState } from "react";

type ConfigResponse = {
  safeWallet: string | null;
  configured: boolean;
  chainId: number;
  executionWallet: string | null;
  configuredAt: string | null;
  updatedAt: string | null;
};

const formatWallet = (address: string): string =>
  address.length >= 12 ? `${address.slice(0, 6)}…${address.slice(-4)}` : address;

export function ConfigSummary() {
  const [config, setConfig] = useState<ConfigResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/vindex/config", { cache: "no-store" })
      .then(async (response) => {
        const body = (await response.json().catch(() => null)) as ConfigResponse | null;
        if (!response.ok || body === null) {
          if (!cancelled) setError("Configuration is unavailable.");
          return;
        }
        if (!cancelled) setConfig(body);
      })
      .catch(() => {
        if (!cancelled) setError("Configuration is unavailable.");
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (error !== null) {
    return (
      <section className="outline-panel route-card">
        <p className="eyebrow section-kicker">CURRENT CONFIGURATION</p>
        <h2>Unavailable</h2>
        <p className="muted">{error}</p>
      </section>
    );
  }

  return (
    <section className="outline-panel route-card">
      <p className="eyebrow section-kicker">CURRENT CONFIGURATION</p>
      <h2>{config?.configured === true ? "Configured" : "Not configured"}</h2>
      <div className="evidence-line">
        <span>Execution wallet</span>
        <strong className={config?.executionWallet ? "" : "empty-dash"}>
          {config?.executionWallet ? formatWallet(config.executionWallet) : "—"}
        </strong>
      </div>
      <div className="evidence-line">
        <span>Safe wallet</span>
        <strong className={config?.safeWallet ? "" : "empty-dash"}>
          {config?.safeWallet ? formatWallet(config.safeWallet) : "Not configured"}
        </strong>
      </div>
      <div className="evidence-line">
        <span>Updated at</span>
        <strong className={config?.updatedAt ? "" : "empty-dash"}>{config?.updatedAt ?? "—"}</strong>
      </div>
      <div className="evidence-line">
        <span>Network</span>
        <strong>Base Sepolia</strong>
      </div>
      <p className="form-note">Changing the safe wallet is allowed while no protection policy is armed.</p>
    </section>
  );
}
