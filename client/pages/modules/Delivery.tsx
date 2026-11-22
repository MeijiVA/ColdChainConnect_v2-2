import { NativeSelect } from "@/components/ui/native-select";
import { PageDialog } from "@/components/shared/PageDialog";
import { DeliveryPaymentPrompt } from "@/components/shared/DeliveryPaymentPrompt";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from "@/components/ui/accordion";
import { toast } from "sonner";
import { confirmAction } from "@/lib/confirm";
import React, { useState, useEffect, useCallback } from "react";
import { Link } from "react-router-dom";
import { useAuth } from "../../hooks/useAuth";
import { useCan } from "@/hooks/useCan";
import { Table } from "@/components/ui/table";
import { LoadingSpinner } from "@/components/LoadingSpinner";
import { StatusBadge, StatusTone } from "@/components/StatusBadge";
import { localScheduleDate } from "@/lib/agentSchedule";
import { useAutoRefresh } from "@/hooks/useAutoRefresh";
import { CalendarDays, Clock3, ChevronLeft, Truck as TruckIcon, ChevronDown, ChevronUp, Search, X } from "lucide-react";
import { Delivery, DeliveryItem, Truck, Invoice, Customer, Driver, Agent, Pallet, Product, formatCustomerAddress } from "@shared/api";
import { TruckLoad, TruckLoadStop } from "@/components/delivery/TruckLoad";

// ─── Extended types ────────────────────────────────────────────────────────────

interface DeliveryItemExt extends DeliveryItem {
  completed_at?: string;
  receipt_number?: string;
  invoice?: Invoice;
  customer?: Customer;
}

