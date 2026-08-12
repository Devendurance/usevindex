"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { Activity, RefreshCw } from "lucide-react";
import type { PositionSnapshotModel } from "@/lib/vindex/position-service";

const POLL_INTERVAL_MS = 30_000;

type LoadState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; model: PositionSnapshotModel };

const statusLabel = (model: PositionSnapshotModel): string => {
  const { readiness } = model;
  if (readiness.readyForMonitoring) return "READY FOR MONITORING";
  if (readiness.positionExists) {
    return readiness.safeWalletConfigured ? "POSITION VERIFIED" : "SAFE WALLET REQUIRED";
  }
  if (readiness.executionWalletValid) return "SETUP REQUIRED";
  return "UNAVAILABLE";
};

const statusCopy = (model: PositionSnapshotModel): string => {
  const { readiness } = model;
  if (readiness.readyForMonitoring) {
    return "The protected position and safe wallet are configured. Live signal evaluation is not yet active.";
  }
  if (readiness.positionExists && !readiness.safeWalletConfigured) {
    return "The live Aave position is verified. Configure a safe wallet to continue.";
  }
  if (!readiness.positionExists) {
    return "No current protected position found on the execution wallet.";
  }
  return "The protected route is not ready for monitoring yet.";
};

const formatWallet = (address: string): string =>
  address.length >= 12 ? `${address.slice(0, 6)}…${address.slice(-4)}` : address;

type LatestSignalsResponse = {
  freshness: "LIVE" | "STALE" | "UNAVAILABLE";
  latest: Array<{
    sourceFamily: string;
    metric: string;
    rawValue: string;
    normalizedValue: string;
    contractAddress: string;
    blockNumber: string;
    blockTimestamp: string | null;
    observedAt: string;
    metadata: { formatted?: string; label?: string; owner?: string };
  }>;
};

const FAMILY_METRIC_LABEL: Record<string, string> = {
  ORACLE_PRICE_STATE: "Oracle price state",
  AAVE_RESERVE_STATE: "Aave reserve state",
  POSITION_STATE: "Position state",
};

type DecisionView = {
  positionId: string;
  state: "DRAFT" | "WATCHING" | "ELEVATED" | "CONFIRMING";
  policy: {
    id: string;
    mode: string;
    version: number;
    requiredSignals: number;
    correlationWindowSec: number;
    safeWalletSnapshot: string;
    isArmed: boolean;
  } | null;
  matchedFamilies: Array<{
    family: string;
    matched: boolean;
    reason: string;
    observationIds: string[];
    values: Record<string, string>;
  }>;
  matchedCount: number;
  decisionId: string | null;
  windowStartedAt: string | null;
  confirmedAt: string | null;
  expiresAt: string | null;
  readyForSimulation: boolean;
  lastEvaluatedAt: string;
  drill: boolean;
  drillLabel: string | null;
  drillExplanation: string | null;
  reRead: { outcome: string; blockNumber: string; reason: string | null } | null;
};

type ExecutionResult = {
  outcome: string;
  executionId: string;
  decisionId: string;
  keeperhubExecutionId: string | null;
  status: string | null;
  transactionHash: string | null;
  transactionLink: string | null;
  sponsored: boolean | null;
  actualWithdrawAmount: string | null;
  prePositionAmount: string | null;
  postPositionAmount: string | null;
  blockNumber: string | null;
  errorCode: string | null;
  readyForDestinationVerification: boolean;
};

type ExecutionPreparation = {
  executionId: string;
  decisionId: string;
  simulationId: string | null;
  state: string;
  target: string;
  asset: string;
  amountMode: string;
  amountBaseUnits: string;
  safeWallet: string;
  gasEstimate: string | null;
  expectedWithdrawAmount: string | null;
  blockNumber: string | null;
  blockTimestamp: string | null;
  simulatedAt: string | null;
  parametersHash: string;
  readyForExecution: boolean;
  errorCode: string | null;
};

type RescueReceiptMeta = {
  id: string;
  status: string;
  verifiedAmount: string;
  destination: string;
};

