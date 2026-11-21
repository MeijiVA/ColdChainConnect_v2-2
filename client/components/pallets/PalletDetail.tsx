import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Button } from "@/components/ui/button";
import { confirmAction } from "@/lib/confirm";
import { Fragment, useState } from "react";
import { ArrowLeft, ChevronDown, ChevronRight, MoreVertical } from "lucide-react";
import { Booking, Customer, Delivery, InventoryBatch, Pallet, Truck, formatCustomerAddress, totalDiscountRate } from "@shared/api";
import { Card } from "@/components/ui/card";
import { Table } from "@/components/ui/table";
import { formatMoney, groupPalletItemsByProduct, palletTotal, palletStatusOptions } from "./palletUtils";
import { PalletStatusBadge } from "./PalletTable";
import { PalletBatchBreakdown } from "./PalletBatchBreakdown";

interface PalletDetailProps {
  pallet: Pallet;
  order: Booking | null;
  customer: Customer | null;
  delivery: Delivery | null;
  truck: Truck | null;
  batches: InventoryBatch[];
  getProductName: (productId: string) => string;
  /** The server only lets admin and agent change a pallet's status; others see the pallet read-only. */
  canChangeStatus: boolean;
  onStatusChange: (status: Pallet["status"]) => void;
  onPrintSheet: () => void;
  isUpdatingStatus: boolean;
  onBack: () => void;
}

function formatDeliveryDate(delivery: Delivery) {
  if (!delivery.scheduled_date) return "Not scheduled";
  const [year, month, day] = delivery.scheduled_date.split("-").map(Number);
  return new Date(year, month - 1, day).toLocaleDateString("en-PH");
}

function formatDeliveryTime(value?: string | null) {
  if (!value) return "Time not set";
  const [hours, minutes] = value.split(":").map(Number);
  return new Intl.DateTimeFormat("en", { hour: "numeric", minute: "2-digit" }).format(new Date(2000, 0, 1, hours, minutes));
}

