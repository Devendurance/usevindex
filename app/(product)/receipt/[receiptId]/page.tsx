import { RescueReceiptLive } from "@/components/dashboard/rescue-receipt-live";
import { normalizeRouteParam } from "@/lib/vindex/route-params";

export default async function ReceiptPage({ params }: { params: Promise<{ receiptId: string }> }) {
  const { receiptId } = await params;
  normalizeRouteParam(receiptId);
  return <RescueReceiptLive receiptId={receiptId} />;
}
