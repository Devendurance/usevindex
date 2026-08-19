"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { DRILL_EXPLANATION, DRILL_LABEL } from "@/lib/vindex/policy-templates";
import { safeBaseScanTxUrl } from "@/lib/vindex/basescan";
import { TxLink } from "@/components/vindex/tx-link";

// Live demo surface. The server (GET /api/vindex/demo/status) is the only
// source of truth: every stage, id, hash and amount rendered here comes from
// the persisted status view. This component never fabricates progress and
// never fires a write on mount — the backend guarantees refresh safety, so
// polling is read-only and every button action is strictly user-initiated.

const POLL_INTERVAL_MS = 3000;
const USDC_BASE_UNITS = 1_000_000;

type RunStatus =
  | "CREATED"
  | "FUNDED"
  | "POSITION_CREATED"
  | "OBSERVING"
  | "CONFIRMED"
  | "SIMULATED"
  | "EXECUTED"
  | "PROTECTED"
  | "FAILED";

type DrillStage =
  | "WATCHING"
  | "THREAT_EVIDENCE"
  | "MATCHED"
  | "CONFIRMING"
  | "SIMULATION_PASSED"
  | "KEEPERHUB_SUBMISSION"
  | "EXECUTING"
  | "TRANSACTION_CONFIRMED"
  | "VERIFYING_DESTINATION"
  | "PROTECTED";

const DRILL_STAGE_ORDER: DrillStage[] = [
  "WATCHING",
  "THREAT_EVIDENCE",
  "MATCHED",
  "CONFIRMING",
  "SIMULATION_PASSED",
  "KEEPERHUB_SUBMISSION",
  "EXECUTING",
  "TRANSACTION_CONFIRMED",
  "VERIFYING_DESTINATION",
  "PROTECTED",
];

const STAGE_LABELS: Record<Exclude<DrillStage, "MATCHED">, string> = {
  WATCHING: "WATCHING",
  THREAT_EVIDENCE: "THREAT EVIDENCE",
  CONFIRMING: "CONFIRMING",
  SIMULATION_PASSED: "SIMULATION PASSED",
  KEEPERHUB_SUBMISSION: "KEEPERHUB SUBMISSION",
  EXECUTING: "EXECUTING",
  TRANSACTION_CONFIRMED: "TRANSACTION CONFIRMED",
  VERIFYING_DESTINATION: "VERIFYING DESTINATION",
  PROTECTED: "PROTECTED",
};

// MATCHED carries the real persisted counts ("3/2 MATCHED") when the policy
// requirement is known; the terminal PROTECTED view has no persisted counts,
// so the plain stage label is rendered instead of a fabricated "0/?".
const drillStageLabel = (stage: DrillStage, matchedCount: number, requiredSignals: number | null): string => {
  if (stage === "MATCHED") {
    return requiredSignals !== null ? `${matchedCount}/${requiredSignals} MATCHED` : "MATCHED";
  }
  return STAGE_LABELS[stage];
};