export function PalletDetail({
  pallet,
  order,
  customer,
  delivery,
  truck,
  batches,
  getProductName,
  canChangeStatus,
  onStatusChange,
  onPrintSheet,
  isUpdatingStatus,
  onBack,
}: PalletDetailProps) {
  const items = pallet.items ?? [];
  const productGroups = groupPalletItemsByProduct(items, batches);
  const units = items.reduce((sum, item) => sum + item.qty_units, 0);
  const discountRate = totalDiscountRate(order?.customer?.discounts);
  const totalValue = palletTotal(pallet);
  const [expandedProductIds, setExpandedProductIds] = useState<Set<string>>(() => new Set());

  const toggleProduct = (productId: string) =>
    setExpandedProductIds((current) => {
      const next = new Set(current);
      if (next.has(productId)) next.delete(productId);
      else next.add(productId);
      return next;
    });
  const statusIndex = palletStatusOptions.findIndex((option) => option.value === pallet.status);
  const nextStatus = palletStatusOptions[statusIndex + 1];
  const previousStatus = statusIndex > 0 ? palletStatusOptions[statusIndex - 1] : undefined;

  const handleRevert = async () => {
    if (!previousStatus) return;
    if (await confirmAction(`Revert this pallet from ${palletStatusOptions[statusIndex].label} to ${previousStatus.label}?`)) {
      onStatusChange(previousStatus.value);
    }
  };

  return (
    <div className="space-y-4">
      <Button
        onClick={onBack}
        variant="link" className="h-auto p-0"
      >
        <ArrowLeft size={16} />
        Back to deliveries
      </Button>

      <Card className="bg-card p-6">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <p className="text-xs font-semibold text-muted-foreground">Pallet</p>
            <h2 className="mt-1 font-mono text-lg font-bold text-foreground">{pallet.id}</h2>
          </div>
          <div className="flex items-center gap-3">
            <PalletStatusBadge status={pallet.status} />
            <Button
              type="button"
              onClick={onPrintSheet}
              disabled={!order}
              variant="outline"
            >
              Shipping label
            </Button>
            {canChangeStatus && <div className="flex items-center gap-2">
              <Button
                type="button"
                disabled={isUpdatingStatus || !nextStatus}
                onClick={() => nextStatus && onStatusChange(nextStatus.value)}
                variant="default"
              >
                {nextStatus ? `Mark as ${nextStatus.label}` : "Completed"}
              </Button>
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button
                    type="button"
                    variant="outline"
                    size="icon"
                    aria-label="More status actions"
                    disabled={isUpdatingStatus || !previousStatus}
                  >
                    <MoreVertical size={16} aria-hidden="true" />
                  </Button>
                </DropdownMenuTrigger>
                {previousStatus && (
                  <DropdownMenuContent align="end" className="w-56">
                    <DropdownMenuItem onSelect={() => void handleRevert()}>
                      Revert to {previousStatus.label}
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                )}
              </DropdownMenu>
            </div>}
          </div>
        </div>

        <div className="mt-6 grid grid-cols-1 gap-6 md:grid-cols-2 xl:grid-cols-4">
          <div>
            <p className="text-xs font-semibold text-muted-foreground">Customer</p>
            <p className="mt-1 font-medium text-foreground">{customer?.store_name ?? "Unknown customer"}</p>
            <p className="mt-3 text-xs font-semibold text-muted-foreground">District</p>
            <p className="mt-1 text-sm text-foreground">{customer?.district ?? "—"}</p>
          </div>
          <div className="md:col-span-1 xl:col-span-2">
            <p className="text-xs font-semibold text-muted-foreground">Delivery address</p>
            <p className="mt-1 text-sm text-foreground">{customer ? formatCustomerAddress(customer) : "—"}</p>
          </div>
          <div>
            <p className="text-xs font-semibold text-muted-foreground">Order</p>
            <p className="mt-1 font-mono text-sm text-foreground">{order?.id ?? pallet.order_id}</p>
            <p className="mt-1 text-xs text-muted-foreground">Created {new Date(pallet.created_at).toLocaleDateString()}</p>
          </div>
        </div>

        <div className="mt-6 grid grid-cols-1 gap-6 md:grid-cols-2 xl:grid-cols-4">
          <div>
            <p className="text-xs font-semibold text-muted-foreground">Delivery date</p>
            <p className="mt-1 text-sm text-foreground">{delivery ? formatDeliveryDate(delivery) : "Not scheduled"}</p>
          </div>
          <div>
            <p className="text-xs font-semibold text-muted-foreground">Delivery time</p>
            <p className="mt-1 text-sm text-foreground">{delivery ? formatDeliveryTime(delivery.scheduled_time) : "—"}</p>
          </div>
          <div>
            <p className="text-xs font-semibold text-muted-foreground">Truck</p>
            <p className="mt-1 text-sm text-foreground">{truck ? `${truck.license_plate} · ${truck.district}` : "Not on a truck"}</p>
          </div>
          <div>
            <p className="text-xs font-semibold text-muted-foreground">Run status</p>
            <p className="mt-1 text-sm capitalize text-foreground">{delivery ? delivery.status.replace("_", " ") : "—"}</p>
          </div>
        </div>
      </Card>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <Card className="overflow-hidden rounded-xl bg-card shadow-sm lg:col-span-2">
          <Table>
            <thead>
              <tr className="border-b border-border bg-muted text-xs text-muted-foreground">
                <th className="px-4 py-3 text-left font-semibold">Product</th>
                <th className="px-4 py-3 text-right font-semibold">Qty</th>
                <th className="whitespace-nowrap px-4 py-3 text-right font-semibold">Unit cost</th>
                <th className="whitespace-nowrap px-4 py-3 text-right font-semibold">Line total</th>
              </tr>
            </thead>
            <tbody>
              {productGroups.map((group) => {
                const isExpanded = expandedProductIds.has(group.productId);
                return (
                  <Fragment key={group.productId}>
                    <tr className="border-b border-border">
                      <td className="px-4 py-3">
                        <button
                          type="button"
                          onClick={() => toggleProduct(group.productId)}
                          aria-expanded={isExpanded}
                          className="flex items-start gap-2 text-left"
                        >
                          {isExpanded ? <ChevronDown size={16} className="mt-0.5 shrink-0" /> : <ChevronRight size={16} className="mt-0.5 shrink-0" />}
                          <span>
                            <span className="block font-medium text-foreground">{getProductName(group.productId)}</span>
                          </span>
                        </button>
                      </td>
                      <td className="px-4 py-3 text-right tabular-nums">{group.qty}</td>
                      <td className="px-4 py-3 text-right tabular-nums text-muted-foreground">{formatMoney(Number(group.unitCost))}</td>
                      <td className="px-4 py-3 text-right font-semibold tabular-nums text-foreground">
                        {formatMoney(group.value)}
                      </td>
                    </tr>
                    {isExpanded && (
                      <tr className="border-b border-border bg-muted/40 last:border-0">
                        <td colSpan={4} className="px-4 py-3 pl-10">
                          <PalletBatchBreakdown lines={group.batches} />
                        </td>
                      </tr>
                    )}
                  </Fragment>
                );
              })}
              {items.length === 0 && (
                <tr>
                  <td colSpan={4} className="px-4 py-8 text-center text-muted-foreground">
                    No items in this pallet.
                  </td>
                </tr>
              )}
            </tbody>
          </Table>
        </Card>

        <Card className="flex flex-col justify-center gap-4 bg-card p-6">
          <div>
            <p className="text-xs font-semibold text-muted-foreground">Total value</p>
            <p className="mt-1 text-3xl font-bold tabular-nums text-foreground">{formatMoney(totalValue)}</p>
          </div>
          {discountRate > 0 && (
            <div className="space-y-1 text-sm">
              <div className="flex justify-between">
                <span className="text-muted-foreground">Customer discount ({Number((discountRate * 100).toFixed(2))}%)</span>
                <span className="tabular-nums text-red">-{formatMoney(totalValue * discountRate)}</span>
              </div>
              <div className="flex justify-between border-t border-border pt-1">
                <span className="font-semibold text-foreground">Net after discount</span>
                <span className="font-bold tabular-nums text-foreground">{formatMoney(totalValue * (1 - discountRate))}</span>
              </div>
            </div>
          )}
          <div className="grid grid-cols-2 gap-4 border-t border-border pt-4">
            <div>
              <p className="text-xs font-semibold text-muted-foreground">Products</p>
              <p className="mt-1 text-lg font-bold tabular-nums text-foreground">{productGroups.length}</p>
            </div>
            <div>
              <p className="text-xs font-semibold text-muted-foreground">Units</p>
              <p className="mt-1 text-lg font-bold tabular-nums text-foreground">{units}</p>
            </div>
          </div>
        </Card>
      </div>
    </div>
  );
}