interface DeliveryExt extends Delivery {
  delivery_items: DeliveryItemExt[];
  truck?: Truck;
  driver?: Driver | null;
  agent?: Agent | null;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function authHeaders(token: string) {
  return { "Content-Type": "application/json", Authorization: `Bearer ${token}` };
}

function statusBadgeClass(status: string) {
  return (
    status === "completed"  ? "badge-green" :
    status === "in_transit" ? "badge-gold"  :
    "badge-blue"
  );
}

function statusLabel(status: string) {
  return status === "in_transit" ? "In Transit" :
         status === "completed"  ? "Completed"  : "Pending";
}

function runStatusTone(status: string): StatusTone {
  return status === "completed" ? "success" : status === "in_transit" ? "info" : "warning";
}

function invoiceStatusTone(status: string): StatusTone {
  return status === "paid" ? "success" : "warning";
}

function hasUnpaidInvoice(item: DeliveryItemExt) {
  return Boolean(item.invoice) && item.invoice!.payment_status !== "paid";
}

function StopTitle({ item }: { item: DeliveryItemExt }) {
  const name = item.customer?.store_name ?? item.destination_customer_id.slice(0, 8);
  const orderId = item.invoice?.booking_id;
  if (!orderId) return <>{name}</>;
  return (
    <Link
      to={`/booking-dispatch/inventory?order=${encodeURIComponent(orderId)}`}
      title="View this order's pallets"
      className="hover:underline"
    >
      {name}
    </Link>
  );
}

function UnpaidBadge({ item, className }: { item: DeliveryItemExt; className?: string }) {
  if (!hasUnpaidInvoice(item)) return null;
  return <StatusBadge label={item.invoice!.payment_status === "partial" ? "Partially paid" : "Unpaid"} tone="danger" className={className} />;
}

function formatRunDate(delivery: Delivery) {
  if (!delivery.scheduled_date) return new Date(delivery.created_at).toLocaleDateString("en-PH");
  const [year, month, day] = delivery.scheduled_date.split("-").map(Number);
  return new Date(year, month - 1, day).toLocaleDateString("en-PH");
}

function formatRunTime(value?: string | null) {
  if (!value) return "Time not set";
  const [hours, minutes] = value.split(":").map(Number);
  return new Intl.DateTimeFormat("en", { hour: "numeric", minute: "2-digit" }).format(new Date(2000, 0, 1, hours, minutes));
}

function agentLabel(agent: Agent) {
  return agent.full_name || agent.user?.username || agent.id.slice(0, 8);
}

function truckStatusLabel(status: string) {
  return status === "in_transit" ? "In Transit" :
         status === "maintenance" ? "Maintenance" : "Available";
}

// ─── Main Component ────────────────────────────────────────────────────────────

export function DeliveryDispatch() {
  const { token } = useAuth();
  const canUpdateDelivery = useCan("delivery:update");
  const canConfirmDelivery = useCan("delivery:confirm");
  const canManageTrucks = useCan("truck:manage");

  const [trucks,      setTrucks]      = useState<Truck[]>([]);
  const [drivers,     setDrivers]     = useState<Driver[]>([]);
  const [agents,      setAgents]      = useState<Agent[]>([]);
  const [deliveries,  setDeliveries]  = useState<DeliveryExt[]>([]);
  const [invoices,    setInvoices]    = useState<Invoice[]>([]);
  const [customers,   setCustomers]   = useState<Customer[]>([]);
  const [pallets,     setPallets]     = useState<Pallet[]>([]);
  const [products,    setProducts]    = useState<Product[]>([]);
  const [loading,     setLoading]     = useState(true);
  const [error,       setError]       = useState<string | null>(null);

  const [selectedTruck,        setSelectedTruck]        = useState<Truck | null>(null);
  const [selectedDelivery,     setSelectedDelivery]     = useState<DeliveryExt | null>(null);
  const [scheduleSearch, setScheduleSearch] = useState("");
  const [scheduleFromDate, setScheduleFromDate] = useState("");
  const [scheduleDriverFilter, setScheduleDriverFilter] = useState("all");
  const [scheduleAgentFilter, setScheduleAgentFilter] = useState("all");
  const [schedulePaymentFilter, setSchedulePaymentFilter] = useState<"all" | "unpaid">("all");
  const [showAddTruckModal,    setShowAddTruckModal]    = useState(false);
  const [showEditTruckModal,   setShowEditTruckModal]   = useState(false);
  const [showAddDeliveryModal, setShowAddDeliveryModal] = useState(false);
  const [showChangeTruckDriverModal, setShowChangeTruckDriverModal] = useState(false);
  const [showPaymentModal,     setShowPaymentModal]     = useState(false);
  const [paymentItem,          setPaymentItem]          = useState<{ delivery: DeliveryExt; item: DeliveryItemExt } | null>(null);
  const [confirmingItem,       setConfirmingItem]       = useState<string | null>(null);
  const [showChangeTruckAgentModal, setShowChangeTruckAgentModal] = useState(false);

  // Mobile: track which "panel" is visible — "trucks" | "detail"
  const [mobileView, setMobileView] = useState<"trucks" | "detail">("trucks");

  // ── Fetch ──────────────────────────────────────────────────────────────────
  const fetchAll = useCallback(async () => {
    if (!token) return;
    try {
      const [truckRes, driverRes, agentRes, deliveryRes, invoiceRes, customerRes, palletRes, productRes] = await Promise.all([
        fetch("/api/trucks",     { headers: { Authorization: `Bearer ${token}` } }),
        fetch("/api/drivers",    { headers: { Authorization: `Bearer ${token}` } }),
        fetch("/api/agents",     { headers: { Authorization: `Bearer ${token}` } }),
        fetch("/api/deliveries", { headers: { Authorization: `Bearer ${token}` } }),
        fetch("/api/invoices",   { headers: { Authorization: `Bearer ${token}` } }),
        fetch("/api/customers",  { headers: { Authorization: `Bearer ${token}` } }),
        fetch("/api/pallets",    { headers: { Authorization: `Bearer ${token}` } }),
        fetch("/api/products",   { headers: { Authorization: `Bearer ${token}` } }),
      ]);

      const [trucksData, driversData, agentsData, deliveriesData, invoicesData, customersData, palletsData, productsData] = await Promise.all([
        truckRes.ok    ? truckRes.json()    : [],
        driverRes.ok   ? driverRes.json()   : [],
        agentRes.ok    ? agentRes.json()    : [],
        deliveryRes.ok ? deliveryRes.json() : [],
        invoiceRes.ok  ? invoiceRes.json()  : [],
        customerRes.ok ? customerRes.json() : [],
        palletRes.ok   ? palletRes.json()   : [],
        productRes.ok  ? productRes.json()  : [],
      ]);

      setPallets(palletsData);
      setProducts(productsData);
      setTrucks(trucksData);
      setDrivers(driversData);
      setAgents(agentsData);
      setInvoices(invoicesData);
      setCustomers(customersData);

      const joined: DeliveryExt[] = (deliveriesData as DeliveryExt[]).map((d) => ({
        ...d,
        truck: (trucksData as Truck[]).find((t) => t.id === d.truck_id),
        driver: d.driver ?? (driversData as Driver[]).find((driver) => driver.id === d.driver_id) ?? null,
        agent: d.agent ?? (agentsData as Agent[]).find((agent) => agent.id === d.agent_id) ?? null,
        delivery_items: (d.delivery_items ?? []).map((item) => ({
          ...item,
          invoice:  (invoicesData  as Invoice[]).find((inv) => inv.id === item.invoice_id),
          customer: (customersData as Customer[]).find((c)   => c.id   === item.destination_customer_id),
        })),
      }));
      setDeliveries(joined);

      setSelectedTruck((current) => current ? (trucksData as Truck[]).find((truck) => truck.id === current.id) ?? null : null);
      setSelectedDelivery((current) => current ? joined.find((delivery) => delivery.id === current.id) ?? null : null);
      setError(null);
    } catch {
      setError("Failed to load data. Check your connection.");
    } finally {
      setLoading(false);
    }
  }, [token]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { fetchAll(); }, [fetchAll]);
  useAutoRefresh(fetchAll, { enabled: Boolean(token) });

  const truckDeliveries = selectedTruck
    ? deliveries.filter((d) => d.truck_id === selectedTruck.id)
    : [];
  const truckAgent = selectedTruck?.agent_id
    ? agents.find((agent) => agent.id === selectedTruck.agent_id) ?? null
    : null;
  const scheduleQuery = scheduleSearch.trim().toLowerCase();
  const filteredTruckDeliveries = truckDeliveries.filter((delivery) => {
    const driverId = delivery.driver_id ?? delivery.driver?.id ?? delivery.truck?.driver_id ?? "";
    const scheduledDate = delivery.scheduled_date ?? localScheduleDate(new Date(delivery.created_at));
    const matchesSearch = !scheduleQuery || [
      delivery.id,
      delivery.agent?.full_name,
      delivery.driver?.full_name,
      ...delivery.delivery_items.flatMap((item) => [item.receipt_number, item.customer?.store_name, item.invoice?.receipt_number]),
    ].some((value) => value?.toLowerCase().includes(scheduleQuery));
    return matchesSearch &&
      (!scheduleFromDate || scheduledDate >= scheduleFromDate) &&
      (scheduleDriverFilter === "all" || driverId === scheduleDriverFilter) &&
      (schedulePaymentFilter === "all" || delivery.delivery_items.some(hasUnpaidInvoice)) &&
      (scheduleAgentFilter === "all" || (delivery.agent_id ?? delivery.agent?.id) === scheduleAgentFilter);
  });
  const sortedScheduleDays = [...filteredTruckDeliveries.reduce((groups, delivery) => {
    const date = delivery.scheduled_date ?? localScheduleDate(new Date(delivery.created_at));
    groups.set(date, [...(groups.get(date) ?? []), delivery]);
    return groups;
  }, new Map<string, DeliveryExt[]>()).entries()]
    .sort(([a], [b]) => b.localeCompare(a))
    .map(([date, runs]) => [date, [...runs].sort((a, b) => (a.scheduled_time ?? "").localeCompare(b.scheduled_time ?? ""))] as const);

  const productNames = new Map(products.map((product) => [product.id, product.name]));
  const truckLoadStops: TruckLoadStop[] = truckDeliveries
    .filter((delivery) => delivery.status !== "completed")
    .flatMap((delivery) => delivery.delivery_items
      .filter((item) => item.status !== "completed")
      .map((item) => ({
        id: item.id,
        orderId: item.invoice?.booking_id ?? "",
        customerName: item.customer?.store_name ?? item.destination_customer_id.slice(0, 8),
        receipt: item.invoice?.receipt_number,
        runLabel: `${formatRunDate(delivery)} · ${formatRunTime(delivery.scheduled_time)}`,
        pallets: item.invoice ? pallets.filter((pallet) => pallet.order_id === item.invoice!.booking_id) : [],
      })));

  const handleConfirm = (delivery: DeliveryExt, item: DeliveryItemExt) => {
    setPaymentItem({ delivery, item });
    setShowPaymentModal(true);
  };

  const handleConfirmWithPayment = async (isPaid: boolean, paymentAmount?: number, paymentMethod?: string, paymentReference?: string, paymentId?: string, notes?: string) => {
    if (!token || !paymentItem) return;
    const { delivery, item } = paymentItem;
    setConfirmingItem(item.id);
    try {
      const res = await fetch(
        `/api/deliveries/${delivery.id}/items/${item.id}/confirm`,
        {
          method: "POST",
          headers: authHeaders(token),
          body: JSON.stringify({
            is_paid: isPaid,
            payment_amount: paymentAmount,
            payment_method: paymentMethod,
            payment_reference: paymentReference,
            payment_id: paymentId,
            notes,
          })
        }
      );
      if (!res.ok) throw new Error(await res.text());
      await fetchAll();
      setShowPaymentModal(false);
      setPaymentItem(null);
    } catch (err) {
      toast.error("Failed to confirm: " + (err instanceof Error ? err.message : String(err)));
    } finally {
      setConfirmingItem(null);
    }
  };

  const handleCreateDelivery = async (
    destinations: { invoice_id: string; destination_customer_id: string }[],
    driverId: string,
    scheduledDate: string,
    scheduledTime: string,
  ) => {
    if (!token || !selectedTruck) return;
    try {
      const res = await fetch("/api/deliveries", {
        method: "POST",
        headers: authHeaders(token),
        body: JSON.stringify({
          truck_id: selectedTruck.id,
          destinations,
          driver_id: driverId || undefined,
          scheduled_date: scheduledDate,
          scheduled_time: scheduledTime,
        }),
      });
      if (!res.ok) throw new Error(await res.text());
      await fetchAll();
      setShowAddDeliveryModal(false);
    } catch (err) {
      toast.error("Failed to create delivery: " + (err instanceof Error ? err.message : String(err)));
    }
  };

  const handleChangeTruckAgent = async (agentId: string) => {
    if (!token || !selectedTruck) return;
    try {
      const res = await fetch(`/api/trucks/${selectedTruck.id}`, {
        method: "PATCH",
        headers: authHeaders(token),
        body: JSON.stringify({ agent_id: agentId || null }),
      });
      if (!res.ok) throw new Error(await res.text());
      setShowChangeTruckAgentModal(false);
    } catch (err) {
      toast.error("Failed to update agent: " + (err instanceof Error ? err.message : String(err)));
    } finally {
      await fetchAll();
    }
  };

  const handleStartRun = async (deliveryId: string) => {
    if (!token) return;
    try {
      const res = await fetch(`/api/deliveries/${deliveryId}/status`, {
        method: "PATCH",
        headers: authHeaders(token),
        body: JSON.stringify({ status: "in_transit" }),
      });
      if (!res.ok) throw new Error(await res.text());
      await fetchAll();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not start this run.");
    }
  };

  const handleRemoveStop = async (delivery: DeliveryExt, item: DeliveryItemExt) => {
    if (!token) return;
    const name = item.customer?.store_name ?? "this stop";
    if (!(await confirmAction(`Remove ${name} from this run? The order will go back to the unassigned list.`))) return;
    try {
      const res = await fetch(`/api/deliveries/${delivery.id}/items/${item.id}`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) throw new Error(await res.text());
      await fetchAll();
    } catch (err) {
      toast.error("Failed to remove stop: " + (err instanceof Error ? err.message : String(err)));
    }
  };

  const assignedInvoiceIds = new Set(
    deliveries
      .filter((d) => d.status !== "completed")
      .flatMap((d) => d.delivery_items.map((i) => i.invoice_id))
  );
  // Also exclude invoices assigned to completed deliveries
  const completedInvoiceIds = new Set(
    deliveries
      .filter((d) => d.status === "completed")
      .flatMap((d) => d.delivery_items.map((i) => i.invoice_id))
  );
  const eligibleInvoices = invoices.filter(
    (inv) => (inv.status === "issued" || inv.status === "draft") &&
             inv.payment_status === "unpaid" &&
             !assignedInvoiceIds.has(inv.id) &&
             !completedInvoiceIds.has(inv.id)
  );

  const selectTruck = (truck: Truck) => {
    setSelectedTruck(truck);
    setSelectedDelivery(null);
    setShowChangeTruckDriverModal(false);
    setShowChangeTruckAgentModal(false);
    setMobileView("detail");
  };



  // ── Truck detail panel (shared between mobile and desktop) ─────────────────
  const renderDetailPanel = () => (
    <div className="space-y-4">
      {/* Mobile back button */}
      <Button
        onClick={() => setMobileView("trucks")}
        variant="link" className="h-auto p-0 md:hidden mb-1"
      >
        <ChevronLeft size={16} /> All Trucks
      </Button>

      {/* Truck card */}
      <div className="bg-card rounded-xl border border-border p-4 space-y-4">
        <div className="flex items-start justify-between">
          <div>
            <p className="text-xs font-semibold text-muted-foreground">Truck</p>
            <p className="font-rajdhani font-bold text-foreground text-lg mt-0.5">{selectedTruck!.license_plate}</p>
            <p className="text-xs text-muted-foreground">{selectedTruck!.district}</p>
          </div>
          <div className="flex items-center gap-3">
            <span className={`px-2 py-0.5 rounded text-xs font-semibold ${statusBadgeClass(selectedTruck!.status)}`}>
              {truckStatusLabel(selectedTruck!.status)}
            </span>
            {canManageTrucks && (
              <Button onClick={() => setShowEditTruckModal(true)} variant="link" className="h-auto p-0">
                Edit
              </Button>
            )}
          </div>
        </div>

        {/* Driver — assigned to the truck for this run */}
        <div className="border-t border-border pt-3">
          <div className="flex items-center justify-between mb-2">
            <p className="text-xs font-semibold text-muted-foreground">Driver</p>
            {canManageTrucks && (
              <Button
                onClick={() => setShowChangeTruckDriverModal(true)}
                variant="link" className="h-auto p-0"
              >
                {selectedTruck!.driver_id ? "Change" : "Assign"}
              </Button>
            )}
          </div>
          {selectedTruck!.driver_id ? (() => {
            const d = drivers.find((dr) => dr.id === selectedTruck!.driver_id);
            if (loading) return <LoadingSpinner />;

  return (
              <div className="bg-muted rounded-lg p-3">
                <p className="font-semibold text-foreground text-sm">{d?.full_name || selectedTruck!.driver_id.slice(0, 8)}</p>
                {d?.contact_info && <p className="text-xs text-muted-foreground mt-0.5">{d.contact_info}</p>}
                {d?.license      && <p className="text-xs text-muted-foreground mt-0.5">License: {d.license}</p>}
              </div>
            );
          })() : (
            <div className="bg-muted rounded-lg p-3 text-center text-xs text-muted-foreground">No driver assigned</div>
          )}
        </div>

        <div className="border-t border-border pt-3">
          <div className="flex items-center justify-between mb-2">
            <p className="text-xs font-semibold text-muted-foreground">Agent</p>
            {canUpdateDelivery && (
              <Button onClick={() => setShowChangeTruckAgentModal(true)} variant="link" className="h-auto p-0">
                Change Agent
              </Button>
            )}
          </div>
          {truckAgent ? (
            <div className="bg-muted rounded-lg p-3">
              <p className="font-semibold text-foreground text-sm">{agentLabel(truckAgent)}</p>
              <p className="text-xs text-muted-foreground mt-0.5">Takes POS orders for {selectedTruck!.district}</p>
            </div>
          ) : (
            <div className="bg-muted rounded-lg p-3 text-center text-xs text-muted-foreground">No agent assigned</div>
          )}
        </div>

        <Button
          onClick={() => setShowAddDeliveryModal(true)}
          variant="default" className="w-full"
        >
          + Add Delivery
        </Button>
      </div>

      <TruckLoad stops={truckLoadStops} productNames={productNames} />

      <Accordion type="single" collapsible defaultValue="truck-schedule" className="rounded-xl border border-border bg-card px-4">
        <AccordionItem value="truck-schedule" className="border-b-0">
          <AccordionTrigger className="hover:no-underline">
            <span className="flex min-w-0 items-center gap-3">
              <span className="font-rajdhani text-xl font-bold text-foreground">Truck Schedule</span>
              <span className="text-xs font-normal text-muted-foreground">{filteredTruckDeliveries.length} scheduled run{filteredTruckDeliveries.length === 1 ? "" : "s"}</span>
            </span>
          </AccordionTrigger>
          <AccordionContent className="space-y-5 px-0">
            <div className="flex items-center gap-2 overflow-x-auto">
              <div className="relative min-w-[12rem] flex-1">
                <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
                <Input type="search" aria-label="Search truck schedule" placeholder="Search runs, customers, agents…" value={scheduleSearch} onChange={(event) => setScheduleSearch(event.target.value)} className="w-full pl-9" />
              </div>
              <Input type="date" aria-label="Scheduled from date" title="Show runs scheduled from this date" value={scheduleFromDate} onChange={(event) => setScheduleFromDate(event.target.value)} className="w-40 shrink-0" />
              <NativeSelect aria-label="Filter by driver" value={scheduleDriverFilter} onChange={(event) => setScheduleDriverFilter(event.target.value)} className="shrink-0">
                <option value="all">All drivers</option>
                {drivers.map((driver) => <option key={driver.id} value={driver.id}>{driver.full_name || driver.id.slice(0, 8)}</option>)}
              </NativeSelect>
              <NativeSelect aria-label="Filter by agent" value={scheduleAgentFilter} onChange={(event) => setScheduleAgentFilter(event.target.value)} className="shrink-0">
                <option value="all">All agents</option>
                {agents.map((agent) => <option key={agent.id} value={agent.id}>{agent.full_name || agent.user?.username || agent.id.slice(0, 8)}</option>)}
              </NativeSelect>
              <NativeSelect aria-label="Filter by payment" value={schedulePaymentFilter} onChange={(event) => setSchedulePaymentFilter(event.target.value as "all" | "unpaid")} className="shrink-0">
                <option value="all">All payments</option>
                <option value="unpaid">With unpaid orders</option>
              </NativeSelect>
            </div>

            {sortedScheduleDays.length === 0 ? (
          <div className="bg-card rounded-xl border border-border p-6 text-center text-sm text-muted-foreground">
            {truckDeliveries.length === 0 ? "No deliveries scheduled for this truck." : "No runs match your search or filters."}
          </div>
        ) : (
          sortedScheduleDays.map(([date, dayDeliveries]) => (
            <section key={date} className="space-y-3">
              <h3 className="flex items-center gap-2 font-semibold text-foreground">
                <CalendarDays size={16} />
                {formatRunDate(dayDeliveries[0])}
              </h3>
              {dayDeliveries.map((delivery) => (
                <div
                  key={delivery.id}
                  className={`bg-card rounded-xl border-2 overflow-hidden transition ${
                    selectedDelivery?.id === delivery.id ? "border-accent-2" : "border-border"
                  }`}
                >
            {/* Delivery header */}
            <div
              className="flex items-center justify-between px-4 py-3 cursor-pointer hover:bg-accent/50 transition-colors"
              onClick={() => setSelectedDelivery(selectedDelivery?.id === delivery.id ? null : delivery)}
            >
              <div className="flex items-center gap-2 min-w-0">
                <StatusBadge label={statusLabel(delivery.status)} tone={runStatusTone(delivery.status)} className="flex-shrink-0" />
                <span className="font-mono text-xs text-muted-foreground truncate">{delivery.id.slice(0, 8)}…</span>
                <span className="text-xs text-muted-foreground flex-shrink-0">{delivery.delivery_items.length} stop{delivery.delivery_items.length !== 1 ? "s" : ""}</span>
                {delivery.delivery_items.some(hasUnpaidInvoice) && (
                  <StatusBadge label={`${delivery.delivery_items.filter(hasUnpaidInvoice).length} unpaid`} tone="danger" className="flex-shrink-0" />
                )}
              </div>
              <div className="flex items-center gap-2 flex-shrink-0 ml-2">
                <span className="text-xs text-muted-foreground hidden sm:block">
                  {formatRunDate(delivery)} · {formatRunTime(delivery.scheduled_time)}
                </span>
                <Button
                  type="button"
                  size="lg"
                  variant={selectedDelivery?.id === delivery.id ? "default" : "outline"}
                  aria-expanded={selectedDelivery?.id === delivery.id}
                  onClick={(event) => {
                    event.stopPropagation();
                    setSelectedDelivery(selectedDelivery?.id === delivery.id ? null : delivery);
                  }}
                >
                  {selectedDelivery?.id === delivery.id ? "Hide details" : "View details"}
                  {selectedDelivery?.id === delivery.id ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
                </Button>
              </div>
            </div>

            <div className="flex items-center gap-x-4 gap-y-1 px-4 pb-3 flex-wrap text-xs text-muted-foreground">
              <span>Driver: <span className="font-semibold text-foreground">{delivery.driver?.full_name || "Unassigned"}</span></span>
              <span>Agent: <span className="font-semibold text-foreground">{delivery.agent ? agentLabel(delivery.agent) : "Unassigned"}</span></span>
              {delivery.status === "pending" && canUpdateDelivery && (
                <Button
                  type="button"
                  onClick={() => void handleStartRun(delivery.id)}
                  variant="default" size="sm" className="ml-auto"
                >
                  Start run
                </Button>
              )}
            </div>

            {/* Delivery stops — card layout on mobile, table on md+ */}
            {selectedDelivery?.id === delivery.id && (
              <div className="border-t border-border">
                {delivery.delivery_items.length === 0 ? (
                  <p className="px-4 py-4 text-xs text-muted-foreground">No stops assigned yet.</p>
                ) : (
                  <>
                    {/* Mobile: card per stop */}
                    <div className="md:hidden divide-y divide-border">
                      {delivery.delivery_items.map((item) => (
                        <div key={item.id} className="p-4 space-y-2">
                          <div className="flex items-center justify-between">
                            <span className="font-semibold text-foreground text-sm">
                              <StopTitle item={item} />
                            </span>
                            <StatusBadge label={statusLabel(item.status)} tone={runStatusTone(item.status)} />
                          </div>
                          {item.customer && (
                            <p className="text-xs text-muted-foreground">{formatCustomerAddress(item.customer)}</p>
                          )}
                          <div className="flex items-center gap-2 flex-wrap text-xs text-muted-foreground">
                            <span className="font-mono">Invoice: {item.invoice_id.slice(0, 8)}…</span>
                            {item.invoice && (
                              <StatusBadge label={item.invoice.status} tone={invoiceStatusTone(item.invoice.status)} />
                            )}
                            <UnpaidBadge item={item} />
                          </div>
                          {item.receipt_number && (
                            <p className="text-xs text-muted-foreground">Receipt: {item.receipt_number}</p>
                          )}
                          {item.completed_at && (
                            <p className="text-xs text-muted-foreground">
                              Confirmed: {new Date(item.completed_at).toLocaleString("en-PH")}
                            </p>
                          )}
                          {item.status === "completed" ? (
                            <span className="text-xs text-green font-semibold">Done</span>
                          ) : (
                            <>
                              {canConfirmDelivery && (
                                <Button
                                  disabled={confirmingItem === item.id}
                                  onClick={() => handleConfirm(delivery, item)}
                                  variant="success" size="sm" className="w-full mt-1"
                                >
                                  {confirmingItem === item.id ? "Confirming…" : "✓ Confirm Delivery"}
                                </Button>
                              )}
                              {item.status === "pending" && canUpdateDelivery && (
                                <Button
                                  type="button"
                                  onClick={() => void handleRemoveStop(delivery, item)}
                                  variant="danger" size="sm" className="w-full"
                                >
                                  Remove from run
                                </Button>
                              )}
                            </>
                          )}
                        </div>
                      ))}
                    </div>

                    {/* Desktop: table */}
                    <div className="data-table-frame hidden md:block overflow-x-auto">
                      <Table>
                        <thead>
                          <tr>
                            {["Invoice", "Customer", "Status", "Receipt #", "Confirmed At", "Action"].map((h) => (
                              <th key={h} className="bg-navy-mid text-muted-foreground font-semibold text-xs px-3 py-2.5 text-left border-b border-border whitespace-nowrap">
                                {h}
                              </th>
                            ))}
                          </tr>
                        </thead>
                        <tbody>
                          {delivery.delivery_items.map((item) => (
                            <tr key={item.id} className="border-b border-border hover:bg-accent/40 transition-colors">
                              <td className="px-3 py-3 font-mono text-foreground">
                                {item.invoice_id.slice(0, 8)}…
                                {item.invoice && (
                                  <StatusBadge label={item.invoice.status} tone={invoiceStatusTone(item.invoice.status)} className="ml-2" />
                                )}
                              </td>
                              <td className="px-3 py-3 text-foreground font-semibold">
                                <StopTitle item={item} />
                                <UnpaidBadge item={item} className="ml-2" />
                                {item.customer && (
                                  <p className="text-muted-foreground font-normal">{formatCustomerAddress(item.customer)}</p>
                                )}
                              </td>
                              <td className="px-3 py-3 whitespace-nowrap">
                                <StatusBadge label={statusLabel(item.status)} tone={runStatusTone(item.status)} />
                              </td>
                              <td className="px-3 py-3 font-mono text-foreground">
                                {item.receipt_number ?? <span className="text-muted-foreground">—</span>}
                              </td>
                              <td className="px-3 py-3 text-muted-foreground">
                                {item.completed_at
                                  ? new Date(item.completed_at).toLocaleString("en-PH")
                                  : <span className="text-muted-foreground">—</span>
                                }
                              </td>
                              <td className="px-3 py-3">
                                {item.status === "completed" ? (
                                  <span className="text-xs text-green font-semibold">Done</span>
                                ) : (
                                  <div className="flex items-center gap-2">
                                    {canConfirmDelivery && (
                                      <Button
                                        disabled={confirmingItem === item.id}
                                        onClick={() => handleConfirm(delivery, item)}
                                        variant="success" size="sm"
                                      >
                                        {confirmingItem === item.id ? "Confirming…" : "✓ Confirm Delivery"}
                                      </Button>
                                    )}
                                    {item.status === "pending" && canUpdateDelivery && (
                                      <Button
                                        type="button"
                                        onClick={() => void handleRemoveStop(delivery, item)} variant="ghost" size="sm" className="h-8 text-xs text-destructive hover:bg-destructive/10 hover:text-destructive">
                                        Remove
                                      </Button>
                                    )}
                                  </div>
                                )}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </Table>
                    </div>
                  </>
                )}
              </div>
            )}
          </div>
              ))}
            </section>
          ))
        )}
          </AccordionContent>
        </AccordionItem>
      </Accordion>
    </div>
  );











  return (
    <>

    <div className="flex-1 flex flex-col px-4 md:px-6 py-4 md:py-6 gap-4 min-h-0">

      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 flex-shrink-0">
        <div>
          <h1 className="font-rajdhani text-2xl md:text-3xl font-bold text-foreground">Truck Dispatch</h1>
          <p className="text-xs text-muted-foreground mt-0.5">Assign receipts to trucks and track each stop</p>
        </div>
        {canManageTrucks && (
          <div className="flex gap-2">
            <Button
              onClick={() => setShowAddTruckModal(true)}
              variant="default"
            >
              + Add Truck
            </Button>
          </div>
        )}
      </div>

      {error && (
        <div className="rounded-lg border border-red/30 bg-red/10 px-4 py-2 text-xs text-red flex-shrink-0">
          {error}
        </div>
      )}

      {/* ── Mobile: stacked (trucks list OR detail) ── */}
      <div className="md:hidden flex-1 overflow-y-auto">
        {mobileView === "trucks" ? (
          <div className="space-y-3">
            <p className="text-xs font-semibold text-muted-foreground">Trucks</p>
            {trucks.length === 0 ? (
              <p className="text-sm text-muted-foreground">No trucks registered yet.</p>
            ) : (
              trucks.map((truck) => {
                const td = deliveries.filter((d) => d.truck_id === truck.id);
                return (
                  <div
                    key={truck.id}
                    onClick={() => selectTruck(truck)}
                    className="bg-card rounded-xl border-2 border-border p-4 cursor-pointer active:bg-muted transition-colors flex items-center justify-between"
                  >
                    <div className="flex items-center gap-3">
                      <div className="w-10 h-10 rounded-full bg-primary/10 flex items-center justify-center flex-shrink-0">
                        <TruckIcon size={18} className="text-foreground" />
                      </div>
                      <div>
                        <p className="font-rajdhani font-bold text-foreground">{truck.license_plate}</p>
                        <p className="text-xs text-muted-foreground">{truck.district}</p>
                        <p className="text-xs text-muted-foreground mt-0.5">{td.length} scheduled run{td.length === 1 ? "" : "s"}</p>
                      </div>
                    </div>
                    <div className="flex flex-col items-end gap-1">
                      <span className={`px-2 py-0.5 rounded text-xs font-semibold ${statusBadgeClass(truck.status)}`}>
                        {truckStatusLabel(truck.status)}
                      </span>
                      <ChevronLeft size={14} className="text-muted-foreground rotate-180" />
                    </div>
                  </div>
                );
              })
            )}
          </div>
        ) : (
          selectedTruck && renderDetailPanel()
        )}
      </div>

      {/* ── Desktop: side-by-side ── */}
      <div className="hidden md:flex gap-5 flex-1 min-h-0 overflow-hidden">
        {/* Truck list */}
        <div className="w-64 lg:w-72 flex-shrink-0 overflow-y-auto space-y-3 pr-1">
          <p className="text-xs font-semibold text-muted-foreground">Trucks</p>
          {trucks.length === 0 ? (
            <p className="text-xs text-muted-foreground">No trucks registered yet.</p>
          ) : (
            trucks.map((truck) => {
              const td = deliveries.filter((d) => d.truck_id === truck.id);
              const isSelected = selectedTruck?.id === truck.id;
              return (
                <div
                  key={truck.id}
                  onClick={() => selectTruck(truck)}
                  className={`bg-card rounded-xl border-2 p-4 cursor-pointer transition hover:shadow-md ${
                    isSelected ? "border-accent-2 shadow-md" : "border-border"
                  }`}
                >
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <p className="font-rajdhani font-bold text-foreground leading-tight truncate">{truck.license_plate}</p>
                      <p className="text-xs text-muted-foreground mt-0.5">{truck.district}</p>
                    </div>
                    <span className={`px-2 py-0.5 rounded text-xs font-semibold flex-shrink-0 ${statusBadgeClass(truck.status)}`}>
                      {truckStatusLabel(truck.status)}
                    </span>
                  </div>
                  <p className="text-xs text-muted-foreground mt-2">
                    {td.length} scheduled run{td.length === 1 ? "" : "s"}
                  </p>
                </div>
              );
            })
          )}
        </div>

        {/* Detail panel */}
        <div className="flex-1 overflow-y-auto">
          {!selectedTruck ? (
            <div className="flex items-center justify-center h-full text-sm text-muted-foreground gap-2">
              <TruckIcon size={18} className="opacity-40" />
              Select a truck to view its deliveries
            </div>
          ) : (
            renderDetailPanel()
          )}
        </div>
      </div>

    </div>
  
      {(showAddTruckModal) && (
        <PageDialog onClose={() => setShowAddTruckModal(false)}>
<AddTruckModal
      drivers={drivers}
      token={token!}
      onClose={() => setShowAddTruckModal(false)}
      onCreated={async () => { await fetchAll(); setShowAddTruckModal(false); }}
    />
        </PageDialog>
      )}
      {(showEditTruckModal && selectedTruck) && (
        <PageDialog onClose={() => setShowEditTruckModal(false)}>
<EditTruckModal
      truck={selectedTruck}
      token={token!}
      onClose={() => setShowEditTruckModal(false)}
      onSaved={async () => { await fetchAll(); setShowEditTruckModal(false); }}
    />
        </PageDialog>
      )}
      {(showChangeTruckDriverModal && selectedTruck) && (
        <PageDialog onClose={() => setShowChangeTruckDriverModal(false)}>
<ChangeTruckDriverModal
      truck={selectedTruck}
      drivers={drivers}
      token={token!}
      onClose={() => setShowChangeTruckDriverModal(false)}
      onSave={async (driverId) => {
        try {
          const res = await fetch(`/api/trucks/${selectedTruck.id}`, {
            method: "PATCH",
            headers: authHeaders(token!),
            body: JSON.stringify({ driver_id: driverId || null }),
          });
          if (!res.ok) throw new Error(await res.text());
          await fetchAll();
          setShowChangeTruckDriverModal(false);
        } catch (err) {
          toast.error("Failed to update driver: " + (err instanceof Error ? err.message : String(err)));
        }
      }}
    />
        </PageDialog>
      )}
      {(showChangeTruckAgentModal && selectedTruck) && (
        <PageDialog onClose={() => setShowChangeTruckAgentModal(false)}>
          <ChangeTruckAgentModal
            truck={selectedTruck}
            agents={agents}
            currentAgentId={selectedTruck.agent_id ?? ""}
            onClose={() => setShowChangeTruckAgentModal(false)}
            onSave={handleChangeTruckAgent}
          />
        </PageDialog>
      )}
      {(showAddDeliveryModal && selectedTruck) && (
        <PageDialog onClose={() => setShowAddDeliveryModal(false)}>
<AddDeliveryModal
      truck={selectedTruck}
      eligibleInvoices={eligibleInvoices}
      customers={customers}
      agents={agents}
      drivers={drivers}
      truckDeliveries={truckDeliveries}
      onClose={() => setShowAddDeliveryModal(false)}
      onSave={handleCreateDelivery}
    />
        </PageDialog>
      )}
      {(showPaymentModal && paymentItem) && (
        <PageDialog onClose={() => { setShowPaymentModal(false); setPaymentItem(null); }} label="Confirm delivery">
          <DeliveryPaymentPrompt
            stop={{
              destination_customer: { store_name: paymentItem.item.customer?.store_name ?? "Customer" },
              invoice: paymentItem.item.invoice ?? null,
            }}
            mode="confirm"
            isConfirming={confirmingItem === paymentItem.item.id}
            onClose={() => { setShowPaymentModal(false); setPaymentItem(null); }}
            onConfirm={handleConfirmWithPayment}
          />
        </PageDialog>
      )}
    </>
  );
}

// ─── Change Truck Driver Modal ────────────────────────────────────────────────
function ChangeTruckDriverModal({ truck, drivers, token, onClose, onSave }: {
  truck: Truck; drivers: Driver[]; token: string; onClose: () => void; onSave: (id: string) => Promise<void>;
}) {
  const [selectedDriverId, setSelectedDriverId] = useState(truck.driver_id || "");
  const [saving, setSaving] = useState(false);

  const handleSave = async () => {
    setSaving(true);
    try { await onSave(selectedDriverId); }
    finally { setSaving(false); }
  };

  return (
    <ModalShell title={`Assign Driver — ${truck.license_plate}`} onClose={onClose}>
      <div>
        <label htmlFor="delivery-select-driver" className="block text-xs font-semibold text-foreground mb-2">Select Driver</label>
        <NativeSelect id="delivery-select-driver"
          value={selectedDriverId}
          onChange={(e) => setSelectedDriverId(e.target.value)}
          className="w-full"
        >
          <option value="">No driver assigned</option>
          {drivers.filter((d) => d.is_active).map((d) => (
            <option key={d.id} value={d.id}>
              {d.full_name || d.id.slice(0, 8)}
              {d.license      ? ` · ${d.license}`      : ""}
              {d.contact_info ? ` — ${d.contact_info}` : ""}
            </option>
          ))}
        </NativeSelect>

        {/* Preview card for the selected driver */}
        {selectedDriverId && (() => {
          const d = drivers.find((dr) => dr.id === selectedDriverId);
          return d ? (
            <div className="mt-3 bg-muted rounded-lg p-3 text-xs space-y-0.5">
              <p className="font-semibold text-foreground text-sm">{d.full_name || "—"}</p>
              {d.contact_info && <p className="text-muted-foreground"><span className="sr-only">Contact: </span>{d.contact_info}</p>}
              {d.license && <p className="text-muted-foreground">License {d.license}</p>}
              {d.employment_type && (
                <p className="text-muted-foreground capitalize">{d.employment_type.replace("_", " ")}</p>
              )}
            </div>
          ) : null;
        })()}
      </div>
      <div className="flex justify-end gap-2 pt-4 border-t border-border">
        <Button onClick={onClose} variant="outline">
          Cancel
        </Button>
        <Button
          onClick={handleSave}
          disabled={saving}
          variant="default"
        >
          {saving ? "Saving…" : "Save Driver"}
        </Button>
      </div>
    </ModalShell>
  );
}

// ─── Change Truck Agent Modal ─────────────────────────────────────────────────
function ChangeTruckAgentModal({ truck, agents, currentAgentId, onClose, onSave }: {
  truck: Truck; agents: Agent[]; currentAgentId: string; onClose: () => void; onSave: (agentId: string) => Promise<void>;
}) {
  const [selectedAgentId, setSelectedAgentId] = useState(currentAgentId);
  const [saving, setSaving] = useState(false);

  const handleSave = async () => {
    setSaving(true);
    try { await onSave(selectedAgentId); }
    finally { setSaving(false); }
  };

  return (
    <ModalShell title={`Assign Agent — ${truck.license_plate}`} onClose={onClose}>
      <div>
        <div className="rounded-lg bg-muted px-3 py-2.5">
          <p className="text-xs font-semibold text-muted-foreground">Current agent</p>
          <p className="mt-1 text-sm font-semibold text-foreground">
            {(() => { const a = agents.find((x) => x.id === currentAgentId); return a ? agentLabel(a) : "No agent assigned"; })()}
          </p>
        </div>
        <label htmlFor="truck-select-agent" className="mt-3 block text-xs font-semibold text-foreground mb-2">Select Agent</label>
        <NativeSelect id="truck-select-agent"
          value={selectedAgentId}
          onChange={(e) => setSelectedAgentId(e.target.value)}
          className="w-full"
        >
          <option value="">Unassigned</option>
          {agents.filter((agent) => agent.is_active || agent.id === currentAgentId).map((agent) => (
            <option key={agent.id} value={agent.id}>{agentLabel(agent)}</option>
          ))}
        </NativeSelect>
        <p className="mt-3 text-xs text-muted-foreground">
          Only changes who can place POS orders for {truck.district}, and who new orders from this district are credited to.
          Existing runs and schedules are not changed.
        </p>
      </div>
      <div className="flex justify-end gap-2 pt-4 border-t border-border">
        <Button onClick={onClose} variant="outline">
          Cancel
        </Button>
        <Button
          onClick={handleSave}
          disabled={saving}
          variant="default"
        >
          {saving ? "Saving…" : "Save Agent"}
        </Button>
      </div>
    </ModalShell>
  );
}

// ─── Add New Truck Modal ──────────────────────────────────────────────────────

const PLATE_PATTERN = /^[A-Z]{3} \d{3,4}$/;

function AddTruckModal({ drivers, token, onClose, onCreated }: {
  drivers: Driver[]; token: string; onClose: () => void; onCreated: () => Promise<void>;
}) {
  const [licensePlate, setLicensePlate]     = useState("");
  const [truckDistrict, setTruckDistrict]   = useState("");
  const [selectedDriverId, setSelectedDriverId] = useState("");
  const [truckStatus, setTruckStatus]       = useState<"available" | "in_transit" | "maintenance">("available");
  const [saving, setSaving]                 = useState(false);

  const handleSave = async () => {
    if (!PLATE_PATTERN.test(licensePlate) || !truckDistrict) { toast.error("Enter a license plate like ABC 1234 and a district."); return; }
    setSaving(true);
    try {
      const res = await fetch("/api/trucks", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ license_plate: licensePlate, district: truckDistrict, driver_id: selectedDriverId || undefined, status: truckStatus }),
      });
      if (!res.ok) throw new Error(await res.text());
      await onCreated();
    } catch (err) {
      toast.error("Failed to add truck: " + (err instanceof Error ? err.message : String(err)));
    } finally {
      setSaving(false);
    }
  };

  return (
    <ModalShell title="Add New Truck" onClose={onClose}>
      <div className="space-y-4">
        {[
          { label: "License Plate *", value: licensePlate, onChange: (v: string) => setLicensePlate(v.toUpperCase()), placeholder: "e.g., ABC 1234" },
          { label: "District *",   value: truckDistrict, onChange: setTruckDistrict, placeholder: "e.g., Metro Manila" },
        ].map(({ label, value, onChange, placeholder }) => (
          <div key={label}>
            <label className="block text-xs font-semibold text-foreground mb-1">{label}</label>
            <Input type="text" value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder}
              className="w-full" />
          </div>
        ))}
        <div>
          <label htmlFor="delivery-status" className="block text-xs font-semibold text-foreground mb-1">Status</label>
          <NativeSelect id="delivery-status" value={truckStatus} onChange={(e) => setTruckStatus(e.target.value as any)}
            className="w-full">
            <option value="available">Available</option>
            <option value="in_transit">In Transit</option>
            <option value="maintenance">Maintenance</option>
          </NativeSelect>
        </div>
        <div>
          <label htmlFor="delivery-assign-driver-optional" className="block text-xs font-semibold text-foreground mb-1">Assign Driver (Optional)</label>
          <NativeSelect id="delivery-assign-driver-optional" value={selectedDriverId} onChange={(e) => setSelectedDriverId(e.target.value)}
            className="w-full">
            <option value="">No agent assigned</option>
            {drivers.filter((d) => d.is_active).map((d) => (
              <option key={d.id} value={d.id}>{d.full_name || d.id.slice(0, 8)}{d.contact_info && ` — ${d.contact_info}`}</option>
            ))}
          </NativeSelect>
        </div>
      </div>
      <div className="flex justify-end gap-2 pt-4 border-t border-border">
        <Button onClick={onClose} variant="outline">Cancel</Button>
        <Button onClick={handleSave} disabled={!PLATE_PATTERN.test(licensePlate) || !truckDistrict || saving}
          variant="default">
          {saving ? "Adding…" : "Add Truck"}
        </Button>
      </div>
    </ModalShell>
  );
}

// ─── Edit Truck Modal ─────────────────────────────────────────────────────────

function EditTruckModal({ truck, token, onClose, onSaved }: {
  truck: Truck; token: string; onClose: () => void; onSaved: () => Promise<void>;
}) {
  const [licensePlate, setLicensePlate]   = useState(truck.license_plate);
  const [truckDistrict, setTruckDistrict] = useState(truck.district);
  const [inMaintenance, setInMaintenance] = useState(truck.status === "maintenance");
  const [saving, setSaving]               = useState(false);

  const handleSave = async () => {
    if (!PLATE_PATTERN.test(licensePlate) || !truckDistrict) { toast.error("Enter a license plate like ABC 1234 and a district."); return; }
    setSaving(true);
    try {
      const res = await fetch(`/api/trucks/${truck.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ license_plate: licensePlate, district: truckDistrict, status: inMaintenance ? "maintenance" : "available" }),
      });
      if (!res.ok) throw new Error(await res.text());
      await onSaved();
    } catch (err) {
      toast.error("Failed to update truck: " + (err instanceof Error ? err.message : String(err)));
    } finally {
      setSaving(false);
    }
  };

  return (
    <ModalShell title={`Edit Truck — ${truck.license_plate}`} onClose={onClose}>
      <div className="space-y-4">
        {[
          { label: "License Plate *", value: licensePlate, onChange: (v: string) => setLicensePlate(v.toUpperCase()), placeholder: "e.g., ABC 1234" },
          { label: "District *", value: truckDistrict, onChange: setTruckDistrict, placeholder: "e.g., Metro Manila" },
        ].map(({ label, value, onChange, placeholder }) => (
          <div key={label}>
            <label className="block text-xs font-semibold text-foreground mb-1">{label}</label>
            <Input type="text" value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder}
              className="w-full" />
          </div>
        ))}
        <label className="flex items-center gap-2 text-sm text-foreground">
          <input type="checkbox" checked={inMaintenance} onChange={(e) => setInMaintenance(e.target.checked)} />
          Under maintenance
        </label>
        <p className="text-xs text-muted-foreground">Status is otherwise automatic: In Transit while a delivery run is in transit, otherwise Available.</p>
      </div>
      <div className="flex justify-end gap-2 pt-4 border-t border-border">
        <Button onClick={onClose} variant="outline">Cancel</Button>
        <Button onClick={handleSave} disabled={!PLATE_PATTERN.test(licensePlate) || !truckDistrict || saving}
          variant="default">
          {saving ? "Saving…" : "Save Changes"}
        </Button>
      </div>
    </ModalShell>
  );
}

// ─── Add Delivery Modal ────────────────────────────────────────────────────────

function AddDeliveryModal({ truck, eligibleInvoices, customers, agents, drivers, truckDeliveries, onClose, onSave }: {
  truck: Truck;
  eligibleInvoices: Invoice[];
  customers: Customer[];
  agents: Agent[];
  drivers: Driver[];
  truckDeliveries: DeliveryExt[];
  onClose: () => void;
  onSave: (d: { invoice_id: string; destination_customer_id: string }[], driverId: string, scheduledDate: string, scheduledTime: string) => Promise<void>;
}) {
  const [stops, setStops] = useState([{ invoice_id: "" }]);
  const [showExistingRuns, setShowExistingRuns] = useState(false);
  const [orderSearch, setOrderSearch] = useState("");
  const [orderDate, setOrderDate] = useState(() => localScheduleDate(new Date()));
  const [selectedDriverId, setSelectedDriverId] = useState(truck.driver_id ?? "");
  const [scheduledDate, setScheduledDate] = useState(() => localScheduleDate(new Date()));
  const [scheduledTime, setScheduledTime] = useState("09:00");
  const [saving, setSaving] = useState(false);

  function customerFor(inv: Invoice): Customer | undefined {
    return inv.booking?.customer ?? customers.find((c) => c.store_name === inv.customer_name);
  }

  const districtInvoices = eligibleInvoices.filter((inv) => customerFor(inv)?.district === truck.district);
  const selectedInvoices = stops.map((stop) => districtInvoices.find((invoice) => invoice.id === stop.invoice_id)).filter((invoice): invoice is Invoice => Boolean(invoice));
  const saleOwnerIds = new Set(selectedInvoices.map((invoice) => invoice.agent_id));
  const saleOwnerId = saleOwnerIds.size === 1 ? [...saleOwnerIds][0] : null;
  const saleAgent = agents.find((agent) => agent.user_id === saleOwnerId);

  // Build a label for each eligible invoice: "Store Name — Contact Person"
  function orderLabel(inv: Invoice): string {
    const customer = customerFor(inv);
    const storeName    = inv.customer_name    || customer?.store_name    || inv.id.slice(0, 8).toUpperCase();
    const contactPerson = customer?.contact_person || "";
    return contactPerson ? `${storeName} — ${contactPerson}` : storeName;
  }

  // Given an invoice, resolve the destination_customer_id
  function resolveCustomerId(inv: Invoice): string {
    return customerFor(inv)?.id ?? "";
  }

  const addStop    = () => setStops((s) => [...s, { invoice_id: "" }]);
  const removeStop = (i: number) => setStops((s) => s.filter((_, idx) => idx !== i));
  const updateStop = (i: number, invoice_id: string) =>
    setStops((s) => s.map((stop, idx) => idx === i ? { invoice_id } : stop));

  // Build the final payload: resolve customer from the selected invoice
  const buildPayload = () =>
    stops.map((s) => {
      const inv = districtInvoices.find((i) => i.id === s.invoice_id);
      return {
        invoice_id: s.invoice_id,
        destination_customer_id: inv ? resolveCustomerId(inv) : "",
      };
    });

  const valid = saleOwnerIds.size <= 1 && stops.every((s) => {
    if (!s.invoice_id) return false;
    const inv = districtInvoices.find((i) => i.id === s.invoice_id);
    if (!inv) return false;
    return !!resolveCustomerId(inv);
  });

  // Already-picked invoice ids (to prevent duplicates within modal)
  const pickedIds = new Set(stops.map((s) => s.invoice_id).filter(Boolean));

  const normalizedOrderSearch = orderSearch.trim().toLowerCase();
  const orderSearchText = (inv: Invoice) => {
    const customer = customerFor(inv);
    return [
      inv.customer_name,
      customer?.store_name,
      customer?.contact_person,
      customer && formatCustomerAddress(customer),
      inv.customer_address,
      inv.receipt_number,
    ].filter(Boolean).join(" ").toLowerCase();
  };
  const orderDateOf = (inv: Invoice) => localScheduleDate(new Date(inv.created_at));
  const pickerInvoices = districtInvoices.filter((inv) =>
    (!orderDate || orderDateOf(inv) === orderDate) &&
    (!normalizedOrderSearch || normalizedOrderSearch.split(/\s+/).every((term) => orderSearchText(inv).includes(term)))
  );
  const matchingStops = orderDate ? pickerInvoices.filter((inv) => !pickedIds.has(inv.id)) : [];
  const matchingAgentId = saleOwnerId ?? matchingStops[0]?.agent_id;
  const matchingStopsForRun = matchingStops.filter((inv) => inv.agent_id === matchingAgentId);
  const otherMatchingAgentCount = matchingStops.length - matchingStopsForRun.length;
  const addMatchingStops = () => setStops((current) => [
    ...current.filter((stop) => stop.invoice_id),
    ...matchingStopsForRun.map((inv) => ({ invoice_id: inv.id })),
  ]);

  const handleSave = async () => {
    if (!valid || !scheduledDate || !scheduledTime) { toast.error("Choose a scheduled date and time and valid order stops."); return; }
    setSaving(true);
    try { await onSave(buildPayload(), selectedDriverId, scheduledDate, scheduledTime); }
    finally { setSaving(false); }
  };

  return (
    <ModalShell title={`Add Delivery — ${truck.license_plate}`} onClose={onClose}>
      {showExistingRuns && <ExistingRunsDialog deliveries={truckDeliveries} customers={customers} onClose={() => setShowExistingRuns(false)} />}
      <div className="space-y-3">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <label className="block text-xs font-semibold text-foreground">
            Scheduled Date *
            <Input
              type="date"
              value={scheduledDate}
              onChange={(event) => setScheduledDate(event.target.value)}
              className="mt-1 w-full"
            />
          </label>
          <label className="block text-xs font-semibold text-foreground">
            Scheduled Time *
            <Input
              type="time"
              value={scheduledTime}
              onChange={(event) => setScheduledTime(event.target.value)}
              className="mt-1 w-full"
            />
          </label>
        </div>
        <div className="rounded-lg bg-muted px-3 py-2.5">
          <p className="text-xs font-semibold text-muted-foreground">Sale owner · automatically assigned</p>
          <p className="mt-1 text-sm font-semibold text-foreground">{saleAgent?.full_name || (saleOwnerId ? "No linked agent profile" : "Select an order")}</p>
          {saleOwnerIds.size > 1 && <p className="mt-1 text-xs text-red">One delivery run can include sales from only one agent.</p>}
        </div>
        <div>
          <label htmlFor="delivery-assign-driver-optional-2" className="block text-xs font-semibold text-foreground mb-1">Assign Driver (Optional)</label>
          <NativeSelect id="delivery-assign-driver-optional-2"
            value={selectedDriverId}
            onChange={(event) => setSelectedDriverId(event.target.value)}
            className="w-full"
          >
            <option value="">No driver assigned</option>
            {drivers.filter((driver) => driver.is_active).map((driver) => (
              <option key={driver.id} value={driver.id}>
                {driver.full_name || driver.id.slice(0, 8)}{driver.id === truck.driver_id ? " · truck default" : ""}
              </option>
            ))}
          </NativeSelect>
        </div>

        <div className="rounded-lg border border-border bg-card p-3 space-y-2">
          <div className="flex flex-wrap items-center gap-2">
            <Input
              type="search"
              value={orderSearch}
              onChange={(event) => setOrderSearch(event.target.value)}
              aria-label="Search orders"
              placeholder="Search store, contact, address, receipt"
              className="min-w-0 flex-1"
            />
            <Input
              type="date"
              value={orderDate}
              onChange={(event) => setOrderDate(event.target.value)}
              aria-label="Filter orders by date"
              
            />
          </div>
          <div className="flex items-center justify-between text-xs text-muted-foreground">
            <span>Showing {pickerInvoices.length} of {districtInvoices.length} orders</span>
            {(orderSearch || orderDate) && (
              <Button onClick={() => { setOrderSearch(""); setOrderDate(localScheduleDate(new Date())); }} variant="link" className="h-auto p-0">Clear</Button>
            )}
          </div>
          <Button
            onClick={addMatchingStops}
            disabled={!orderDate || matchingStopsForRun.length === 0}
            variant="default" size="sm" className="w-full"
          >
            {orderDate
              ? `Add all delivery stops for ${new Date(`${orderDate}T00:00:00`).toLocaleDateString("en-PH")} (${matchingStopsForRun.length})`
              : "Choose a date to add delivery stops"}
          </Button>
          {otherMatchingAgentCount > 0 && (
            <p className="text-xs text-muted-foreground">{otherMatchingAgentCount} matching orders belong to other agents and need a separate run.</p>
          )}
        </div>

        <div className="flex items-center justify-between">
          <label className="text-xs font-semibold text-foreground">Delivery Stops *</label>
          <div className="flex items-center gap-3">
            <Button onClick={() => setShowExistingRuns(true)} variant="link" className="h-auto p-0">View existing deliveries</Button>
            <Button onClick={addStop} variant="link" className="h-auto p-0">+ Add Stop</Button>
          </div>
        </div>
        {stops.map((stop, i) => {
          const selectedInv = districtInvoices.find((inv) => inv.id === stop.invoice_id);
          const resolvedCustomer = selectedInv ? customerFor(selectedInv) : null;
          const stopOptions = selectedInv && !pickerInvoices.includes(selectedInv) ? [selectedInv, ...pickerInvoices] : pickerInvoices;
          return (
            <div key={i} className="bg-muted rounded-lg p-3 space-y-2">
              <div className="flex items-center justify-between">
                <p className="text-xs font-semibold text-foreground">Stop {i + 1}</p>
                {stops.length > 1 && (
                  <Button onClick={() => removeStop(i)} type="button" variant="ghost" size="sm" className="h-8 gap-1 text-xs text-destructive hover:bg-destructive/10 hover:text-destructive"><X size={14} aria-hidden="true" /> Remove</Button>
                )}
              </div>

              <div>
                <label className="block text-xs text-muted-foreground mb-1">Order (Customer — Contact)</label>
                <NativeSelect
                  value={stop.invoice_id}
                  onChange={(e) => updateStop(i, e.target.value)}
                  className="w-full"
                >
                  <option value="">Select order…</option>
                  {stopOptions.map((inv) => {
                    const disabled = pickedIds.has(inv.id) && inv.id !== stop.invoice_id;
                    return (
                      <option key={inv.id} value={inv.id} disabled={disabled}>
                        {orderLabel(inv)}
                        {" "}· {inv.receipt_number || inv.id.slice(0, 8).toUpperCase()}
                      </option>
                    );
                  })}
                </NativeSelect>
              </div>

              {/* Preview card once an order is selected */}
              {selectedInv && (
                <div className="text-xs text-muted-foreground bg-card rounded-md px-3 py-2 border border-border space-y-0.5">
                  <p className="font-semibold text-foreground">
                    {resolvedCustomer?.store_name || selectedInv.customer_name || "—"}
                  </p>
                  {resolvedCustomer?.contact_person && (
                    <p>Contact: {resolvedCustomer.contact_person}</p>
                  )}
                  {(resolvedCustomer ? formatCustomerAddress(resolvedCustomer) : selectedInv.customer_address) && (
                    <p>{resolvedCustomer ? formatCustomerAddress(resolvedCustomer) : selectedInv.customer_address}</p>
                  )}
                  <p className="font-mono pt-0.5">
                    Receipt: {selectedInv.receipt_number || selectedInv.id.slice(0, 8).toUpperCase()}
                  </p>
                  {!resolvedCustomer && (
                    <p className="text-red font-semibold">Customer record not found — cannot add stop</p>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>
      <div className="flex justify-end gap-2 pt-4 border-t border-border">
        <Button onClick={onClose} variant="outline">Cancel</Button>
        <Button onClick={handleSave} disabled={!valid || saving}
          variant="default">
          {saving ? "Saving…" : "Add Delivery"}
        </Button>
      </div>
    </ModalShell>
  );
}

function ExistingRunsDialog({ deliveries, customers, onClose }: { deliveries: DeliveryExt[]; customers: Customer[]; onClose: () => void }) {
  const sorted = [...deliveries].sort((a, b) =>
    (b.scheduled_date ?? "").localeCompare(a.scheduled_date ?? "") ||
    (a.scheduled_time ?? "").localeCompare(b.scheduled_time ?? ""),
  );
  return (
    <PageDialog onClose={onClose} label="Existing deliveries">
      <div className="p-5 space-y-3">
        <h2 className="font-rajdhani text-xl font-bold text-foreground">Existing deliveries</h2>
        {sorted.length === 0 ? (
          <p className="text-sm text-muted-foreground">No deliveries are scheduled for this truck.</p>
        ) : (
          <ul className="space-y-2">
            {sorted.map((delivery) => (
              <li key={delivery.id} className="rounded-lg border border-border bg-muted px-3 py-2.5">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="text-sm font-semibold text-foreground">{formatRunDate(delivery)} · {formatRunTime(delivery.scheduled_time)}</span>
                  <StatusBadge label={statusLabel(delivery.status)} tone={runStatusTone(delivery.status)} />
                </div>
                <p className="mt-1 text-xs text-muted-foreground">
                  {delivery.delivery_items.length} stop{delivery.delivery_items.length === 1 ? "" : "s"}
                  {delivery.delivery_items.length > 0 && `: ${delivery.delivery_items.map((item) => customers.find((customer) => customer.id === item.destination_customer_id)?.store_name ?? "Unknown customer").join(", ")}`}
                </p>
              </li>
            ))}
          </ul>
        )}
      </div>
    </PageDialog>
  );
}

// ─── Modal Shell ──────────────────────────────────────────────────────────────

function ModalShell({ title, onClose, children }: {
  title: string; onClose: () => void; children: React.ReactNode;
}) {
  return (
    <div className="flex-1 flex flex-col gap-6 p-6">
      <div className="page-header">
        <div>
          <h1 className="page-title">{title}</h1>
        </div>
      </div>
      <div className="max-w-2xl w-full bg-card rounded-xl border border-border p-5 space-y-4">{children}</div>
    </div>
  );
}
