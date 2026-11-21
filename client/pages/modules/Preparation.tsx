import { Button } from "@/components/ui/button";
import { TruncatedText } from "@/components/ui/truncated-text";
import { useState, useEffect } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { LoadingSpinner } from "@/components/LoadingSpinner";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Calendar } from "lucide-react";
import { toast } from "sonner";
import { confirmAction } from "@/lib/confirm";
import { TableBulkAction, TableFilterSelect, TableToolbar } from "@/components/TableToolbar";
import { newestFirst } from "@/components/SortableHeader";
import { TablePagination, paginate } from "@/components/TablePagination";
import { Booking, Customer, InventoryBatch, Pallet } from "@shared/api";
import { useAuth } from "../../hooks/useAuth";
import { useCan } from "@/hooks/useCan";
import { useAutoRefresh } from "@/hooks/useAutoRefresh";
import { buildAutomaticPallets, isCompletePick } from "@/lib/automaticPicking";

export function Preparation() {
  const [orders, setOrders] = useState<Booking[]>([]);
  const [pallets, setPallets] = useState<Pallet[]>([]);
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const { token } = useAuth();
  // Same rules as the server: staff may start pallets but only admin and agent move them along, and only admin deletes.
  const canCreatePallets = useCan("pallet:create");
  const canUpdatePalletStatus = useCan("pallet:updateStatus");
  const canDeletePallets = useCan("pallet:delete");
  const navigate = useNavigate();
  const { state } = useLocation();
  const filters = state?.preparationFilters;
  const [searchTerm, setSearchTerm] = useState<string>(filters?.searchTerm ?? "");
  const [statusFilter, setStatusFilter] = useState<"all" | "pending" | "approved" | "prep" | "ready">(filters?.statusFilter ?? "approved");
  const [dateRangeFilter, setDateRangeFilter] = useState<"all" | "today" | "week" | "month" | "custom">(filters?.dateRangeFilter ?? "all");
  const [customDateStart, setCustomDateStart] = useState<string>(filters?.customDateStart ?? "");
  const [customDateEnd, setCustomDateEnd] = useState<string>(filters?.customDateEnd ?? "");
  const [agentFilter, setAgentFilter] = useState<string>(filters?.agentFilter ?? "all");
  const [districtFilter, setDistrictFilter] = useState<string>(filters?.districtFilter ?? "all");
  const [selectedOrderIds, setSelectedOrderIds] = useState<string[]>([]);
  const [page, setPage] = useState(1);

  useEffect(() => {
    setPage(1);
  }, [searchTerm, statusFilter, dateRangeFilter, customDateStart, customDateEnd, agentFilter, districtFilter]);

  const fetchAll = async () => {
    try {
      const responses = await Promise.all([
        fetch("/api/bookings", { headers: { Authorization: `Bearer ${token}` } }),
        fetch("/api/pallets", { headers: { Authorization: `Bearer ${token}` } }),
        fetch("/api/customers", { headers: { Authorization: `Bearer ${token}` } }),
      ]);
      const failedIndex = responses.findIndex((response) => !response.ok);
      if (failedIndex !== -1) {
        const resource = ["orders", "pallets", "customers"][failedIndex];
        throw new Error(`Could not load ${resource} (HTTP ${responses[failedIndex].status}).`);
      }

      const [ordersData, palletsData, customersData] = await Promise.all(
        responses.map((response) => response.json())
      );
      setOrders(ordersData);
      setPallets(palletsData);
      setCustomers(customersData);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Error loading data");
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    if (token) {
      fetchAll();
    }
  }, [token]);
  useAutoRefresh(fetchAll, { enabled: Boolean(token) });

  const isDateInRange = (dateStr: string): boolean => {
    if (dateRangeFilter === "all") return true;

    const orderDate = new Date(dateStr);
    const now = new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const orderDateOnly = new Date(
      orderDate.getFullYear(),
      orderDate.getMonth(),
      orderDate.getDate()
    );

    if (dateRangeFilter === "today") {
      return orderDateOnly.getTime() === today.getTime();
    }

    if (dateRangeFilter === "week") {
      const weekStart = new Date(today);
      weekStart.setDate(today.getDate() - today.getDay());
      const weekEnd = new Date(weekStart);
      weekEnd.setDate(weekStart.getDate() + 6);
      return orderDateOnly >= weekStart && orderDateOnly <= weekEnd;
    }

    if (dateRangeFilter === "month") {
      return (
        orderDate.getFullYear() === now.getFullYear() &&
        orderDate.getMonth() === now.getMonth()
      );
    }

    if (dateRangeFilter === "custom") {
      if (!customDateStart || !customDateEnd) return true;
      const start = new Date(customDateStart);
      const end = new Date(customDateEnd);
      end.setHours(23, 59, 59, 999);
      return orderDate >= start && orderDate <= end;
    }

    return true;
  };

  if (isLoading) return <LoadingSpinner className="min-h-[60vh] bg-transparent" slow />;

  const districtOf = (order: Booking): string | null =>
    customers.find((c) => c.id === order.customer_id)?.district ?? null;

  const agentOptions = [...new Map(
    orders.flatMap((order) => (order.creator ? [[order.created_by, order.creator.agent?.full_name || order.creator.username] as const] : [])),
  ).entries()].sort(([, a], [, b]) => a.localeCompare(b));
  const districtOptions = [...new Set(orders.map(districtOf).filter((district): district is string => Boolean(district)))].sort();

  const filtered = newestFirst(orders.filter((order) => {
    const matchesSearch =
      order.id.toLowerCase().includes(searchTerm.toLowerCase()) ||
      order.customer_id.toLowerCase().includes(searchTerm.toLowerCase());

    if (!matchesSearch) return false;
    if (statusFilter !== "all" && order.status !== statusFilter) return false;
    if (agentFilter !== "all" && order.created_by !== agentFilter) return false;
    if (districtFilter !== "all" && districtOf(order) !== districtFilter) return false;
    if (!isDateInRange(order.created_at)) return false;

    return true;
  }));

  const { currentPage, totalPages, pageItems: paginated } = paginate(filtered, page);
  const pageIds = paginated.map((order) => order.id);
  const allPageSelected = pageIds.length > 0 && pageIds.every((id) => selectedOrderIds.includes(id));
  const selectedOrders = orders.filter((order) => selectedOrderIds.includes(order.id));
  const toggleOrderSelection = (id: string, checked: boolean) =>
    setSelectedOrderIds((current) => (checked ? [...current, id] : current.filter((selectedId) => selectedId !== id)));
  const togglePageSelection = (checked: boolean) =>
    setSelectedOrderIds((current) => (checked ? Array.from(new Set([...current, ...pageIds])) : current.filter((id) => !pageIds.includes(id))));

  const ordersReadyForPrep = filtered.length;
  const pendingPalletItems = orders.reduce((sum, order) => {
    const orderPallets = pallets.filter((p) => p.order_id === order.id && p.status === "draft");
    return (
      sum +
      orderPallets.reduce((pSum, p) => pSum + (p.items?.length ?? 0), 0)
    );
  }, 0);
  const palletsCreatedToday = pallets.filter((p) => {
    const today = new Date();
    const pDate = new Date(p.created_at);
    return (
      pDate.getFullYear() === today.getFullYear() &&
      pDate.getMonth() === today.getMonth() &&
      pDate.getDate() === today.getDate()
    );
  }).length;

  const isOrderPrepared = (orderId: string): boolean => {
    const orderPallets = pallets.filter((p) => p.order_id === orderId);
    return orderPallets.length > 0 && orderPallets.every((p) => p.status === "prepared" || p.status === "approved" || p.status === "shipped");
  };

  const handleMarkPrepared = async (orderId: string) => {
    try {
      const orderPallets = pallets.filter((p) => p.order_id === orderId && p.status === "draft");
      for (const pallet of orderPallets) {
        const response = await fetch(`/api/pallets/${pallet.id}/status`, {
          method: "PATCH",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${token}`,
          },
          body: JSON.stringify({ status: "prepared" }),
        });
        if (!response.ok) throw new Error("Failed to mark pallet as prepared.");
      }
      void fetchAll();
      // Next step in the flow: follow the prepared pallets in Pallet Tracking.
      toast.success("Pallets prepared. Opening Pallet Tracking.");
      navigate("/booking-dispatch/inventory");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to mark pallets as prepared");
    }
  };

  const handleDeleteOrderPallets = async (orderId: string) => {
    try {
      const orderPallets = pallets.filter((p) => p.order_id === orderId && p.status === "draft");
      for (const pallet of orderPallets) {
        await fetch(`/api/pallets/${pallet.id}`, {
          method: "DELETE",
          headers: {
            Authorization: `Bearer ${token}`,
          },
        });
      }
      void fetchAll();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to delete pallets");
    }
  };

  const canAutoPick = (orderId: string) =>
    !isOrderPrepared(orderId) && !pallets.some((p) => p.order_id === orderId && p.status === "draft");

  const fetchBatches = async (orderId?: string) => {
    const query = orderId ? `?order_id=${encodeURIComponent(orderId)}` : "";
    const response = await fetch(`/api/inventory-batches${query}`, { headers: { Authorization: `Bearer ${token}` } });
    if (!response.ok) throw new Error(`Could not load inventory (HTTP ${response.status}).`);
    return (await response.json()) as InventoryBatch[];
  };

  const handleAutomatedPicking = async () => {
    const eligible = selectedOrders.filter((order) => canAutoPick(order.id));
    if (eligible.length === 0) return void toast.error("Select orders without pallets to pick automatically");
    if (!(await confirmAction(`Create automatic pallets for ${eligible.length} selected ${eligible.length === 1 ? "order" : "orders"}?`))) return;

    let created = 0;
    const skipped: string[] = [];
    try {
      for (const order of eligible) {
        const batches = await fetchBatches(order.id);
        const { pallets: suggested, shortages } = buildAutomaticPallets(order, batches);
        const validPallets = suggested.filter((pallet) => pallet.items.length > 0);
        if (shortages.length > 0 || validPallets.length === 0 || !isCompletePick(order, validPallets)) {
          skipped.push(order.id.slice(0, 8));
          continue;
        }
        const response = await fetch("/api/pallets", {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
          body: JSON.stringify({
            order_id: order.id,
            pallets: validPallets.map((pallet) => ({
              items: pallet.items.map((item) => ({
                product_id: item.product_id,
                qty_units: item.qty_units,
                batch_item_id: item.batch_item_id,
              })),
            })),
          }),
        });
        if (response.ok) {
          created += 1;
        } else {
          skipped.push(order.id.slice(0, 8));
        }
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Automated picking failed");
    } finally {
      setSelectedOrderIds([]);
      void fetchAll();
    }

    if (created > 0) toast.success(`Created pallets for ${created} order${created === 1 ? "" : "s"}.`);
    if (skipped.length > 0) toast.error(`Skipped ${skipped.length} order${skipped.length === 1 ? "" : "s"} with insufficient stock or incomplete picks.`);
  };

  const bulkActions: TableBulkAction[] = [
    { label: "Automated picking", onSelect: () => void handleAutomatedPicking() },
  ];

  return (
    <div className="flex-1 flex flex-col gap-6 p-4 md:p-6">
      <div className="page-header">
        <div>
          <h1 className="page-title">Pallet Preparation</h1>
          <p className="page-subtitle">Build pallets for approved customer orders</p>
        </div>
      </div>

      {error && (
        <Card className="p-4 bg-destructive-soft border-destructive/30">
          <p className="text-destructive">{error}</p>
        </Card>
      )}

      {/* Summary Cards */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <div className="stat-card">
          <p className="text-xs text-muted-foreground font-semibold tracking-tight">Orders Ready</p>
          <p className="text-2xl font-bold text-accent-2 mt-1">{ordersReadyForPrep}</p>
        </div>
        <div className="stat-card">
          <p className="text-xs text-muted-foreground font-semibold tracking-tight">Items Pending</p>
          <p className="text-2xl font-bold text-gold mt-1">{pendingPalletItems}</p>
        </div>
        <div className="stat-card">
          <p className="text-xs text-muted-foreground font-semibold tracking-tight">Pallets Today</p>
          <p className="text-2xl font-bold text-green mt-1">{palletsCreatedToday}</p>
        </div>
      </div>

      {/* Filters */}
      <TableToolbar
        selectedCount={selectedOrders.length}
        bulkActions={canCreatePallets ? bulkActions : undefined}
        searchValue={searchTerm}
        onSearchChange={setSearchTerm}
        searchPlaceholder="Search by order ID or customer ID…"
      >
        <TableFilterSelect label="Status" value={statusFilter} onChange={(value) => setStatusFilter(value as typeof statusFilter)}>
          <option value="all">All Status</option>
          <option value="pending">Pending</option>
          <option value="approved">Approved</option>
          <option value="prep">Prep</option>
          <option value="ready">Ready</option>
        </TableFilterSelect>
        <TableFilterSelect label="Agent" value={agentFilter} onChange={setAgentFilter}>
          <option value="all">All Agents</option>
          {agentOptions.map(([userId, label]) => (
            <option key={userId} value={userId}>{label}</option>
          ))}
        </TableFilterSelect>
        <TableFilterSelect label="District" value={districtFilter} onChange={setDistrictFilter}>
          <option value="all">All Districts</option>
          {districtOptions.map((district) => (
            <option key={district} value={district}>{district}</option>
          ))}
        </TableFilterSelect>
        <TableFilterSelect label="Date range" value={dateRangeFilter} onChange={(value) => setDateRangeFilter(value as typeof dateRangeFilter)}>
          <option value="all">All Dates</option>
          <option value="today">This Day</option>
          <option value="week">This Week</option>
          <option value="month">This Month</option>
          <option value="custom">Custom</option>
        </TableFilterSelect>
      </TableToolbar>

      {/* Custom Date Picker */}
      {dateRangeFilter === "custom" && (
        <div className="flex flex-col sm:flex-row gap-3 items-end">
          <div className="flex-1">
            <label className="block text-sm font-medium text-foreground mb-1">
              Start Date
            </label>
            <div className="flex items-center rounded-full border border-border bg-card px-4 gap-2">
              <Calendar size={16} className="text-muted-foreground" />
              <Input
                type="date"
                value={customDateStart}
                onChange={(e) => setCustomDateStart(e.target.value)}
                className="flex-1 bg-transparent border-none text-foreground py-2 outline-none text-sm"
              />
            </div>
          </div>
          <div className="flex-1">
            <label className="block text-sm font-medium text-foreground mb-1">
              End Date
            </label>
            <div className="flex items-center rounded-full border border-border bg-card px-4 gap-2">
              <Calendar size={16} className="text-muted-foreground" />
              <Input
                type="date"
                value={customDateEnd}
                onChange={(e) => setCustomDateEnd(e.target.value)}
                className="flex-1 bg-transparent border-none text-foreground py-2 outline-none text-sm"
              />
            </div>
          </div>
        </div>
      )}

      {/* Orders Table */}
      <Card className="overflow-hidden rounded-xl shadow-sm">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-10 px-3">
                <input aria-label="Select all orders on this page" type="checkbox" checked={allPageSelected} onChange={(event) => togglePageSelection(event.target.checked)} />
              </TableHead>
              <TableHead>Order ID</TableHead>
              <TableHead>Customer</TableHead>
              <TableHead>Items</TableHead>
              <TableHead>Created</TableHead>
              <TableHead className="text-right">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {paginated.length === 0 ? (
              <TableRow>
                <TableCell colSpan={6} className="text-center py-8 text-muted-foreground">
                  {orders.length === 0 ? "No orders found" : "No orders match your search"}
                </TableCell>
              </TableRow>
            ) : (
              paginated.map((order) => {
                const customer = customers.find((c) => c.id === order.customer_id);
                const itemCount = order.booking_items?.length ?? 0;
                const orderPallets = pallets.filter((p) => p.order_id === order.id);
                const approvedPalletCount = orderPallets.filter((p) => p.status === "approved").length;
                const draftPalletCount = orderPallets.filter((p) => p.status === "draft").length;
                const isPrepared = isOrderPrepared(order.id);

                return (
                  <TableRow key={order.id}>
                    <TableCell className="w-10 px-3">
                      <input aria-label={`Select order ${order.id.slice(0, 8)}`} type="checkbox" checked={selectedOrderIds.includes(order.id)} onChange={(event) => toggleOrderSelection(order.id, event.target.checked)} />
                    </TableCell>
                    <TableCell className="font-mono text-sm font-semibold text-accent-2">
                      {order.id.slice(0, 8)}
                    </TableCell>
                    <TableCell className="text-sm">
                      <div className="flex flex-col">
                        <TruncatedText className="font-semibold text-foreground">{customer?.store_name || "Unknown"}</TruncatedText>
                        {customer?.location && (
                          <TruncatedText className="text-xs text-muted-foreground">{customer.location}</TruncatedText>
                        )}
                      </div>
                    </TableCell>
                    <TableCell className="text-sm">
                      <div className="space-y-1">
                        {order.booking_items && order.booking_items.length > 0 ? (
                          <>
                            {order.booking_items.map((item) => (
                              <div key={item.id} className="text-xs">
                                <span className="font-semibold text-foreground">{item.product?.name || item.product_id}</span>
                                <span className="text-muted-foreground"> × {item.qty_ordered}</span>
                              </div>
                            ))}
                          </>
                        ) : (
                          <span className="font-semibold text-muted-foreground">No items</span>
                        )}
                      </div>
                      {approvedPalletCount > 0 && (
                        <span className="text-xs text-success block mt-1">
                          {approvedPalletCount} pallet(s) ready
                        </span>
                      )}
                    </TableCell>
                    <TableCell className="text-sm">
                      {new Date(order.created_at).toLocaleDateString()}
                    </TableCell>
                    <TableCell className="text-right">
                      <div className="flex gap-2 justify-end items-center whitespace-nowrap">
                        {/* Prepare: only show when no pallets created yet and not prepared */}
                        {draftPalletCount === 0 && !isPrepared && (
                          <Button
                            onClick={() => {
                              const preparationFilters = { searchTerm, statusFilter, dateRangeFilter, customDateStart, customDateEnd, agentFilter, districtFilter };
                              navigate("/booking-dispatch/preparation", { replace: true, state: { preparationFilters } });
                              navigate(`/booking-dispatch/preparation/${encodeURIComponent(order.id)}`, {
                                state: { fromPreparation: true },
                              });
                            }}
                            variant="default"
                          >
                            Prepare
                          </Button>
                        )}
                        {/* Prepared: show when pallets are drafted but not yet marked prepared */}
                        {draftPalletCount > 0 && !isPrepared && (
                          <>
                            {canUpdatePalletStatus && (
                              <Button
                                onClick={() => navigate(`/booking-dispatch/inventory?order=${order.id}`)}
                                variant="success"
                              >
                                Preparing
                              </Button>
                            )}
                            {canDeletePallets && (
                              <Button
                                onClick={() => handleDeleteOrderPallets(order.id)}
                                title={`Remove ${draftPalletCount} pallet(s) for this order`} type="button" variant="warning" size="sm">
                                Undo
                              </Button>
                            )}
                          </>
                        )}
                        {/* After marked prepared: show badge + Undo */}
                        {isPrepared && (
                          <>
                            <Button
                              onClick={() => navigate(`/booking-dispatch/inventory?order=${order.id}`)}
                              variant="success"
                              size="sm"
                            >
                              ✓ Prepared
                            </Button>
                          </>
                        )}
                      </div>
                    </TableCell>
                  </TableRow>
                );
              })
            )}
          </TableBody>
        </Table>
        <TablePagination page={currentPage} totalPages={totalPages} totalItems={filtered.length} onPageChange={setPage} />
      </Card>

    </div>
  );
}
