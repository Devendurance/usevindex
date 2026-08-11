const events = [
  "POSITION_DISCOVERED",
  "POLICY_ARMED",
  "SIGNAL_OBSERVED",
  "CONFIRMATION_STARTED",
  "SIMULATION_PASSED",
  "KEEPERHUB_SUBMISSION_REQUESTED",
  "DESTINATION_VERIFIED",
  "RESCUE_RECEIPT_CREATED",
];

export function AuditTimeline() {
  return (
    <div className="audit-timeline outline-panel">
      <div className="audit-timeline__header"><span>EVENT</span><span>TIME / BLOCK</span><span>STATUS</span></div>
      {events.map((event) => (
        <div className="audit-timeline__row" key={event}>
          <strong>{event}</strong>
          <span className="empty-dash">—</span>
          <span className="muted">Awaiting record</span>
        </div>
      ))}
      <button className="secondary-button" type="button" disabled>View on BaseScan Sepolia</button>
      <p className="muted audit-timeline__hint">Disabled until a transaction exists.</p>
    </div>
  );
}
