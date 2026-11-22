import type { ReceiptExt } from "@/pages/modules/DeliveryHistory";

export function ReceiptSheet({ receipt, id }: { receipt: ReceiptExt; id?: string }) {
  return (
    <div className="p-6 sm:p-8 space-y-6 font-mono text-sm" id={id}>
      <div className="text-center border-b-2 border-dashed border-border pb-4">
        <p className="font-rajdhani text-2xl font-bold text-foreground tracking-tight">COLDCHAIN CONNECT</p>
        <p className="page-subtitle">ACDP Warehouse, Pampanga</p>
        <p className="text-xs text-muted-foreground">Cold Chain Logistics & Distribution</p>
      </div>

      <div className="space-y-1 text-xs">
        <div className="flex justify-between gap-4">
          <span className="text-muted-foreground">Receipt No.:</span>
          <span className="font-bold text-accent-2">{receipt.receipt_number}</span>
        </div>
        <div className="flex justify-between gap-4">
          <span className="text-muted-foreground">Date:</span>
          <span className="text-right">{new Date(receipt.confirmed_at).toLocaleString("en-PH")}</span>
        </div>
        <div className="flex justify-between gap-4">
          <span className="text-muted-foreground">Invoice ID:</span>
          <span>{receipt.invoice_id.slice(0, 8)}…</span>
        </div>
        <div className="flex justify-between gap-4">
          <span className="text-muted-foreground">Truck:</span>
          <span>{receipt.truck?.license_plate ?? receipt.truck_id.slice(0, 8)}</span>
        </div>
        {receipt.confirmed_by && (
          <div className="flex justify-between gap-4">
            <span className="text-muted-foreground">Confirmed by:</span>
            <span className="break-all text-right">{receipt.confirmed_by}</span>
          </div>
        )}
      </div>

      <div className="border-t border-dashed border-border pt-4 space-y-1 text-xs">
        <p className="font-semibold text-foreground mb-1">Delivered to:</p>
        <p className="font-bold">{receipt.customer?.store_name ?? receipt.customer_id}</p>
        {receipt.customer?.location && <p className="text-muted-foreground">{receipt.customer.location}</p>}
        {receipt.customer?.contact_info && <p className="text-muted-foreground">{receipt.customer.contact_info}</p>}
      </div>

      <div className="border-t border-dashed border-border pt-4 space-y-1 text-xs">
        {receipt.invoice?.payment_status && (
          <div className="flex justify-between gap-4">
            <span className="text-muted-foreground">Payment Status:</span>
            <span>{receipt.invoice.payment_status.toUpperCase()}</span>
          </div>
        )}
      </div>

      {receipt.notes && (
        <div className="border-t border-dashed border-border pt-4 text-xs">
          <p className="text-muted-foreground">Notes:</p>
          <p className="break-words">{receipt.notes}</p>
        </div>
      )}

      <div className="border-t-2 border-dashed border-border pt-4 text-center text-xs text-muted-foreground space-y-1">
        <p>This is an official Original Receipt.</p>
        <p>Thank you for your business!</p>
        <p className="mt-2 font-semibold text-foreground">ColdChain Connect</p>
      </div>
    </div>
  );
}
