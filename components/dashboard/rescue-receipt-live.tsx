"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { safeBaseScanTxUrl } from "@/lib/vindex/basescan";
import { TxLink } from "@/components/vindex/tx-link";
import { MatchedFamilyList } from "@/components/vindex/matched-family-list";

type ReceiptResponse = {
  id: string;
  executionId: string;
  positionId: string;
  policyMode: string;
  verifiedAmount: string;
  destination: string;
  txHash: string;
  keeperhubExecutionId: string;
  status: string;
  receipt: {
    drillLabel?: string;
    drillExplanation?: string;
    network?: string;
    protocol?: string;
    position?: string;
    policy?: { label?: string; mode?: string; version?: number; requiredSignals?: number };
    trigger?: { consensus?: string; families?: Array<{ family?: string; reason?: string }> };
    consensus?: { rule?: string; matchedCount?: number; decisionId?: string; confirmedAt?: string | null };
    simulation?: { passed?: boolean; blockNumber?: string | null; expectedAmount?: string | null };
    action?: string;
    expectedWithdraw?: string | null;
    withdrawn?: string | null;
    verifiedReceived?: string;
    destination?: { full?: string; short?: string };
    keeperhub?: { executionId?: string | null; sponsored?: boolean | null };
    transaction?: { hash?: string | null; link?: string | null; block?: string | null };
    balances?: { pre?: string; post?: string; delta?: string };
    verification?: { status?: string; blockNumber?: string; blockTimestamp?: string };
    status?: string;
    generatedAt?: string;
  };
  createdAt: string;
};

const fmt = (baseUnits: string | null | undefined): string =>
  baseUnits === null || baseUnits === undefined ? "—" : `${(Number(baseUnits) / 1_000_000).toFixed(6)} USDC (test)`;

export function RescueReceiptLive({ receiptId }: { receiptId: string }) {
  const [receipt, setReceipt] = useState<ReceiptResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch(`/api/vindex/receipts/${encodeURIComponent(receiptId)}`, { cache: "no-store" })
      .then(async (response) => {
        const body = (await response.json().catch(() => null)) as ReceiptResponse | null;
        if (!response.ok || body === null) {
          if (!cancelled) setError("This receipt does not exist or is not available yet.");
          return;
        }
        if (!cancelled) setReceipt(body);
      })
      .catch(() => {
        if (!cancelled) setError("The rescue receipt could not be loaded.");
      });
    return () => {
      cancelled = true;
    };
  }, [receiptId]);

  if (error !== null) {
    return (
      <main id="main-content" className="route-page"><div className="content-wrap">
        <header className="route-page__heading"><h1>Rescue Receipt</h1><p className="muted">{error}</p></header>
        <div className="diagnostic-actions"><Link className="secondary-button" href="/monitor">Back to monitor</Link></div>
      </div></main>
    );
  }

  if (receipt === null) {
    return (
      <main id="main-content" className="route-page"><div className="content-wrap">
        <header className="route-page__heading"><h1>Rescue Receipt</h1><p className="muted">Loading the verified receipt…</p></header>
      </div></main>
    );
  }

  const r = receipt.receipt;
  return (
    <main id="main-content" className="route-page"><div className="content-wrap">
      <header className="route-page__heading">
        <p className="data-label">VERIFIED RESCUE</p>
        <h1>VINDEX RESCUE / {receiptId.slice(0, 8)}</h1>
        <p className="muted">Generated from persisted onchain and execution evidence. Status: {r.status ?? receipt.status}.</p>
      </header>
      {r.drillLabel !== undefined && (
        <p className="form-note"><strong>{r.drillLabel}</strong> — {r.drillExplanation}</p>
      )}
      <section className="outline-panel route-card">
        <p className="data-label">RECEIPT</p>
        <div className="evidence-line"><span>Network</span><strong>{r.network ?? "—"}</strong></div>
        <div className="evidence-line"><span>Protocol</span><strong>{r.protocol ?? "—"}</strong></div>
        <div className="evidence-line"><span>Position</span><strong>{r.position ?? "—"}</strong></div>
        <div className="evidence-line"><span>Policy</span><strong>{r.policy?.label ?? r.policy?.mode ?? "—"}</strong></div>
        <div className="evidence-line"><span>Consensus</span><strong>{r.consensus?.rule ?? "—"} · {r.consensus?.matchedCount ?? "—"} matched</strong></div>
        <div className="evidence-line"><span>Action</span><strong>{r.action ?? "—"}</strong></div>
        <div className="evidence-line"><span>Expected withdrawal</span><strong>{fmt(r.expectedWithdraw)}</strong></div>
        <div className="evidence-line"><span>Withdrawn (onchain)</span><strong>{fmt(r.withdrawn)}</strong></div>
        <div className="evidence-line"><span>Verified received</span><strong>{fmt(r.verifiedReceived)}</strong></div>
        <div className="evidence-line"><span>Destination</span><strong>{r.destination?.full ?? "—"}</strong></div>
        <div className="evidence-line"><span>KeeperHub execution</span><strong>{r.keeperhub?.executionId ?? "—"}</strong></div>
        <div className="evidence-line"><span>Transaction</span>{r.transaction?.hash ? (<TxLink href={safeBaseScanTxUrl(r.transaction.hash) ?? "#"}>{r.transaction.hash.length > 18 ? `${r.transaction.hash.slice(0, 10)}…${r.transaction.hash.slice(-6)}` : r.transaction.hash}</TxLink>) : (<strong>—</strong>)}</div>
        <div className="evidence-line"><span>Transaction link</span>{r.transaction?.hash ? (<TxLink href={safeBaseScanTxUrl(r.transaction.hash) ?? "#"}>View on BaseScan Sepolia</TxLink>) : (<strong>—</strong>)}</div>
        <div className="evidence-line"><span>Block</span><strong>{r.transaction?.block ?? "—"}</strong></div>
        <div className="evidence-line"><span>Pre / Post balance</span><strong>{fmt(r.balances?.pre)} / {fmt(r.balances?.post)}</strong></div>
        <div className="evidence-line"><span>Verification</span><strong>{r.verification?.status ?? "—"} · block {r.verification?.blockNumber ?? "—"}</strong></div>
        <div className="evidence-line"><span>Generated at</span><strong>{r.generatedAt ?? receipt.createdAt}</strong></div>
      </section>
      <section className="outline-panel route-card">
        <p className="data-label">TRIGGER</p>
        <p className="muted">{r.trigger?.consensus ?? "—"}</p>
        {r.trigger?.families !== undefined && r.trigger.families.length > 0 && (
          <MatchedFamilyList
            families={r.trigger.families.map((family) => ({
              family: family.family ?? "UNKNOWN",
              reason: family.reason ?? "",
            }))}
          />
        )}
      </section>
      <div className="diagnostic-actions">
        <Link className="secondary-button" href="/monitor">Back to monitor</Link>
        {r.transaction?.hash ? (
          <a className="secondary-button" href={safeBaseScanTxUrl(r.transaction.hash) ?? "#"} target="_blank" rel="noopener noreferrer">View on BaseScan Sepolia</a>
        ) : null}
      </div>
    </div></main>
  );
}
