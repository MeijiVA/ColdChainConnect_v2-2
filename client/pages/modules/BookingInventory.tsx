import { Input } from "@/components/ui/input";
import { PageDialog } from "@/components/shared/PageDialog";
import { toast } from "sonner";
import { useState, useEffect } from "react";
import { useSearchParams } from "react-router-dom";
import { LoadingSpinner } from "@/components/LoadingSpinner";
import { useAutoRefresh } from "@/hooks/useAutoRefresh";
import { Package, Printer } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Pallet, Booking, Customer, Product, Truck, Invoice, Delivery, DeliveryItem, InventoryBatch, formatCustomerAddress } from "@shared/api";
import { useAuth } from "../../hooks/useAuth";
import { useCan } from "@/hooks/useCan";
import { PalletStats } from "@/components/pallets/PalletStats";
import { PalletToolbar, PalletStatusFilter } from "@/components/pallets/PalletToolbar";
import { PalletTable, PalletEntry } from "@/components/pallets/PalletTable";
import { PalletDetail } from "@/components/pallets/PalletDetail";
import { DeliverySheet, DeliverySheetSection } from "@/components/pallets/DeliverySheet";
import { DatePresetFilter, isInDatePreset } from "@/components/pallets/palletUtils";
import { confirmAction } from "@/lib/confirm";

type DeliveryWithItems = Delivery & { delivery_items?: DeliveryItem[] };

const nextPalletStatus: Partial<Record<Pallet["status"], Pallet["status"]>> = {
  draft: "prepared",
  prepared: "approved",
  approved: "shipped",
};