// Mirror of GET /api/vindex/demo/status (DemoLifecycleStatusView). Only the
// fields rendered by this component are typed; the server view is the
// authoritative shape and unknown fields are ignored.
type DemoStatusView = {
  positionId: string | null;
  activeRun: {
    runId: string;
    status: RunStatus;
    fundingExecutionId: string | null;
    approvalExecutionId: string | null;
    supplyExecutionId: string | null;
    policyId: string | null;
    decisionId: string | null;
    evacuationExecutionId: string | null;
    rescueReceiptId: string | null;
    errorCode: string | null;
    startedAt: string;
    updatedAt: string;
    stageExecutionIds: { fund: string | null; approve: string | null; supply: string | null };
    transactionHashes: { fund: string | null; approve: string | null; supply: string | null; evacuation: string | null };
    transactionLinks: { fund: string | null; approve: string | null; supply: string | null; evacuation: string | null };
    keeperhubExecutionId: string | null;
    lastKeeperHubStatus: string | null;
  } | null;
  lastProtectionEvent: {
    status: "PROTECTED";
    receiptId: string;
    executionId: string;
    txHash: string | null;
    keeperhubExecutionId: string | null;
    verifiedAmount: string | null;
    expectedAmount: string | null;
    withdrawnAmount: string | null;
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
  protection: { armed: boolean; mode: string | null; policyId: string | null; armedAt: string | null };
  drillProgress: {
    stage: DrillStage;
    label: string;
    matchedCount: number;
    requiredSignals: number | null;
    drillLabel: string | null;
  };
  validation: {
    readyToPrepare: boolean;
    readyToArm: boolean;
    readyToRunDrill: boolean;
    reasons: string[];
    inFlightJob: "PREPARING" | "DRILLING" | null;
  };
};

type ActionError = { kind: "prepare" | "arm" | "disarm" | "drill"; message: string } | null;

const formatPositionAmount = (baseUnits: string): string =>
  (Number(baseUnits) / USDC_BASE_UNITS).toFixed(6);

export function DemoRunSurface() {
  const [status, setStatus] = useState<DemoStatusView | null>(null);
  const [statusError, setStatusError] = useState<string | null>(null);
  const [armMode, setArmMode] = useState<"STANDARD" | "DRILL_HIGH_SENSITIVITY">("STANDARD");
  const [preparing, setPreparing] = useState(false);
  const [arming, setArming] = useState(false);
  const [disarming, setDisarming] = useState(false);
  const [drilling, setDrilling] = useState(false);
  const [actionError, setActionError] = useState<ActionError>(null);
  // Set from the arm response so the summary never flashes "NOT ARMED" while
  // the re-fetched status still reports the pre-arm state. Cleared whenever a
  // refresh reports the policy is actually not armed (e.g. after self-heal).
  const [armConfirmation, setArmConfirmation] = useState<{ mode: string } | null>(null);

  // Poll while a run or a background job exists; stop issuing requests when
  // the view is idle. Written by every status read so the interval never
  // captures a stale closure.
  const shouldPollRef = useRef(false);

  const readStatus = useCallback(async (): Promise<DemoStatusView | null> => {
    try {
      const response = await fetch("/api/vindex/demo/status", { cache: "no-store" });
      const parsed = (await response.json().catch(() => null)) as DemoStatusView | null;
      return response.ok && parsed !== null ? parsed : null;
    } catch {
      return null;
    }
  }, []);

  const applyStatus = useCallback((parsed: DemoStatusView): void => {
    setStatus(parsed);
    // Poll only while something can still move: an active (non-FAILED) run or
    // a background job. A terminal FAILED/PROTECTED view stops the cadence.
    shouldPollRef.current =
      (parsed.activeRun !== null && parsed.activeRun.status !== "FAILED") ||
      parsed.validation.inFlightJob !== null;
    if (parsed.protection.armed === false) setArmConfirmation(null);
    setStatusError(null);
  }, []);

  const refreshStatus = useCallback(async (): Promise<void> => {
    const parsed = await readStatus();
    if (parsed === null) {
      setStatusError("Live protection state is unavailable.");
      return;
    }
    applyStatus(parsed);
  }, [applyStatus, readStatus]);

  useEffect(() => {
    // Read once on mount, then poll on the cadence only while active. A
    // StrictMode remount simply re-reads the same persisted view — no writes.
    void readStatus().then((parsed) => {
      if (parsed !== null) applyStatus(parsed);
      else setStatusError("Live protection state is unavailable.");
    });
    const interval = setInterval(() => {
      if (shouldPollRef.current && !document.hidden) void refreshStatus();
    }, POLL_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [applyStatus, readStatus, refreshStatus]);

  const postJson = useCallback(async (url: string, body: unknown): Promise<{ ok: boolean; message: string | null }> => {
    try {
      const response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        cache: "no-store",
      });
      const parsed = (await response.json().catch(() => null)) as { message?: string } | null;
      return { ok: response.ok, message: parsed?.message ?? null };
    } catch {
      return { ok: false, message: "The request failed. Check that the server is reachable." };
    }
  }, []);

  const preparePosition = useCallback(async () => {
    if (preparing || status?.validation.readyToPrepare !== true) return;
    setPreparing(true);
    setActionError(null);
    const result = await postJson("/api/vindex/demo/prepare", {});
    setPreparing(false);
    if (!result.ok) {
      setActionError({ kind: "prepare", message: result.message ?? "Preparing the demo position failed." });
      return;
    }
    void refreshStatus();
  }, [postJson, preparing, refreshStatus, status?.validation.readyToPrepare]);

  const runDrill = useCallback(async () => {
    if (drilling || status?.validation.readyToRunDrill !== true) return;
    setDrilling(true);
    setActionError(null);
    const result = await postJson("/api/vindex/demo/drill", {});
    setDrilling(false);
    if (!result.ok) {
      setActionError({ kind: "drill", message: result.message ?? "Starting the protection drill failed." });
      return;
    }
    void refreshStatus();
  }, [drilling, postJson, refreshStatus, status?.validation.readyToRunDrill]);

  const armPosition = useCallback(async () => {
    if (arming || status?.validation.readyToArm !== true) return;
    setArming(true);
    setActionError(null);
    const result = await postJson("/api/vindex/positions/arm", { mode: armMode });
    setArming(false);
    if (!result.ok) {
      setActionError({ kind: "arm", message: result.message ?? "Arming the position failed." });
      return;
    }
    // Keep the transient confirmation until the authoritative view agrees; a
    // refresh reporting armed=false (self-heal) clears it again.
    setArmConfirmation({ mode: armMode });
    void refreshStatus();
  }, [arming, armMode, postJson, refreshStatus, status?.validation.readyToArm]);

  const disarmPosition = useCallback(async () => {
    if (disarming || status?.protection.armed !== true) return;
    setDisarming(true);
    setActionError(null);
    const result = await postJson("/api/vindex/positions/disarm", {});
    setDisarming(false);
    if (!result.ok) {
      setActionError({ kind: "disarm", message: result.message ?? "Disarming the position failed." });
      return;
    }
    setArmConfirmation(null);
    void refreshStatus();
  }, [disarming, postJson, refreshStatus, status?.protection.armed]);

  const run = status?.activeRun ?? null;
  const drillProgress = status?.drillProgress;
  const validation = status?.validation;
  const protection = status?.protection;
  const lastEvent = status?.lastProtectionEvent ?? null;

  // --- Prepare section -------------------------------------------------------

  // Every marker derives from persisted stage execution ids + the run status.
  // Approval counts as satisfied once supply exists (a sufficient allowance
  // legitimately skips the approval stage).
  const prepareLines = [
    { label: "Funding", done: run?.fundingExecutionId !== null },
    { label: "Approval", done: run?.approvalExecutionId !== null || run?.supplyExecutionId !== null },
    { label: "Aave supply", done: run?.supplyExecutionId !== null },
    { label: "Position ready", done: run?.supplyExecutionId !== null },
  ];
  const runInProgress = run !== null && run.status !== "FAILED";
  const firstPendingIndex = prepareLines.findIndex((line) => !line.done);

  const canPrepare = validation?.readyToPrepare === true && !preparing;
  const prepareBlockingReason =
    status !== null && !status.validation.readyToPrepare ? (status.validation.reasons[0] ?? null) : null;

  // --- Arm section ------------------------------------------------------------

  const justArmed = armConfirmation !== null;
  const statusArmed = protection?.armed === true;
  const armedMode = statusArmed && protection.mode !== null ? protection.mode : (armConfirmation?.mode ?? null);
  let protectionLabel = "—";
  if (statusArmed || justArmed) {
    protectionLabel = `ARMED — ${armedMode ?? "UNKNOWN"}${justArmed ? ", WATCHING" : ""}`;
  } else if (status !== null) {
    protectionLabel = "NOT ARMED";
  }

  const canArm = validation?.readyToArm === true && !arming;
  const armBlockingReason = status !== null && !status.validation.readyToArm ? (status.validation.reasons[0] ?? null) : null;
  const canDisarm = protection?.armed === true && !disarming;

  // --- Drill section ----------------------------------------------------------

  const canDrill = validation?.readyToRunDrill === true && !drilling;
  const drillBlockingReason =
    status !== null && !status.validation.readyToRunDrill ? (status.validation.reasons[0] ?? null) : null;

  // A drill is in progress from the moment the background job starts until the
  // terminal PROTECTED stage — driven exclusively by the persisted view.
  const drillActive =
    status !== null &&
    (validation?.inFlightJob === "DRILLING" ||
      (run !== null && (run.decisionId !== null || run.evacuationExecutionId !== null)) ||
      drillProgress?.stage === "PROTECTED");

  const currentStageIndex = drillProgress !== undefined ? DRILL_STAGE_ORDER.indexOf(drillProgress.stage) : -1;
  const visibleStages = currentStageIndex >= 0 ? DRILL_STAGE_ORDER.slice(0, currentStageIndex + 1) : [];

  const drillDisclaimerLabel =
    drillProgress?.drillLabel ?? (drillProgress?.stage === "PROTECTED" ? DRILL_LABEL : null);

  // --- Proof + receipt + failure ----------------------------------------------

  // The full verified evacuation hash lives in the run view; the link is built
  // from that hash alone — never from a truncated value or a server link.
  const proofTxHash = run?.transactionHashes.evacuation ?? null;
  const receiptActive = drillProgress?.stage === "PROTECTED" && lastEvent !== null;

  return (
    <>
      {statusError !== null && <p className="form-help">{statusError}</p>}

      <section className="outline-panel monitor-lower">
        <div className="route-card__footer">
          <div>
            <p className="data-label">DEMO POSITION</p>
            <h2>Prepare the demo position</h2>
            <p className="muted">
              Funds a fresh 5 USDC test position through KeeperHub — funded, approved and supplied exactly once per run.
            </p>
          </div>
          <button className="secondary-button" type="button" onClick={() => void preparePosition()} disabled={!canPrepare}>
            {preparing ? "Preparing…" : "Prepare demo position"}
          </button>
        </div>
        {prepareBlockingReason !== null && <p className="form-help">{prepareBlockingReason}</p>}
        {actionError?.kind === "prepare" && <p className="form-error">{actionError.message}</p>}
        {run !== null && (
          <div className="route-card">
            <p className="data-label">PREPARE PROGRESS</p>
            {prepareLines.map((line, index) => (
              <div className="evidence-line" key={line.label}>
                <span>{line.label}</span>
                <strong>{line.done ? "DONE" : index === firstPendingIndex && runInProgress ? "ACTIVE" : "PENDING"}</strong>
              </div>
            ))}
          </div>
        )}
      </section>

      <section className="outline-panel monitor-lower">
        <div className="route-card__footer">
          <div>
            <p className="data-label">PROTECTION POLICY</p>
            <h2>Arm the demo position</h2>
            <p className="muted">
              Arms a policy so the monitor reports the honest baseline.{" "}
              <Link className="text-button" href="/monitor">Open monitor</Link>
            </p>
          </div>
          {status !== null && <strong>{protectionLabel}</strong>}
        </div>
        {protection?.armed === true ? (
          <div className="route-card">
            <div className="evidence-line">
              <span>Policy mode</span>
              <strong>{protection.mode ?? "—"}</strong>
            </div>
            <button className="secondary-button" type="button" onClick={() => void disarmPosition()} disabled={!canDisarm}>
              {disarming ? "Disarming…" : "Disarm"}
            </button>
            {actionError?.kind === "disarm" && <p className="form-error">{actionError.message}</p>}
          </div>
        ) : (
          <div className="route-card">
            <div className="choice-list">
              <label>
                <input type="radio" name="demo-policy-mode" value="STANDARD" checked={armMode === "STANDARD"} onChange={() => setArmMode("STANDARD")} />
                Standard
              </label>
              <label>
                <input
                  type="radio"
                  name="demo-policy-mode"
                  value="DRILL_HIGH_SENSITIVITY"
                  checked={armMode === "DRILL_HIGH_SENSITIVITY"}
                  onChange={() => setArmMode("DRILL_HIGH_SENSITIVITY")}
                />
                Protection drill / high sensitivity
              </label>
            </div>
            <button className="secondary-button" type="button" onClick={() => void armPosition()} disabled={!canArm}>
              {arming ? "Arming…" : "Arm position"}
            </button>
            {armBlockingReason !== null && <p className="form-help">{armBlockingReason}</p>}
            {actionError?.kind === "arm" && <p className="form-error">{actionError.message}</p>}
          </div>
        )}
      </section>

      <section className="outline-panel monitor-lower">
        <div className="route-card__footer">
          <div>
            <p className="data-label">PROTECTION DRILL</p>
            <h2>Run the protection drill</h2>
            <p className="muted">
              Collects fresh signal evidence, confirms consensus and executes one real KeeperHub withdrawal to the safe wallet.
            </p>
          </div>
          <button className="primary-cta" type="button" onClick={() => void runDrill()} disabled={!canDrill}>
            {drilling ? "Starting drill…" : "Run protection drill"}
          </button>
        </div>
        {drillBlockingReason !== null && <p className="form-help">{drillBlockingReason}</p>}
        {actionError?.kind === "drill" && <p className="form-error">{actionError.message}</p>}
        {drillActive && visibleStages.length > 0 && (
          <div className="route-card">
            <p className="data-label">DRILL PROGRESS</p>
            {visibleStages.map((stage, index) => (
              <div className="evidence-line" key={stage}>
                <span>{drillStageLabel(stage, drillProgress?.matchedCount ?? 0, drillProgress?.requiredSignals ?? null)}</span>
                <strong>{index < currentStageIndex || stage === "PROTECTED" ? "DONE" : "ACTIVE"}</strong>
              </div>
            ))}
          </div>
        )}
        {drillDisclaimerLabel !== null && (
          <p className="form-note">
            <strong>{drillDisclaimerLabel}</strong> — {DRILL_EXPLANATION}
          </p>
        )}
      </section>

      {run !== null && run.status === "FAILED" && (
        <section className="outline-panel monitor-lower" role="status">
          <p className="state-label state-label--danger">FAILED</p>
          <h2>The demo run did not complete</h2>
          <p className="muted">
            Error code: <strong>{run.errorCode ?? "UNKNOWN"}</strong>. No further execution was triggered automatically.
            Review the failure record, then prepare a fresh demo position to retry.
          </p>
        </section>
      )}

      {proofTxHash !== null && (
        <section className="outline-panel monitor-lower">
          <div className="route-card__footer">
            <div>
              <p className="data-label">KEEPERHUB PROOF</p>
              <h2>Execution submitted through KeeperHub</h2>
              <p className="muted">The withdrawal was executed through the KeeperHub execution layer. Verify it onchain.</p>
            </div>
            <strong>{run?.lastKeeperHubStatus ?? "EXECUTED"}</strong>
          </div>
          <div className="route-card">
            <div className="evidence-line">
              <span>KeeperHub execution id</span>
              <strong>{run?.keeperhubExecutionId ?? "—"}</strong>
            </div>
            <div className="evidence-line">
              <span>Execution status</span>
              <strong>{run?.lastKeeperHubStatus ?? "—"}</strong>
            </div>
            <div className="evidence-line">
              <span>Transaction hash</span>
              <TxLink href={safeBaseScanTxUrl(proofTxHash) ?? "#"}>{proofTxHash}</TxLink>
            </div>
            <div className="evidence-line">
              <span>Transaction link</span>
              <TxLink className="text-button" href={safeBaseScanTxUrl(proofTxHash) ?? "#"}>View on BaseScan Sepolia</TxLink>
            </div>
          </div>
        </section>
      )}

      {receiptActive && (
        <section className="outline-panel monitor-lower">
          <div className="route-card__footer">
            <div>
              <p className="data-label">RESCUE RECEIPT</p>
              <h2>Position protected</h2>
              <p className="muted">The configured safe wallet received the verified result.</p>
            </div>
            <strong>PROTECTED</strong>
          </div>
          <div className="route-card">
            <div className="evidence-line">
              <span>Expected</span>
              <strong className={lastEvent !== null && lastEvent.expectedAmount !== null ? "" : "empty-dash"}>
                {lastEvent !== null && lastEvent.expectedAmount !== null ? `${formatPositionAmount(lastEvent.expectedAmount)} USDC` : "—"}
              </strong>
            </div>
            <div className="evidence-line">
              <span>Withdrawn</span>
              <strong className={lastEvent !== null && lastEvent.withdrawnAmount !== null ? "" : "empty-dash"}>
                {lastEvent !== null && lastEvent.withdrawnAmount !== null ? `${formatPositionAmount(lastEvent.withdrawnAmount)} USDC` : "—"}
              </strong>
            </div>
            <div className="evidence-line">
              <span>Verified received</span>
              <strong className={lastEvent !== null && lastEvent.verifiedAmount !== null ? "" : "empty-dash"}>
                {lastEvent !== null && lastEvent.verifiedAmount !== null ? `${formatPositionAmount(lastEvent.verifiedAmount)} USDC` : "—"}
              </strong>
            </div>
            <div className="evidence-line">
              <span>Safe wallet</span>
              <strong>{lastEvent?.safeWallet ?? "—"}</strong>
            </div>
            <div className="evidence-line">
              <span>KeeperHub execution id</span>
              <strong>{lastEvent?.keeperhubExecutionId ?? "—"}</strong>
            </div>
            <div className="evidence-line">
              <span>Transaction</span>
              <strong>
                {lastEvent?.txHash !== null && lastEvent !== null ? (
                  <TxLink className="text-button" href={safeBaseScanTxUrl(lastEvent.txHash) ?? "#"}>View on BaseScan Sepolia</TxLink>
                ) : (
                  "—"
                )}
              </strong>
            </div>
          </div>
          {drillDisclaimerLabel !== null && (
            <p className="form-note">
              <strong>{drillDisclaimerLabel}</strong> — {DRILL_EXPLANATION}
            </p>
          )}
          <div className="diagnostic-actions">
            <Link className="secondary-button" href={`/receipt/${lastEvent?.receiptId ?? ""}`}>
              View Rescue Receipt
            </Link>
          </div>
        </section>
      )}
    </>
  );
}
