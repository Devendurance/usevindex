import type { Evidence } from "@/lib/vindex/types";

export function EvidenceValue<T>({ evidence, label, empty = "—" }: { evidence: Evidence<T>; label: string; empty?: string }) {
  const value = evidence.value === null ? empty : String(evidence.value);
  return (
    <div className="evidence-line">
      <span>{label}</span>
      <strong className={evidence.value === null ? "empty-dash" : ""}>{value}</strong>
    </div>
  );
}

export function EmptyEvidenceRow({ title, reason, meta = "—" }: { title: string; reason: string; meta?: string }) {
  return (
    <div className="empty-evidence-row">
      <span className="empty-evidence-row__dot" aria-hidden="true" />
      <div>
        <p className="empty-evidence-row__title">{title}</p>
        <p className="muted">{reason}</p>
      </div>
      <span className="data-value empty-dash">{meta}</span>
    </div>
  );
}
