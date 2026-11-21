import { ChevronRight } from "lucide-react";
import { Customer, Pallet, formatCustomerAddress } from "@shared/api";
import { Table } from "@/components/ui/table";
import { compareNewestFirst } from "@/components/SortableHeader";
import { cn } from "@/lib/utils";
import { formatMoney, palletStatusLabels, palletStatusStyles, palletTotal } from "./palletUtils";

export interface PalletEntry {
  pallet: Pallet;
  customer: Customer | null;
}

interface PalletTableProps {
  entries: PalletEntry[];
  onSelect: (palletId: string) => void;
  checkedIds: Set<string>;
  onSetChecked: (palletIds: string[], checked: boolean) => void;
}

export function PalletStatusBadge({ status }: { status: Pallet["status"] }) {
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-semibold capitalize",
        palletStatusStyles[status]
      )}
    >
      {palletStatusLabels[status]}
    </span>
  );
}

export function PalletTable({ entries, onSelect, checkedIds, onSetChecked }: PalletTableProps) {
  const entryIds = entries.map(({ pallet }) => pallet.id);
  const checkedCount = entryIds.filter((id) => checkedIds.has(id)).length;
  const allChecked = entryIds.length > 0 && checkedCount === entryIds.length;

  return (
    <div className="overflow-x-auto rounded-xl border border-border bg-card shadow-sm">
      <Table>
        <thead>
          <tr className="border-b border-border bg-muted text-left text-xs text-muted-foreground">
            <th className="w-10 px-4 py-3">
              <input
                type="checkbox"
                aria-label="Select all pallets in this table"
                checked={allChecked}
                ref={(el) => {
                  if (el) el.indeterminate = checkedCount > 0 && !allChecked;
                }}
                onChange={() => onSetChecked(entryIds, !allChecked)}
                className="h-4 w-4 cursor-pointer accent-accent-2"
              />
            </th>
            <th className="whitespace-nowrap px-4 py-3 font-semibold">Pallet</th>
            <th className="whitespace-nowrap px-4 py-3 font-semibold">Customer &amp; delivery address</th>
            <th className="whitespace-nowrap px-4 py-3 text-right font-semibold">Contents</th>
            <th className="whitespace-nowrap px-4 py-3 text-right font-semibold">Total value</th>
            <th className="whitespace-nowrap px-4 py-3 font-semibold">Status</th>
            <th className="px-4 py-3" />
          </tr>
        </thead>
        <tbody>
          {[...entries].sort((a, b) => compareNewestFirst(a.pallet, b.pallet)).map(({ pallet, customer }) => {
            const items = pallet.items ?? [];
            const units = items.reduce((sum, item) => sum + item.qty_units, 0);
            const productCount = new Set(items.map((item) => item.product_id)).size;

            return (
              <tr
                key={pallet.id}
                onClick={() => onSelect(pallet.id)}
                className="cursor-pointer border-b border-border last:border-0 transition hover:bg-accent/60"
              >
                <td className="px-4 py-3" onClick={(event) => event.stopPropagation()}>
                  <input
                    type="checkbox"
                    aria-label={`Select pallet ${pallet.id.substring(0, 8)}`}
                    checked={checkedIds.has(pallet.id)}
                    onChange={() => onSetChecked([pallet.id], !checkedIds.has(pallet.id))}
                    className="h-4 w-4 cursor-pointer accent-accent-2"
                  />
                </td>
                <td className="px-4 py-3">
                  <p className="font-semibold text-foreground">Pallet {pallet.id.substring(0, 8)}</p>
                  <p className="text-xs text-muted-foreground">Order {(pallet.order_id ?? "").substring(0, 8)}</p>
                </td>
                <td className="px-4 py-3">
                  {customer ? (
                    <>
                      <p className="font-medium text-foreground">{customer.store_name}</p>
                      <p className="text-xs text-muted-foreground">{formatCustomerAddress(customer)}</p>
                    </>
                  ) : (
                    <p className="text-muted-foreground">Unknown customer</p>
                  )}
                </td>
                <td className="px-4 py-3 text-right">
                  <p className="font-medium tabular-nums text-foreground">{productCount} product{productCount === 1 ? "" : "s"}</p>
                  <p className="text-xs text-muted-foreground tabular-nums">{units} units</p>
                </td>
                <td className="px-4 py-3 text-right font-semibold tabular-nums text-foreground">
                  {formatMoney(palletTotal(pallet))}
                </td>
                <td className="px-4 py-3">
                  <PalletStatusBadge status={pallet.status} />
                </td>
                <td className="px-4 py-3 text-muted-foreground">
                  <ChevronRight size={18} />
                </td>
              </tr>
            );
          })}
        </tbody>
      </Table>
    </div>
  );
}
