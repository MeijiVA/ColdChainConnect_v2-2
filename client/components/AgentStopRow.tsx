import { Button } from "@/components/ui/button";
import { Link } from "react-router-dom";
import { ChevronRight, MapPin, PackageCheck } from "lucide-react";
import type { AgentScheduleStop } from "@shared/api";
import { formatCustomerAddress } from "@shared/api";
import { palletTotals, statusClasses } from "@/lib/agentSchedule";
import { formatPeso } from "@/lib/format";

interface AgentStopRowProps {
  index: number;
  stop: AgentScheduleStop;
  isConfirming: boolean;
  onOpenDetails: () => void;
  onConfirmPayment: () => void;
  onRecordPayment: () => void;
}

export function AgentStopRow({ index, stop, isConfirming, onOpenDetails, onConfirmPayment, onRecordPayment }: AgentStopRowProps) {
  const customer = stop.destination_customer;
  const address = customer ? formatCustomerAddress(customer) : "Address unavailable";
  const invoiceLabel = stop.invoice?.receipt_number ?? stop.invoice_id.slice(0, 8);
  const totals = palletTotals(stop.pallets);
  const allShipped = stop.pallets.length > 0 && stop.pallets.every((pallet) => pallet.status === "shipped");

  return (
    <li className="p-4">
      <button
        type="button"
        onClick={onOpenDetails}
        className="flex w-full min-w-0 items-start gap-3 text-left sm:gap-4"
      >
        <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-primary text-sm font-bold text-primary-foreground">{index + 1}</span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-start justify-between gap-2">
            <div className="min-w-0">
              <h3 className="font-semibold text-foreground">{customer?.store_name ?? "Destination unavailable"}</h3>
              <p className="mt-1 flex items-start gap-1.5 text-sm text-muted-foreground">
                <MapPin size={15} className="mt-0.5 shrink-0" />
                <span className="truncate">{address}</span>
              </p>
            </div>
            <div className="flex flex-col items-end gap-1">
              <span className={`rounded-full border px-2.5 py-1 text-xs font-semibold capitalize ${statusClasses(stop.status)}`}>
                {stop.status.replace("_", " ")}
              </span>
              {stop.invoice && (
                <span className="font-rajdhani text-xl font-bold text-foreground">{formatPeso(stop.invoice.total_amount)}</span>
              )}
            </div>
          </div>
          <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
            <span className="inline-flex items-center gap-1"><PackageCheck size={14} /> Invoice {invoiceLabel}</span>
            <span>Pallets · {stop.pallets.length}</span>
            {totals.units > 0 && <span>{totals.products} product{totals.products === 1 ? "" : "s"} · {totals.units} units</span>}
          </div>
        </div>
      </button>

      <div className="mt-3 grid grid-cols-2 gap-2">
        <Button type="button" variant="outline" onClick={onOpenDetails} className={`h-12 text-base ${stop.invoice ? "" : "col-span-2"}`}>
          View details <ChevronRight size={16} />
        </Button>
        {stop.invoice && (
          <Button asChild variant="outline" className="h-12 text-base">
            <Link to={`/booking-dispatch/preparation?order=${stop.invoice.booking_id}`}>
              <PackageCheck size={16} /> Track pallets
            </Link>
          </Button>
        )}
      </div>

      <div className="mt-3">
        {stop.status === "completed" && stop.is_paid ? (
          <p className="text-sm font-semibold text-green">Paid</p>
        ) : stop.status === "completed" ? (
          <div className="space-y-2">
            <p className="text-sm font-semibold text-warning">
              {stop.outstanding_amount != null && stop.invoice && stop.outstanding_amount < Number(stop.invoice.total_amount ?? 0)
                ? `Partially paid · ₱${stop.outstanding_amount.toLocaleString(undefined, { minimumFractionDigits: 2 })} remaining`
                : "Not paid · recorded in Accounts Receivable"}
            </p>
            <Button type="button" onClick={onRecordPayment} disabled={isConfirming} variant="success" className="h-12 w-full text-base">
              Record payment
            </Button>
          </div>
        ) : allShipped ? (
          <Button type="button" onClick={onConfirmPayment} disabled={isConfirming} variant="success" className="h-12 w-full text-base">
            Confirm delivery & payment
          </Button>
        ) : (
          <p className="text-xs text-muted-foreground">Delivery confirmation is available once all pallets are shipped.</p>
        )}
      </div>
    </li>
  );
}
