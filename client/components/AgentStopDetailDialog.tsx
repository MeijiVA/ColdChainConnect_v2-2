import type { ReactNode } from "react";
import { ArrowLeft, MapPin, Phone, UserRound } from "lucide-react";
import type { AgentScheduleStop } from "@shared/api";
import { formatCustomerAddress } from "@shared/api";
import { Button } from "@/components/ui/button";
import { palletStatusLabel, palletTotals } from "@/lib/agentSchedule";

interface AgentStopDetailDialogProps {
  stop: AgentScheduleStop;
  onBack: () => void;
  onShowOnMap?: () => void;
}

function DetailSection({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="space-y-2">
      <h3 className="text-xs font-semibold text-muted-foreground">{title}</h3>
      <div className="rounded-lg bg-muted p-3 text-sm">{children}</div>
    </section>
  );
}

function DetailRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-4 py-1">
      <span className="text-muted-foreground">{label}</span>
      <span className="text-right font-medium text-foreground">{children}</span>
    </div>
  );
}

export function AgentStopDetailDialog({ stop, onBack, onShowOnMap }: AgentStopDetailDialogProps) {
  const customer = stop.destination_customer;
  const saleAgent = stop.sale_agent as (NonNullable<typeof stop.sale_agent> & { full_name?: string | null }) | null;
  const totals = palletTotals(stop.pallets);
  const invoiceLabel = stop.invoice?.receipt_number ?? stop.invoice_id.slice(0, 8);

  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-5 p-4 pb-24 md:p-6 md:pb-6">
      <div className="page-header">
        <div>
          <h1 className="page-title">{customer.store_name}</h1>
          <p className="page-subtitle flex items-start gap-1.5">
            <MapPin size={15} className="mt-0.5 shrink-0" />
            <span>{formatCustomerAddress(customer)}</span>
          </p>
        </div>
        <Button type="button" onClick={onBack} variant="outline">
          <ArrowLeft size={15} />
          Back
        </Button>
      </div>

      <DetailSection title="Contact">
        <DetailRow label="Contact person">{customer.contact_person || "Not provided"}</DetailRow>
        <DetailRow label="Phone">
          {customer.contact_info ? (
            <a href={`tel:${customer.contact_info}`} className="inline-flex items-center gap-1 hover:underline">
              <Phone size={14} />
              {customer.contact_info}
            </a>
          ) : (
            "Not provided"
          )}
        </DetailRow>
        <DetailRow label="Sale by">
          <span className="inline-flex items-center gap-1">
            <UserRound size={14} />
            {saleAgent?.full_name || saleAgent?.username || "Unknown"}
          </span>
        </DetailRow>
      </DetailSection>

      <DetailSection title="Pallets">
        {stop.pallets.length === 0 ? (
          <p className="text-muted-foreground">No pallets created for this order yet.</p>
        ) : (
          <>
            <p className="mb-2 text-xs text-muted-foreground">
              {stop.pallets.length} pallet{stop.pallets.length === 1 ? "" : "s"} · {totals.products} product{totals.products === 1 ? "" : "s"} · {totals.units} units
            </p>
            <ul className="space-y-2">
              {stop.pallets.map((pallet, palletIndex) => (
                <li key={pallet.id} className="rounded-lg border border-border bg-card p-3">
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-semibold text-foreground">Pallet {palletIndex + 1}</span>
                    <span className="rounded-full border border-border px-2 py-0.5 text-xs font-medium text-muted-foreground">{palletStatusLabel(pallet.status)}</span>
                  </div>
                  <ul className="mt-2 divide-y divide-border">
                    {pallet.items.map((item) => (
                      <li key={item.id} className="flex items-center justify-between gap-3 py-1.5">
                        <span className="min-w-0 truncate text-foreground">
                          {item.product?.name ?? "Unknown product"}
                          {item.product?.sku && <span className="text-xs text-muted-foreground"> · {item.product.sku}</span>}
                        </span>
                        <span className="shrink-0 font-semibold text-foreground">{item.qty_units} units</span>
                      </li>
                    ))}
                  </ul>
                </li>
              ))}
            </ul>
          </>
        )}
      </DetailSection>

      <DetailSection title="Invoice & payment">
        <DetailRow label="Invoice">{invoiceLabel}</DetailRow>
        <DetailRow label="Invoice total">₱{Number(stop.invoice?.total_amount ?? 0).toLocaleString(undefined, { minimumFractionDigits: 2 })}</DetailRow>
        {stop.status === "completed" && stop.outstanding_amount != null && stop.outstanding_amount > 0 && stop.outstanding_amount < Number(stop.invoice?.total_amount ?? 0) && (
          <DetailRow label="Remaining balance">₱{stop.outstanding_amount.toLocaleString(undefined, { minimumFractionDigits: 2 })}</DetailRow>
        )}
        <DetailRow label="Payment">
          {stop.status === "completed"
            ? stop.is_paid
              ? `Paid${stop.payment_method ? ` · ${stop.payment_method.replace("_", " ")}` : ""}`
              : stop.outstanding_amount != null && stop.invoice && stop.outstanding_amount < Number(stop.invoice.total_amount ?? 0)
                ? `Partially paid${stop.payment_method ? ` · ${stop.payment_method.replace("_", " ")}` : ""}`
                : "Not paid · recorded in Accounts Receivable"
            : "Collect on delivery"}
        </DetailRow>
      </DetailSection>

      {onShowOnMap && (
        <Button onClick={onShowOnMap} className="flex items-center gap-2">
          <MapPin size={16} /> Show on map
        </Button>
      )}
    </div>
  );
}
