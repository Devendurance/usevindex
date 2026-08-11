import Link from "next/link";

export function Diagnostic({ state = "BLOCKED" }: { state?: "BLOCKED" | "FAILED" | "EXECUTION_UNKNOWN" | "INTERVENTION_REQUIRED" }) {
  const copy = {
    BLOCKED: {
      title: "Exit blocked",
      body: "The exit did not pass validation or simulation. No unsupported execution was submitted.",
      next: "Review the diagnostic, correct the supported route configuration and keep the position under observation.",
      execution: "KeeperHub request not submitted",
      verification: "Not started",
    },
    FAILED: {
      title: "Execution failed",
      body: "The supported execution path reported a failure. The result needs review before another attempt.",
      next: "Review the execution record and confirm the current position before taking another action.",
      execution: "Failure record unavailable",
      verification: "Not verified",
    },
    EXECUTION_UNKNOWN: {
      title: "Execution status unknown",
      body: "The execution status could not be confirmed. No duplicate submission should be attempted.",
      next: "Query the execution status before deciding whether any further action is safe.",
      execution: "Status lookup required",
      verification: "Not verified",
    },
    INTERVENTION_REQUIRED: {
      title: "Intervention required",
      body: "The destination result could not be verified. Vindex has not marked the position protected.",
      next: "Review the destination and execution evidence with the position under observation.",
      execution: "Execution evidence incomplete",
      verification: "Destination mismatch or timeout",
    },
  }[state];

  return (
    <div className="diagnostic-grid">
      <section className="diagnostic-intro">
        <p className="state-label state-label--danger">{state}</p>
        <h1>{copy.title}</h1>
        <p>{copy.body}</p>
        <p className="diagnostic-intro__funds"><strong>Funds moved:</strong> No live result</p>
      </section>
      <section className="diagnostic-body">
        <div className="diagnostic-summary outline-panel">
          <div><span className="data-label">WHY THIS HAPPENED</span><p>Live validation or execution evidence is unavailable in this UI preview.</p></div>
          <div><span className="data-label">CURRENT NEXT STEP</span><p>{copy.next}</p></div>
          <div><span className="data-label">EXECUTION STATUS</span><p>{copy.execution}</p></div>
          <div><span className="data-label">DESTINATION VERIFICATION</span><p>{copy.verification}</p></div>
        </div>
        <div className="diagnostic-route outline-panel"><span>Position</span><b>→</b><span>Aave withdrawal <em>Blocked</em></span><b>→</b><span>Safe wallet</span></div>
        <div className="diagnostic-record">
          <h2>Diagnostic record</h2>
          <div className="diagnostic-table outline-panel">
            {[['Chain', 'Awaiting live validation'], ['Supported position', 'Awaiting live position data'], ['Safe wallet', 'Awaiting destination validation'], ['Simulation', 'Blocked — no live result'], ['KeeperHub execution', 'Not submitted']].map(([label, value]) => <div key={label}><span>{label}</span><strong>{value}</strong></div>)}
          </div>
        </div>
        <div className="diagnostic-actions">
          <Link className="secondary-button" href="/settings">Review configuration</Link>
          <Link className="secondary-button" href="/audit/preview">View audit trail</Link>
          <Link className="text-button" href="/monitor">Keep monitoring</Link>
        </div>
        <p className="diagnostic-footer">ⓘ &nbsp; No direct-RPC fallback was attempted.</p>
      </section>
    </div>
  );
}
