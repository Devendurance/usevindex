import Link from "next/link";
import { Diagnostic } from "@/components/vindex/diagnostic";
import { normalizeRouteParam } from "@/lib/vindex/route-params";
import { firstQueryValue, previewStateFromQuery } from "@/lib/vindex/routes";
import type { ProtectionState } from "@/lib/vindex/types";

type DiagnosticState = Extract<ProtectionState, "BLOCKED" | "FAILED" | "EXECUTION_UNKNOWN" | "INTERVENTION_REQUIRED">;

export default async function OutcomePage({ params, searchParams }: { params: Promise<{ operationId: string }>; searchParams: Promise<{ state?: string | string[] }> }) {
  const { operationId } = await params;
  const query = await searchParams;
  normalizeRouteParam(operationId);
  const previewState = previewStateFromQuery(firstQueryValue(query.state), "BLOCKED");
  const diagnosticState: DiagnosticState = ["FAILED", "EXECUTION_UNKNOWN", "INTERVENTION_REQUIRED"].includes(previewState as DiagnosticState)
    ? previewState as DiagnosticState
    : "BLOCKED";
  return (
    <main id="main-content" className="route-page"><div className="content-wrap"><Diagnostic state={diagnosticState} /><div className="diagnostic-actions"><Link className="secondary-button" href="/monitor">Back to monitor</Link></div></div></main>
  );
}
