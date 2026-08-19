"use client";

import { useCallback, useEffect, useState } from "react";

type TelegramStatus = {
  connected: boolean;
  telegramUsername: string | null;
  chatMasked: string | null;
  riskAlertsEnabled: boolean;
  withdrawalAlertsEnabled: boolean;
  lastDelivery: { eventType: string; status: string; errorCode: string | null; attemptedAt: string } | null;
};

export const telegramConnectionCopy = (
  status: TelegramStatus | null,
): { heading: string; blurb: string; connected: boolean } => {
  if (status === null) {
    return { heading: "Telegram Alerts", blurb: "Loading connection status…", connected: false };
  }
  if (!status.connected) {
    return { heading: "Telegram Alerts", blurb: "Receive risk and verified-withdrawal alerts.", connected: false };
  }
  const who = status.telegramUsername !== null ? `@${status.telegramUsername}` : (status.chatMasked ?? "Telegram");
  return { heading: "Telegram Alerts", blurb: `Connected as ${who}.`, connected: true };
};

type LoadState =
  | { status: "loading" }
  | { status: "ready"; statusView: TelegramStatus | null }
  | { status: "error"; message: string };

const fetchStatus = async (): Promise<TelegramStatus | null> => {
  const response = await fetch("/api/vindex/telegram", { cache: "no-store" });
  if (!response.ok) return null;
  return (await response.json()) as TelegramStatus;
};

export function TelegramSettings() {
  const [load, setLoad] = useState<LoadState>({ status: "loading" });
  const [connecting, setConnecting] = useState(false);
  const [testing, setTesting] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    // Follows the repo pattern (setup-form/config-summary): fetch in the
    // effect with a cancelled guard so a late response cannot set state on an
    // unmounted component. The plain `void loadStatus()` call trips the
    // react-hooks set-state-in-effect rule, so the fetch is inlined here.
    let cancelled = false;
    fetchStatus()
      .then((statusView) => {
        if (!cancelled) setLoad({ status: "ready", statusView });
      })
      .catch(() => {
        if (!cancelled) setLoad({ status: "error", message: "Telegram connection status is unavailable." });
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const copy = telegramConnectionCopy(load.status === "ready" ? load.statusView : null);

  const connect = useCallback(async () => {
    setConnecting(true);
    setNotice(null);
    try {
      const response = await fetch("/api/vindex/telegram/connect", { method: "POST", cache: "no-store" });
      const body = (await response.json().catch(() => null)) as { connectUrl?: string; message?: string } | null;
      if (!response.ok || body?.connectUrl === undefined) {
        setNotice(body?.message ?? "Connection could not be started.");
        return;
      }
      window.open(body.connectUrl, "_blank", "noopener,noreferrer");
      setNotice("Open the opened Telegram chat and press Start. If it didn't open, press Start in your Vindex Alerts bot chat directly.");
      const startedAt = Date.now();
      const poll = setInterval(async () => {
        const statusView = await fetchStatus();
        if (statusView !== null && statusView.connected) {
          clearInterval(poll);
          setLoad({ status: "ready", statusView });
          setNotice("Connected.");
        } else if (Date.now() - startedAt > 90_000) {
          clearInterval(poll);
        }
      }, 3_000);
    } catch {
      setNotice("Connection could not be started.");
    } finally {
      setConnecting(false);
    }
  }, []);

  const setToggle = useCallback(async (key: "riskAlertsEnabled" | "withdrawalAlertsEnabled", value: boolean) => {
    setNotice(null);
    try {
      const response = await fetch("/api/vindex/telegram", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ [key]: value }),
        cache: "no-store",
      });
      const body = (await response.json().catch(() => null)) as TelegramStatus | null;
      if (response.ok && body !== null) {
        setLoad({ status: "ready", statusView: body });
      } else {
        setNotice("The alert preference could not be saved.");
      }
    } catch {
      setNotice("The alert preference could not be saved.");
    }
  }, []);

  const sendTest = useCallback(async () => {
    setTesting(true);
    setNotice(null);
    try {
      const response = await fetch("/api/vindex/telegram/test", { method: "POST", cache: "no-store" });
      const body = (await response.json().catch(() => null)) as { outcome?: { delivered?: boolean }; message?: string } | null;
      if (response.ok && body?.outcome?.delivered === true) {
        setNotice("Test alert sent.");
      } else {
        setNotice(body?.message ?? "The test alert could not be sent.");
      }
    } catch {
      setNotice("The test alert could not be sent.");
    } finally {
      setTesting(false);
    }
  }, []);

  const disconnect = useCallback(async () => {
    setNotice(null);
    try {
      const response = await fetch("/api/vindex/telegram", { method: "DELETE", cache: "no-store" });
      if (response.ok) {
        setLoad({ status: "ready", statusView: { connected: false, telegramUsername: null, chatMasked: null, riskAlertsEnabled: true, withdrawalAlertsEnabled: true, lastDelivery: null } });
        setNotice("Telegram disconnected.");
      } else {
        setNotice("Disconnect failed.");
      }
    } catch {
      setNotice("Disconnect failed.");
    }
  }, []);

  const connected = load.status === "ready" && load.statusView !== null && load.statusView.connected;
  const statusView = load.status === "ready" ? load.statusView : null;

  return (
    <section className="telegram-settings" aria-labelledby="telegram-settings-heading">
      <p className="data-label" id="telegram-settings-heading">{copy.heading}</p>
      <h3>{copy.blurb}</h3>
      {load.status === "error" && <p className="form-error">{load.message}</p>}
      {load.status === "ready" && !connected && (
        <div className="diagnostic-actions">
          <button className="primary-cta" type="button" onClick={() => void connect()} disabled={connecting}>
            {connecting ? "Preparing connection…" : "Connect Telegram"}
          </button>
        </div>
      )}
      {load.status === "ready" && connected && (
        <>
          <div className="form-row">
            <span className="form-label">Risk alerts</span>
            <label className="toggle-label">
              <input
                type="checkbox"
                checked={statusView?.riskAlertsEnabled ?? true}
                onChange={(event) => void setToggle("riskAlertsEnabled", event.target.checked)}
              />
              <span className="toggle" aria-hidden="true" />
              {statusView?.riskAlertsEnabled ? "On" : "Off"}
            </label>
          </div>
          <div className="form-row">
            <span className="form-label">Withdrawal alerts</span>
            <label className="toggle-label">
              <input
                type="checkbox"
                checked={statusView?.withdrawalAlertsEnabled ?? true}
                onChange={(event) => void setToggle("withdrawalAlertsEnabled", event.target.checked)}
              />
              <span className="toggle" aria-hidden="true" />
              {statusView?.withdrawalAlertsEnabled ? "On" : "Off"}
            </label>
          </div>
          {statusView?.lastDelivery !== null && statusView?.lastDelivery !== undefined && (
            <p className="form-note">
              Last delivery: {statusView.lastDelivery.eventType} · {statusView.lastDelivery.status}
              {statusView.lastDelivery.errorCode !== null ? ` · ${statusView.lastDelivery.errorCode}` : ""}
            </p>
          )}
          <div className="diagnostic-actions">
            <button className="secondary-button" type="button" onClick={() => void sendTest()} disabled={testing}>
              {testing ? "Sending…" : "Send test alert"}
            </button>
            <button className="secondary-button" type="button" onClick={() => void disconnect()}>
              Disconnect
            </button>
          </div>
        </>
      )}
      {notice !== null && <p className="form-note">{notice}</p>}
    </section>
  );
}