export function BookingInventory() {
  const [searchParams] = useSearchParams();
  const [pallets, setPallets] = useState<Pallet[]>([]);
  const [bookings, setBookings] = useState<Booking[]>([]);
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [products, setProducts] = useState<Product[]>([]);
  const [trucks, setTrucks] = useState<Truck[]>([]);
  const [deliveries, setDeliveries] = useState<DeliveryWithItems[]>([]);
  const [invoices, setInvoices] = useState<Invoice[]>([]);
  const [batches, setBatches] = useState<InventoryBatch[]>([]);
  const [sheetSections, setSheetSections] = useState<DeliverySheetSection[] | null>(null);
  const [checkedPalletIds, setCheckedPalletIds] = useState<Set<string>>(() => new Set());
  const [isLoading, setIsLoading] = useState(true);
  const [searchQuery, setSearchQuery] = useState(searchParams.get("order") ?? "");
  const [selectedPalletId, setSelectedPalletId] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState<PalletStatusFilter>("all");
  const [truckFilter, setTruckFilter] = useState("all");
  const [customerFilter, setCustomerFilter] = useState("all");
  const [datePreset, setDatePreset] = useState<DatePresetFilter>("all");
  const [isUpdatingStatus, setIsUpdatingStatus] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const { token, user } = useAuth();
  const canUpdatePalletStatus = useCan("pallet:updateStatus");
  const isAdmin = user?.role === "admin";

  const fetchAll = async () => {
    try {
      const [batchRes, pRes, bRes, cRes, prRes, tRes, dRes, iRes] = await Promise.all([
        fetch("/api/inventory-batches", { headers: { Authorization: `Bearer ${token}` } }),
        fetch("/api/pallets", { headers: { Authorization: `Bearer ${token}` } }),
        fetch("/api/bookings", { headers: { Authorization: `Bearer ${token}` } }),
        fetch("/api/customers", { headers: { Authorization: `Bearer ${token}` } }),
        fetch("/api/products", { headers: { Authorization: `Bearer ${token}` } }),
        fetch("/api/trucks", { headers: { Authorization: `Bearer ${token}` } }),
        fetch("/api/deliveries", { headers: { Authorization: `Bearer ${token}` } }),
        fetch("/api/invoices", { headers: { Authorization: `Bearer ${token}` } }),
      ]);

      const failedCount = [batchRes, pRes, bRes, cRes, prRes, tRes, dRes, iRes].filter((res) => !res.ok).length;
      setLoadError(
        failedCount > 0
          ? `${failedCount} of 8 data sources failed to load, so some pallet details may be missing.`
          : null
      );

      if (batchRes.ok) setBatches(await batchRes.json());
      if (pRes.ok) setPallets(await pRes.json());
      if (bRes.ok) setBookings(await bRes.json());
      if (cRes.ok) setCustomers(await cRes.json());
      if (prRes.ok) setProducts(await prRes.json());
      if (tRes.ok) setTrucks(await tRes.json());
      if (dRes.ok) setDeliveries(await dRes.json());
      if (iRes.ok) setInvoices(await iRes.json());
    } catch (err) {
      console.error("Error loading data:", err);
      setLoadError("Could not load pallet tracking data. Try refreshing.");
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    if (token) fetchAll();
  }, [token]);
  useAutoRefresh(fetchAll, { enabled: Boolean(token) });

  const handleStatusChange = async (palletId: string, status: Pallet["status"]) => {
    setIsUpdatingStatus(true);
    try {
      const res = await fetch(`/api/pallets/${palletId}/status`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ status }),
      });
      if (!res.ok) {
        const errorData = await res.json();
        throw new Error(errorData.error || "Failed to update pallet status");
      }
      const updated: Pallet & { invoice_pending_reason?: string } = await res.json();
      if (updated.invoice_pending_reason) toast.warning(updated.invoice_pending_reason);
      setPallets((prev) => prev.map((p) => (p.id === updated.id ? updated : p)));
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to update pallet status");
    } finally {
      setIsUpdatingStatus(false);
    }
  };

  const invoicedBookingIds = new Set(invoices.map((invoice) => invoice.booking_id));
  const canAdvancePallet = (pallet: Pallet) => {
    const next = nextPalletStatus[pallet.status];
    return Boolean(next) && (next !== "shipped" || invoicedBookingIds.has(pallet.order_id));
  };

  const handleAdvanceAll = async () => {
    const eligible = visiblePallets.filter(canAdvancePallet);
    if (!eligible.length) return;

    const skippedCount = visiblePallets.filter((pallet) => nextPalletStatus[pallet.status] && !canAdvancePallet(pallet)).length;
    const shippingNote = eligible.some((pallet) => pallet.status === "approved") ? " In-transit pallets will be marked shipped." : "";
    const skippedNote = skippedCount ? ` ${skippedCount} in-transit pallet${skippedCount === 1 ? " is" : "s are"} skipped until the order has an invoice.` : "";
    if (!(await confirmAction(`Advance ${eligible.length} pallet${eligible.length === 1 ? "" : "s"} to the next status?${shippingNote}${skippedNote}`))) return;

    setIsUpdatingStatus(true);
    let advanced = 0;
    const failures = new Set<string>();
    const pendingReasons = new Set<string>();
    try {
      for (const pallet of eligible) {
        const res = await fetch(`/api/pallets/${pallet.id}/status`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
          body: JSON.stringify({ status: nextPalletStatus[pallet.status] }),
        });
        const data = await res.json();
        if (!res.ok) {
          failures.add(data.error || "Failed to update pallet status");
          continue;
        }
        advanced += 1;
        if (data.invoice_pending_reason) pendingReasons.add(data.invoice_pending_reason);
        setPallets((prev) => prev.map((p) => (p.id === data.id ? data : p)));
      }
    } finally {
      setIsUpdatingStatus(false);
    }

    if (advanced) toast.success(`Advanced ${advanced} pallet${advanced === 1 ? "" : "s"}`);
    pendingReasons.forEach((reason) => toast.warning(reason));
    failures.forEach((message) => toast.error(message));
  };

  const getProductName = (productId: string) =>
    products.find((p) => p.id === productId)?.name || productId;

  const entries: PalletEntry[] = pallets.map((pallet) => {
    const order = bookings.find((b) => b.id === pallet.order_id);
    const customer = order ? order.customer ?? customers.find((c) => c.id === order.customer_id) ?? null : null;
    return { pallet, customer };
  });

  const filteredEntries = entries.filter(({ pallet, customer }) => {
    if (statusFilter !== "all" && pallet.status !== statusFilter) return false;
    if (!isInDatePreset(pallet.created_at, datePreset)) return false;
    if (customerFilter !== "all" && customer?.id !== customerFilter) return false;

    const query = searchQuery.trim().toLowerCase();
    if (!query) return true;

    return [
      pallet.id,
      pallet.order_id,
      customer?.store_name,
      customer ? formatCustomerAddress(customer) : undefined,
    ].some((value) => value?.toLowerCase().includes(query));
  });

  const truckByBookingId = new Map<string, string>();
  for (const delivery of deliveries) {
    for (const item of delivery.delivery_items ?? []) {
      const invoice = invoices.find((inv) => inv.id === item.invoice_id);
      if (invoice && !truckByBookingId.has(invoice.booking_id)) {
        truckByBookingId.set(invoice.booking_id, delivery.truck_id);
      }
    }
  }

  const truckIdFor = (pallet: Pallet) => pallet.truck_id ?? truckByBookingId.get(pallet.order_id);

  const palletGroups: { truck: Truck | null; entries: PalletEntry[] }[] = [
    ...[...trucks]
      .sort((a, b) => (a.license_plate ?? "").localeCompare(b.license_plate ?? ""))
      .map((truck) => ({
        truck,
        entries: filteredEntries.filter(({ pallet }) => truckIdFor(pallet) === truck.id),
      })),
    { truck: null, entries: filteredEntries.filter(({ pallet }) => !truckIdFor(pallet)) },
  ].filter((group) => group.entries.length > 0);

  const customerOptions = [
    { value: "all", label: "All customers" },
    ...Array.from(
      new Map(
        entries.flatMap(({ customer }) => (customer ? [[customer.id, customer.store_name] as const] : [])),
      ),
    )
      .sort((a, b) => a[1].localeCompare(b[1]))
      .map(([value, label]) => ({ value, label })),
  ];

  const truckOptions = [
    { value: "all", label: "All trucks" },
    ...[...trucks]
      .sort((a, b) => (a.license_plate ?? "").localeCompare(b.license_plate ?? ""))
      .map((truck) => ({ value: truck.id, label: `${truck.license_plate} · ${truck.district}` })),
    { value: "unassigned", label: "Unassigned" },
  ];

  const visiblePalletGroups = palletGroups.filter(
    (group) => truckFilter === "all" || (group.truck?.id ?? "unassigned") === truckFilter
  );

  const visiblePallets = visiblePalletGroups.flatMap((group) => group.entries.map(({ pallet }) => pallet));

  const advanceableCount = visiblePallets.filter(canAdvancePallet).length;

  const selected = entries.find((entry) => entry.pallet.id === selectedPalletId) ?? null;
  const selectedDelivery = selected
    ? deliveries.find((delivery) =>
        (delivery.delivery_items ?? []).some((item) =>
          invoices.some((invoice) => invoice.id === item.invoice_id && invoice.booking_id === selected.pallet.order_id),
        ),
      ) ?? null
    : null;
  const selectedTruck = selected
    ? trucks.find((truck) => truck.id === (selected.pallet.truck_id ?? selectedDelivery?.truck_id)) ?? null
    : null;

  const checkedPallets = visiblePallets.filter((pallet) => checkedPalletIds.has(pallet.id));

  const buildSheetSections = (palletList: Pallet[]): DeliverySheetSection[] =>
    bookings.flatMap((order) => {
      const orderPallets = palletList.filter((pallet) => pallet.order_id === order.id);
      return orderPallets.length ? [{ order, pallets: orderPallets }] : [];
    });

  const setChecked = (palletIds: string[], checked: boolean) =>
    setCheckedPalletIds((current) => {
      const next = new Set(current);
      for (const id of palletIds) {
        if (checked) next.add(id);
        else next.delete(id);
      }
      return next;
    });

  const openShippingLabels = () => setSheetSections(buildSheetSections(checkedPallets));

  if (isLoading) return <LoadingSpinner />;




  return (
    <>

    <div className="flex-1 flex flex-col gap-6 p-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="page-title">Pallet Tracking</h1>
          <p className="page-subtitle">Track the status, contents, and value of every pallet</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {canUpdatePalletStatus && advanceableCount > 0 && (
            <Button onClick={() => void handleAdvanceAll()} disabled={isUpdatingStatus} variant="default">
              {isUpdatingStatus ? "Advancing…" : `Advance ${advanceableCount} to next status`}
            </Button>
          )}
          {isAdmin && (
            <Button
              onClick={openShippingLabels}
              disabled={checkedPallets.length === 0}
              title={checkedPallets.length === 0 ? "Select pallets to print their shipping labels" : undefined}
              variant="outline"
            >
              <Printer size={16} /> Shipping label ({checkedPallets.length})
            </Button>
          )}
        </div>
      </div>

      {loadError && (
        <div className="rounded-lg border border-warning/30 bg-warning-soft p-3 text-sm text-warning">{loadError}</div>
      )}

      <PalletStats pallets={visiblePallets} />

      {selected ? (
        <PalletDetail
          pallet={selected.pallet}
          order={bookings.find((b) => b.id === selected.pallet.order_id) ?? null}
          customer={selected.customer}
          delivery={selectedDelivery}
          truck={selectedTruck}
          batches={batches}
          getProductName={getProductName}
          canChangeStatus={canUpdatePalletStatus}
          onStatusChange={(status) => handleStatusChange(selected.pallet.id, status)}
          onPrintSheet={() =>
            setSheetSections(
              buildSheetSections(pallets.filter((pallet) => pallet.order_id === selected.pallet.order_id)),
            )
          }
          isUpdatingStatus={isUpdatingStatus}
          onBack={() => setSelectedPalletId(null)}
        />
      ) : (
        <>
          <PalletToolbar
            searchQuery={searchQuery}
            onSearchChange={setSearchQuery}
            statusFilter={statusFilter}
            onStatusChange={setStatusFilter}
            customerOptions={customerOptions}
            customerFilter={customerFilter}
            onCustomerChange={setCustomerFilter}
            truckOptions={truckOptions}
            truckFilter={truckFilter}
            onTruckChange={setTruckFilter}
            datePreset={datePreset}
            onDatePresetChange={setDatePreset}
          />

          {filteredEntries.length === 0 ? (
            <div className="rounded-xl border border-dashed border-border bg-card p-10 text-center text-muted-foreground">
              <Package size={32} className="mx-auto mb-2 opacity-40" />
              <p>
                {pallets.length === 0
                  ? "No pallets created yet. Create pallets in the Preparation module."
                  : "No pallets match your search or filter."}
              </p>
            </div>
          ) : (
            <div className="flex flex-col gap-6">
              {visiblePalletGroups.length === 0 && (
                <div className="rounded-xl border border-dashed border-border bg-card p-10 text-center text-muted-foreground">
                  No pallets for this truck.
                </div>
              )}
              {visiblePalletGroups.map((group) => (
                <section key={group.truck?.id ?? "unassigned"} className="space-y-2">
                  <div className="flex flex-wrap items-baseline justify-between gap-2">
                    <div>
                      <h2 className="font-semibold text-foreground">{group.truck?.license_plate ?? "Unassigned"}</h2>
                      <p className="text-xs text-muted-foreground">{group.truck?.district ?? "Pallets not yet on a truck"}</p>
                    </div>
                    <span className="text-sm text-muted-foreground">
                      {group.entries.length} pallet{group.entries.length === 1 ? "" : "s"}
                    </span>
                  </div>
                  <PalletTable
                    entries={group.entries}
                    onSelect={setSelectedPalletId}
                    checkedIds={checkedPalletIds}
                    onSetChecked={setChecked}
                  />
                </section>
              ))}
            </div>
          )}
        </>
      )}

    </div>
  
      {sheetSections && (
        <PageDialog onClose={() => setSheetSections(null)}>
          <DeliverySheet sections={sheetSections} batches={batches} />
        </PageDialog>
      )}
    </>
  );
}