export function MonitorDashboard() {
  const [state, setState] = useState<LoadState>({ status: "loading" });
  const [signals, setSignals] = useState<LatestSignalsResponse | null>(null);
  const [decision, setDecision] = useState<DecisionView | null>(null);
  const [preparation, setPreparation] = useState<ExecutionPreparation | null>(null);
  const [execution, setExecution] = useState<ExecutionResult | null>(null);
  const [receipt, setReceipt] = useState<RescueReceiptMeta | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [clientError, setClientError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (refreshing) return;
    setRefreshing(true);
    setClientError(null);
    try {
      const response = await fetch("/api/vindex/positions/refresh", {
        method: "POST",
        cache: "no-store",
      });
      const body = await response.json().catch(() => null);
      if (!response.ok) {
        setClientError(body?.message ?? "Refresh failed.");
        return;
      }
      setState({ status: "ready", model: body as PositionSnapshotModel });
    } catch {
      setClientError("Refresh failed.");
    } finally {
      setRefreshing(false);
    }
  }, [refreshing]);

  useEffect(() => {
    let cancelled = false;
    // Closure-local in-flight guard: the polling interval and the effect share
    // it, but a StrictMode remount gets a fresh one, so a dev double-mount
    // never leaves the loader blocked.
    let inFlight = false;
    const request = (): void => {
      if (inFlight) return;
      inFlight = true;
      fetch("/api/vindex/positions/current", { cache: "no-store" })
        .then(async (response) => {
          if (!response.ok) {
            const body = await response.json().catch(() => null);
            return {
              ok: false as const,
              message: (body as { message?: string } | null)?.message ?? "Position data is unavailable right now.",
            };
          }
          return { ok: true as const, model: (await response.json()) as PositionSnapshotModel };
        })
        .then((result) => {
          if (cancelled) return;
          if (result.ok) setState({ status: "ready", model: result.model });
          else setState({ status: "error", message: result.message });
        })
        .catch(() => {
          if (!cancelled) {
            setState({ status: "error", message: "Position data is unavailable right now." });
          }
        })
        .finally(() => {
          inFlight = false;
        });
    };
    request();
    const interval = setInterval(() => {
      if (!document.hidden) request();
    }, POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, []);

  // Signal evidence loader (same polling cadence, read-only).
  useEffect(() => {
    let cancelled = false;
    const loadSignals = (): void => {
      fetch("/api/vindex/signals/latest", { cache: "no-store" })
        .then(async (response) => {
          if (!response.ok) return null;
          return (await response.json()) as LatestSignalsResponse;
        })
        .then((result) => {
          if (!cancelled && result !== null) setSignals(result);
        })
        .catch(() => {
          // keep last known signals; the section renders its own unavailable state
        });
    };
    loadSignals();
    const interval = setInterval(() => {
      if (!document.hidden) loadSignals();
    }, POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, []);

  // Prepared-execution loader (same polling cadence, read-only).
  useEffect(() => {
    let cancelled = false;
    const loadPreparation = (): void => {
      fetch("/api/vindex/executions/prepared", { cache: "no-store" })
        .then(async (response) => {
          if (!response.ok) return null;
          const body = (await response.json()) as {
            preparation: ExecutionPreparation | null;
            execution: ExecutionResult | null;
          };
          return body;
        })
        .then((result) => {
          if (cancelled || result === null) return;
          setPreparation(result.preparation);
          if (result.execution !== undefined && result.execution !== null) setExecution(result.execution);
        })
        .catch(() => {
          // keep last known values
        });
    };
    loadPreparation();
    const interval = setInterval(() => {
      if (!document.hidden) loadPreparation();
    }, POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, []);

  // Rescue receipt loader (same polling cadence, read-only).
  useEffect(() => {
    let cancelled = false;
    const loadReceipt = (): void => {
      fetch("/api/vindex/receipts/current", { cache: "no-store" })
        .then(async (response) => {
          if (!response.ok) return null;
          const body = (await response.json()) as { receipt: RescueReceiptMeta | null };
          return body.receipt;
        })
        .then((result) => {
          if (!cancelled && result !== null) setReceipt(result);
        })
        .catch(() => {
          // keep last known receipt
        });
    };
    loadReceipt();
    const interval = setInterval(() => {
      if (!document.hidden) loadReceipt();
    }, POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, []);

  // Protection decision loader (same polling cadence, read-only).
  useEffect(() => {
    let cancelled = false;
    const loadDecision = (): void => {
      fetch("/api/vindex/decisions/current", { cache: "no-store" })
        .then(async (response) => {
          if (!response.ok) return null;
          return (await response.json()) as DecisionView;
        })
        .then((result) => {
          if (!cancelled && result !== null) setDecision(result);
        })
        .catch(() => {
          // keep last known decision
        });
    };
    loadDecision();
    const interval = setInterval(() => {
      if (!document.hidden) loadDecision();
    }, POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, []);

  const model = state.status === "ready" ? state.model : null;
  const status = model !== null ? statusLabel(model) : null;
  const copy = model !== null ? statusCopy(model) : null;
  const freshness = model?.freshness ?? null;

  return (
    <>
      <header className="state-heading">
        <span className="state-heading__mark"><Activity size={22} aria-hidden="true" /></span>
        <div>
          <p className="data-label">POSITION STATUS</p>
          <h1>Protected route</h1>
          <p>{copy ?? "Loading the live protected route."}</p>
        </div>
      </header>

      {status !== null && freshness !== null && (
        <p className="form-note">
          <strong className={freshness === "live" ? "" : "empty-dash"}>{freshness === "live" ? "LIVE" : freshness === "stale" ? "STALE" : "UNAVAILABLE"}</strong>
          {" · "}{status}
        </p>
      )}

      <div className="route-grid-3">
        <section className="outline-panel route-card">
          <h2>Protected route</h2>
          <div className="evidence-line"><span>Network</span><strong>{model?.position.networkName ?? "—"}</strong></div>
          <div className="evidence-line"><span>Protocol</span><strong>{model?.position.protocol ?? "—"}</strong></div>
          <div className="evidence-line"><span>Protected asset</span><strong className={model === null ? "empty-dash" : ""}>{model?.position.asset.label ?? "—"}</strong></div>
          <div className="evidence-line"><span>Execution wallet</span><strong className={model === null ? "empty-dash" : ""}>{model !== null ? formatWallet(model.position.executionWallet) : "—"}</strong></div>
        </section>
        <section className="outline-panel route-card">
          <h2>Current position</h2>
          <div className="evidence-line"><span>Position</span><strong className={model === null ? "empty-dash" : ""}>{model !== null ? `${model.position.suppliedBalance.formatted} USDC test position` : "—"}</strong></div>
          <div className="evidence-line"><span>Execution wallet USDC</span><strong className={model === null ? "empty-dash" : ""}>{model !== null ? model.position.executionWalletUsdcBalance.formatted : "—"}</strong></div>
          <div className="evidence-line"><span>Execution wallet ETH</span><strong className={model === null ? "empty-dash" : ""}>{model !== null ? model.position.executionWalletNativeBalance.formatted : "—"}</strong></div>
          <div className="evidence-line"><span>Safe wallet</span><strong className={model === null || model.position.safeWallet === null ? "empty-dash" : ""}>{model?.position.safeWallet !== null && model !== null ? formatWallet(model.position.safeWallet) : "Not configured"}</strong></div>
        </section>
        <section className="outline-panel route-card">
          <h2>Last observed</h2>
          <div className="evidence-line"><span>Block</span><strong className={model === null ? "empty-dash" : ""}>{model?.position.blockNumber ?? "—"}</strong></div>
          <div className="evidence-line"><span>Block timestamp</span><strong className={model === null || model.position.blockTimestamp === null ? "empty-dash" : ""}>{model?.position.blockTimestamp ?? "—"}</strong></div>
          <div className="evidence-line"><span>Observed at</span><strong className={model === null ? "empty-dash" : ""}>{model?.position.observedAt ?? "—"}</strong></div>
          <button className="primary-cta" type="button" onClick={() => void refresh()} disabled={refreshing}>
            <RefreshCw size={15} aria-hidden="true" /> {refreshing ? "Refreshing…" : "Refresh position"}
          </button>
          {clientError !== null && <p className="form-error">{clientError}</p>}
        </section>
      </div>

      {state.status === "error" && (
        <section className="outline-panel monitor-lower" role="status">
          <div className="route-card__footer">
            <div>
              <p className="data-label">UNAVAILABLE</p>
              <h3>{state.message}</h3>
              <p className="muted">Check that the server environment and database are configured, then refresh.</p>
            </div>
            <button className="secondary-button" type="button" onClick={() => void refresh()}>Retry</button>
          </div>
        </section>
      )}

      <section className="outline-panel monitor-lower">
        <div className="route-card__footer">
          <div>
            <p className="data-label">PROTECTION STATE</p>
            <h3>{decision?.state ?? "—"}</h3>
            <p className="muted">
              {decision === null
                ? "Policy state will appear when a policy is armed."
                : decision.state === "DRAFT"
                  ? "No protection policy is armed."
                  : decision.state === "WATCHING"
                    ? "Monitoring active. No confirmed protection condition."
                    : decision.state === "ELEVATED"
                      ? "Signals elevated. No evacuation has been triggered."
                      : "Confirmation in progress. No funds have moved."}
            </p>
          </div>
        </div>
        {decision?.drill === true && decision.drillLabel !== null && (
          <p className="form-note">
            <strong>{decision.drillLabel}</strong> — {decision.drillExplanation}
          </p>
        )}
        <div className="route-grid-3">
          <div className="route-card">
            <p className="data-label">POLICY</p>
            <div className="evidence-line">
              <span>Mode</span>
              <strong>{decision?.policy?.mode ?? "—"}</strong>
            </div>
            <div className="evidence-line">
              <span>Version</span>
              <strong>{decision?.policy?.version !== undefined ? `v${decision.policy.version}` : "—"}</strong>
            </div>
            <div className="evidence-line">
              <span>Required signals</span>
              <strong>{decision?.policy?.requiredSignals ?? "—"}</strong>
            </div>
          </div>
          <div className="route-card">
            <p className="data-label">CONSENSUS</p>
            <div className="evidence-line">
              <span>Matched families</span>
              <strong>{decision !== null ? `${decision.matchedCount} / ${decision.policy?.requiredSignals ?? "?"}` : "—"}</strong>
            </div>
            <div className="evidence-line">
              <span>Confirmation</span>
              <strong className={decision !== null && !decision.readyForSimulation ? "empty-dash" : ""}>
                {decision === null
                  ? "—"
                  : decision.readyForSimulation
                    ? "passed"
                    : decision.confirmedAt !== null
                      ? "expired"
                      : "not reached"}
              </strong>
            </div>
            <div className="evidence-line">
              <span>Expires at</span>
              <strong className={decision?.expiresAt ? "" : "empty-dash"}>{decision?.expiresAt ?? "—"}</strong>
            </div>
          </div>
          <div className="route-card">
            <p className="data-label">MATCHED FAMILIES</p>
            {decision === null || decision.matchedFamilies.length === 0 ? (
              <p className="form-note">No matched families.</p>
            ) : (
              <ul className="muted">
                {decision.matchedFamilies.map((family) => (
                  <li key={family.family}>
                    <strong>{family.family}</strong>
                    <span>{family.reason}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      </section>

      {preparation !== null && (
        <section className="outline-panel monitor-lower">
          <div className="route-card__footer">
            <div>
              <p className="data-label">EXIT PREPARATION</p>
              <h3>{preparation.readyForExecution ? "Ready for execution" : "Blocked"}</h3>
              <p className="muted">
                {preparation.readyForExecution
                  ? "The exact withdrawal has been validated and simulated. No funds have moved."
                  : `Preparation blocked: ${preparation.errorCode ?? "unknown"}. No funds have moved.`}
              </p>
            </div>
            <strong className={preparation.readyForExecution ? "" : "empty-dash"}>
              {preparation.readyForExecution ? "SIMULATION PASSED" : preparation.state}
            </strong>
          </div>
          <div className="route-grid-3">
            <div className="route-card">
              <p className="data-label">VALIDATION</p>
              <div className="evidence-line">
                <span>Exit validation</span>
                <strong>passed</strong>
              </div>
              <div className="evidence-line">
                <span>Simulation</span>
                <strong>{preparation.readyForExecution ? "passed" : "failed"}</strong>
              </div>
              <div className="evidence-line">
                <span>Gas estimate</span>
                <strong className={preparation.gasEstimate ? "" : "empty-dash"}>{preparation.gasEstimate ?? "—"}</strong>
              </div>
            </div>
            <div className="route-card">
              <p className="data-label">WITHDRAWAL</p>
              <div className="evidence-line">
                <span>Target</span>
                <strong className="empty-dash">{formatWallet(preparation.target)}</strong>
              </div>
              <div className="evidence-line">
                <span>Asset</span>
                <strong>USDC — Aave Base Sepolia test asset</strong>
              </div>
              <div className="evidence-line">
                <span>Amount mode</span>
                <strong>{preparation.amountMode}</strong>
              </div>
            </div>
            <div className="route-card">
              <p className="data-label">DESTINATION</p>
              <div className="evidence-line">
                <span>Safe wallet</span>
                <strong>{formatWallet(preparation.safeWallet)}</strong>
              </div>
              <div className="evidence-line">
                <span>Expected withdrawal</span>
                <strong className={preparation.expectedWithdrawAmount ? "" : "empty-dash"}>
                  {preparation.expectedWithdrawAmount !== null
                    ? `${(Number(preparation.expectedWithdrawAmount) / 1_000_000).toFixed(6)} USDC (test)`
                    : "—"}
                </strong>
              </div>
              <div className="evidence-line">
                <span>Block</span>
                <strong className={preparation.blockNumber ? "" : "empty-dash"}>{preparation.blockNumber ?? "—"}</strong>
              </div>
            </div>
          </div>
        </section>
      )}

      {execution !== null &&
        (execution.outcome === "SUBMISSION_PENDING" ||
          execution.outcome === "SUBMISSION_UNKNOWN" ||
          execution.outcome === "EXECUTION_PENDING" ||
          execution.outcome === "EXECUTION_FAILED" ||
          execution.outcome === "EXECUTED_VERIFYING_DESTINATION" ||
          execution.outcome === "PROTECTED" ||
          execution.outcome === "INTERVENTION_REQUIRED") && (
          <section className="outline-panel monitor-lower">
            <div className="route-card__footer">
              <div>
                <p className="data-label">EVACUATION EXECUTION</p>
                <h3>
                  {execution.outcome === "PROTECTED"
                    ? "POSITION PROTECTED"
                    : execution.outcome === "INTERVENTION_REQUIRED"
                      ? "INTERVENTION REQUIRED"
                      : execution.outcome === "EXECUTED_VERIFYING_DESTINATION"
                        ? "EXECUTION CONFIRMED — VERIFYING DESTINATION"
                        : execution.outcome === "EXECUTION_FAILED"
                          ? "EXECUTION FAILED"
                          : "EVACUATING"}
                </h3>
                <p className="muted">
                  {execution.outcome === "PROTECTED"
                    ? "The configured safe wallet received the verified result."
                    : execution.outcome === "INTERVENTION_REQUIRED"
                      ? `Destination verification failed: ${execution.errorCode ?? "DESTINATION_MISMATCH"}. No further execution was triggered.`
                      : execution.outcome === "EXECUTED_VERIFYING_DESTINATION"
                        ? "The withdrawal was confirmed onchain. Destination balance verification is pending."
                        : execution.outcome === "EXECUTION_FAILED"
                          ? `Execution failed: ${execution.errorCode ?? "unknown"}. No funds are assumed moved.`
                          : "KeeperHub is executing the protected route. Destination verification is pending."}
                </p>
              </div>
            </div>
            <div className="route-grid-3">
              <div className="route-card">
                <p className="data-label">KEEPERHUB</p>
                <div className="evidence-line">
                  <span>Execution id</span>
                  <strong className={execution.keeperhubExecutionId ? "" : "empty-dash"}>
                    {execution.keeperhubExecutionId ?? "—"}
                  </strong>
                </div>
                <div className="evidence-line">
                  <span>Status</span>
                  <strong className={execution.status ? "" : "empty-dash"}>{execution.status ?? "—"}</strong>
                </div>
                <div className="evidence-line">
                  <span>Sponsored</span>
                  <strong>{execution.sponsored === null ? "—" : String(execution.sponsored)}</strong>
                </div>
              </div>
              <div className="route-card">
                <p className="data-label">TRANSACTION</p>
                <div className="evidence-line">
                  <span>Tx hash</span>
                  <strong className={execution.transactionHash ? "" : "empty-dash"}>
                    {execution.transactionHash !== null ? formatWallet(execution.transactionHash) : "—"}
                  </strong>
                </div>
                <div className="evidence-line">
                  <span>Tx link</span>
                  <strong className={execution.transactionLink ? "" : "empty-dash"}>
                    {execution.transactionLink !== null ? "sepolia.basescan.org" : "—"}
                  </strong>
                </div>
                <div className="evidence-line">
                  <span>Block</span>
                  <strong className={execution.blockNumber ? "" : "empty-dash"}>{execution.blockNumber ?? "—"}</strong>
                </div>
              </div>
              <div className="route-card">
                <p className="data-label">WITHDRAWAL</p>
                <div className="evidence-line">
                  <span>Actual withdrawn</span>
                  <strong className={execution.actualWithdrawAmount ? "" : "empty-dash"}>
                    {execution.actualWithdrawAmount !== null
                      ? `${(Number(execution.actualWithdrawAmount) / 1_000_000).toFixed(6)} USDC (test)`
                      : "—"}
                  </strong>
                </div>
                <div className="evidence-line">
                  <span>Post-position</span>
                  <strong className={execution.postPositionAmount ? "" : "empty-dash"}>
                    {execution.postPositionAmount ?? "—"}
                  </strong>
                </div>
                <div className="evidence-line">
                  <span>Destination</span>
                  <strong className={preparation?.safeWallet ? "" : "empty-dash"}>
                    {preparation?.safeWallet ? formatWallet(preparation.safeWallet) : "—"}
                  </strong>
                </div>
              </div>
            </div>
            {receipt !== null && (
              <div className="diagnostic-actions">
                <Link href={`/receipt/${receipt.id}`} className="primary-cta">View Rescue Receipt</Link>
              </div>
            )}
          </section>
        )}

      <section className="outline-panel monitor-lower">
        <div className="route-card__footer">
          <div>
            <p className="data-label">LIVE OBSERVATIONS</p>
            <h3>Signal evidence</h3>
            <p className="muted">
              Live observations from the Aave market. No protection policy is active.
            </p>
          </div>
          {signals !== null && (
            <strong className={signals.freshness === "LIVE" ? "" : "empty-dash"}>
              {signals.freshness}
            </strong>
          )}
        </div>
        {signals === null ? (
          <p className="form-note">Signal evidence is unavailable until the first collection completes.</p>
        ) : signals.latest.length === 0 ? (
          <p className="form-note">No observations collected yet.</p>
        ) : (
          <div className="route-grid-3">
            {(["ORACLE_PRICE_STATE", "AAVE_RESERVE_STATE", "POSITION_STATE"] as const).map((family) => {
              const observation = signals.latest.find((item) => item.sourceFamily === family);
              return (
                <div className="route-card" key={family}>
                  <p className="data-label">{FAMILY_METRIC_LABEL[family]}</p>
                  <h3>{observation?.metric ?? "—"}</h3>
                  <div className="evidence-line">
                    <span>Value</span>
                    <strong className={observation === undefined ? "empty-dash" : ""}>
                      {observation !== undefined
                        ? `${observation.metadata.formatted ?? observation.normalizedValue}${family === "ORACLE_PRICE_STATE" ? " (USD, 8 decimals)" : ""}`
                        : "—"}
                    </strong>
                  </div>
                  <div className="evidence-line">
                    <span>Source contract</span>
                    <strong className={observation === undefined ? "empty-dash" : ""}>
                      {observation !== undefined ? formatWallet(observation.contractAddress) : "—"}
                    </strong>
                  </div>
                  <div className="evidence-line">
                    <span>Block</span>
                    <strong className={observation === undefined ? "empty-dash" : ""}>
                      {observation?.blockNumber ?? "—"}
                    </strong>
                  </div>
                  <div className="evidence-line">
                    <span>Block timestamp</span>
                    <strong className={observation === undefined || observation.blockTimestamp === null ? "empty-dash" : ""}>
                      {observation?.blockTimestamp ?? "—"}
                    </strong>
                  </div>
                  <div className="evidence-line">
                    <span>Observed at</span>
                    <strong className={observation === undefined ? "empty-dash" : ""}>
                      {observation?.observedAt ?? "—"}
                    </strong>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </section>

      {model !== null && model.diagnostics.length > 0 && (
        <section className="outline-panel monitor-lower">
          <div className="route-card__footer">
            <div>
              <p className="data-label">DIAGNOSTICS</p>
              <ul className="muted">
                {model.diagnostics.map((item) => <li key={item}>{item}</li>)}
              </ul>
            </div>
          </div>
        </section>
      )}
    </>
  );
}
