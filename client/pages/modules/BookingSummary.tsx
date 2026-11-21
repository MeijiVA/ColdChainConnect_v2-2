import { toast } from "sonner";
import { useNavigate } from "react-router-dom";
import { TruncatedText } from "@/components/ui/truncated-text";
import { PageDialog } from "@/components/shared/PageDialog";
import { useNewRows } from "@/lib/unseen";
import { confirmAction } from "@/lib/confirm";
import { useState, useEffect } from "react";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { LoadingSpinner } from "@/components/LoadingSpinner";
import { StatusBadge, StatusTone } from "@/components/StatusBadge";
import { useAutoRefresh } from "@/hooks/useAutoRefresh";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import { Plus, Calendar, CheckCircle, XCircle } from "lucide-react";
import { TableBulkAction, TableFilterSelect, TableToolbar } from "@/components/TableToolbar";
import { newestFirst } from "@/components/SortableHeader";
import { TablePagination, paginate } from "@/components/TablePagination";
import { Agent, Booking, Truck, Customer, Product } from "@shared/api";
import { useAuth } from "../../hooks/useAuth";
import { useCan } from "@/hooks/useCan";
import { useSearchParams } from "react-router-dom";
import { AddOrderModal } from "./AddOrderModal";
import { BookingDetailPage } from "./BookingDetailPage";
import { AgentOrderScreen } from "./AgentOrderScreen";
import { describeCreditBlock, isCreditBlock, promptCreditOverride } from "@/lib/creditOverride";

export function BookingSummary() {
  const isNewRow = useNewRows("orders");
  const [bookings, setBookings] = useState<Booking[]>([]);
  const [trucks, setTrucks] = useState<Truck[]>([]);
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [agentDistricts, setAgentDistricts] = useState<string[]>([]);
  const [agents, setAgents] = useState<Agent[]>([]);
  const [products, setProducts] = useState<Product[]>([]);
  const [productStock, setProductStock] = useState<Record<string, number>>({});
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const { token, logout, user, finishPostLoginLoading } = useAuth();
  const isAgent = user?.role === "agent";
  const canApprove = useCan("booking:approve");
  const navigate = useNavigate();
  const [searchTerm, setSearchTerm] = useState("");
  const [statusFilter, setStatusFilter] = useState<"all" | "pending" | "approved" | "prep" | "ready">("all");
  const [approvalFilter, setApprovalFilter] = useState<"all" | "approved" | "unapproved">("all");
  const [dateRangeFilter, setDateRangeFilter] = useState<"all" | "today" | "week" | "month" | "custom">("all");
  const [customDateStart, setCustomDateStart] = useState<string>("");
  const [customDateEnd, setCustomDateEnd] = useState<string>("");
  const [selectedBookingIds, setSelectedBookingIds] = useState<string[]>([]);
  const [page, setPage] = useState(1);

  useEffect(() => {
    setPage(1);
  }, [searchTerm, statusFilter, approvalFilter, dateRangeFilter, customDateStart, customDateEnd]);

  // Approve booking modal
  const [selectedBooking, setSelectedBooking] = useState<Booking | null>(null);
  const [showApproveModal, setShowApproveModal] = useState(false);
  const [isApproving, setIsApproving] = useState(false);

  // Reject booking modal
  const [showRejectModal, setShowRejectModal] = useState(false);
  const [rejectReason, setRejectReason] = useState("");
  const [isRejecting, setIsRejecting] = useState(false);

  // Order detail modal
  const [showDetailModal, setShowDetailModal] = useState(false);
  const [detailBooking, setDetailBooking] = useState<Booking | null>(null);

  // Add order modal
  const [showAddModal, setShowAddModal] = useState(false);
  const [newCustomerId, setNewCustomerId] = useState("");
  const [preparedDeliveryDate, setPreparedDeliveryDate] = useState("");
  const [orderItems, setOrderItems] = useState<{ product_id: string; qty_ordered: number }[]>([]);
  const [isCreating, setIsCreating] = useState(false);
  const [rollingBackId, setRollingBackId] = useState<string | null>(null);
  const [searchParams, setSearchParams] = useSearchParams();

  useEffect(() => {
    const requestedStatus = searchParams.get("status");
    if (["pending", "approved", "prep", "ready"].includes(requestedStatus ?? "")) {
      setStatusFilter(requestedStatus as "pending" | "approved" | "prep" | "ready");
      setDateRangeFilter("all");
    }

    if (!isAgent && searchParams.get("action") === "new") {
      setShowAddModal(true);
      const nextParams = new URLSearchParams(searchParams);
      nextParams.delete("action");
      setSearchParams(nextParams, { replace: true });
    }
  }, [isAgent, searchParams, setSearchParams]);

  const fetchAll = async () => {
    try {
      const [bRes, tRes, cRes, pRes, invRes, dRes, agentsRes] = await Promise.all([
        fetch("/api/bookings", { headers: { Authorization: `Bearer ${token}` } }),
        fetch("/api/trucks", { headers: { Authorization: `Bearer ${token}` } }),
        fetch("/api/customers", { headers: { Authorization: `Bearer ${token}` } }),
        fetch("/api/products", { headers: { Authorization: `Bearer ${token}` } }),
        fetch("/api/products/inventory", { headers: { Authorization: `Bearer ${token}` } }),
        isAgent ? fetch("/api/agent-districts", { headers: { Authorization: `Bearer ${token}` } }) : Promise.resolve(null),
        isAgent ? Promise.resolve(null) : fetch("/api/agents", { headers: { Authorization: `Bearer ${token}` } }),
      ]);
      if (bRes.ok) setBookings(await bRes.json());
      if (tRes.ok) setTrucks(await tRes.json());
      if (cRes.ok) setCustomers(await cRes.json());
      if (pRes.ok) setProducts(await pRes.json());
      if (invRes.ok) setProductStock(await invRes.json());
      if (dRes?.ok) setAgentDistricts(await dRes.json());
      if (agentsRes?.ok) setAgents(await agentsRes.json());
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Error loading data");
    } finally {
      setIsLoading(false);
      finishPostLoginLoading();
    }
  };

  useEffect(() => { if (token) fetchAll(); }, [token]);
  useAutoRefresh(fetchAll, { enabled: Boolean(token) });

  const getStatusTone = (status: string): StatusTone => {
    const tones: Record<string, StatusTone> = {
      pending: "warning",
      prep: "info",
      approved: "success",
      ready: "success",
      rejected: "danger",
    };
    return tones[status] ?? "warning";
  };

  const isDateInRange = (dateStr: string): boolean => {
    if (dateRangeFilter === "all") return true;

    const bookingDate = new Date(dateStr);
    const now = new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const bookingDateOnly = new Date(
      bookingDate.getFullYear(),
      bookingDate.getMonth(),
      bookingDate.getDate()
    );

    if (dateRangeFilter === "today") {
      return bookingDateOnly.getTime() === today.getTime();
    }

    if (dateRangeFilter === "week") {
      const weekStart = new Date(today);
      weekStart.setDate(today.getDate() - today.getDay());
      const weekEnd = new Date(weekStart);
      weekEnd.setDate(weekStart.getDate() + 6);
      return bookingDateOnly >= weekStart && bookingDateOnly <= weekEnd;
    }

    if (dateRangeFilter === "month") {
      return (
        bookingDate.getFullYear() === now.getFullYear() &&
        bookingDate.getMonth() === now.getMonth()
      );
    }

    if (dateRangeFilter === "custom") {
      if (!customDateStart || !customDateEnd) return true;
      const start = new Date(customDateStart);
      const end = new Date(customDateEnd);
      end.setHours(23, 59, 59, 999);
      return bookingDate >= start && bookingDate <= end;
    }

    return true;
  };

  // ── Add Order ──────────────────────────────────────────────
  const handleAddItem = (productId: string) =>
    setOrderItems((prev) => [...prev, { product_id: productId, qty_ordered: 1 }]);

  const handleRemoveItem = (idx: number) =>
    setOrderItems((prev) => prev.filter((_, i) => i !== idx));

  const handleItemChange = (idx: number, field: "product_id" | "qty_ordered", value: string | number) => {
    setOrderItems((prev) => prev.map((item, i) => {
      if (i !== idx) return item;
      if (field === "qty_ordered") {
        const maxStock = productStock[item.product_id] || 0;
        const qty = typeof value === "number" ? value : parseInt(value) || 1;
        return { ...item, qty_ordered: Math.min(qty, maxStock) };
      }
      return { ...item, product_id: String(value) };
    }));
  };

  const getMaxQtyForProduct = (productId: string): number => {
    return productStock[productId] || 0;
  };

  const submitOrder = async (override?: { reason: string }) => {
    if (!newCustomerId) {
      toast.error("Please select a customer");
      return;
    }
    const emptyItems = orderItems.filter((i) => !i.product_id);
    if (emptyItems.length > 0) {
      toast.error(`Please select a product for ${emptyItems.length} item${emptyItems.length > 1 ? "s" : ""}`);
      return;
    }
    if (orderItems.length === 0) {
      toast.error("Please add at least one item to the order");
      return;
    }
    setIsCreating(true);
    try {
      const res = await fetch("/api/bookings", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({
          customer_id: newCustomerId,
          prepared_delivery_date: preparedDeliveryDate || undefined,
          items: orderItems,
          ...(override && { ar_override: true, ar_override_reason: override.reason }),
        }),
      });
      if (res.status === 401) {
        toast.error("Your session has expired or your account was not found. Please log in again.");
        await logout();
        return;
      }
      if (res.status === 409) {
        const block: unknown = await res.json();
        if (isCreditBlock(block)) {
          const reason = override ? null : promptCreditOverride(block);
          if (reason) return await submitOrder({ reason });
          toast.error(describeCreditBlock(block));
          return;
        }
      }
      if (!res.ok) {
        const errData = await res.json();
        throw new Error(errData.error || "Failed to create order");
      }
      const created = await res.json();
      setBookings((prev) => [created, ...prev]);
      void fetchAll();
      setShowAddModal(false);
      setNewCustomerId("");
      setPreparedDeliveryDate("");
      setOrderItems([]);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to create order");
    } finally {
      setIsCreating(false);
    }
  };

  const handleCreateOrder = () => submitOrder();

  const resetOrderDraft = () => {
    setNewCustomerId("");
    setPreparedDeliveryDate("");
    setOrderItems([]);
  };

  const handleRollbackOrder = async (booking: Booking) => {
    if (!(await confirmAction("Roll back this order? It will be permanently deleted."))) return;
    setRollingBackId(booking.id);
    try {
      const res = await fetch(`/api/bookings/${booking.id}`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) {
        const errData = await res.json();
        throw new Error(errData.error || "Failed to roll back order");
      }
      setBookings((prev) => prev.filter((b) => b.id !== booking.id));
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to roll back order");
    } finally {
      setRollingBackId(null);
    }
  };

  // ── Order Detail Modal ────────────────────────────────────────
  const openDetailModal = (booking: Booking) => {
    setDetailBooking(booking);
    setShowDetailModal(true);
  };

  const closeDetailModal = () => {
    setShowDetailModal(false);
    setDetailBooking(null);
  };

  const handleSaveBookingItems = async (items: Array<{ id: string; qty_ordered: number }>) => {
    if (!detailBooking) return null;
    const save = async (override?: { reason: string }): Promise<Booking | null> => {
      const res = await fetch(`/api/bookings/${detailBooking.id}/items`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({
          items,
          ...(override && { ar_override: true, ar_override_reason: override.reason }),
        }),
      });
      const result = await res.json();
      if (res.status === 409 && isCreditBlock(result)) {
        const reason = override ? null : promptCreditOverride(result);
        if (reason) return save({ reason });
        toast.error(describeCreditBlock(result));
        return null;
      }
      if (!res.ok) throw new Error(result.error || "Failed to update order quantities");
      setBookings((prev) => prev.map((booking) => booking.id === result.id ? result : booking));
      setDetailBooking(result);
      void fetchAll();
      toast.success("Order quantities updated.");
      return result as Booking;
    };

    try {
      return await save();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to update order quantities");
      return null;
    }
  };

  // ── Approve Booking ───────────────────────────────────────────
  const openApproveModal = (booking: Booking) => {
    setSelectedBooking(booking);
    setShowApproveModal(true);
  };

  const closeApproveModal = () => {
    setShowApproveModal(false);
    setSelectedBooking(null);
  };

  const handleApproveBooking = async () => {
    if (!selectedBooking) return void toast.error("No booking selected");
    setIsApproving(true);
    try {
      const res = await fetch(`/api/bookings/${selectedBooking.id}/status`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ status: "approved" }),
      });
      if (!res.ok) {
        const errorData = await res.json();
        throw new Error(errorData.error || "Failed to approve booking");
      }
      const { booking: updated } = await res.json();
      setBookings((prev) => prev.map((b) => b.id === updated.id ? updated : b));
      void fetchAll();
      // Next step in the flow: build the order's pallets. The invoice follows once picking is complete.
      toast.success("Order approved. Prepare its pallets next; the invoice is created once picking is complete.");
      const approvedId = selectedBooking.id;
      closeApproveModal();
      navigate(`/booking-dispatch/preparation/${encodeURIComponent(approvedId)}`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to approve booking");
    } finally {
      setIsApproving(false);
    }
  };

  const handleUnapproveBooking = async (booking: Booking) => {
    if (!(await confirmAction("Are you sure you want to unapprove this order? It will return to pending status."))) return;
    try {
      const res = await fetch(`/api/bookings/${booking.id}/status`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ status: "pending" }),
      });
      if (!res.ok) {
        const errorData = await res.json();
        throw new Error(errorData.error || "Failed to unapprove booking");
      }
      const { booking: updated } = await res.json();
      setBookings((prev) => prev.map((b) => b.id === updated.id ? updated : b));
      void fetchAll();
      toast.success("Order moved back to pending status.");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to unapprove booking");
    }
  };

  const handlePreparedDeliveryDateChange = async (booking: Booking, date: string) => {
    if (!date || date === booking.prepared_delivery_date) return;
    try {
      const res = await fetch(`/api/bookings/${booking.id}/prepared-delivery-date`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ prepared_delivery_date: date }),
      });
      if (!res.ok) {
        const errorData = await res.json();
        throw new Error(errorData.error || "Failed to set prepared delivery date");
      }
      const { booking: updated } = await res.json();
      setBookings((prev) => prev.map((b) => b.id === updated.id ? updated : b));
      void fetchAll();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to set prepared delivery date");
    }
  };

  const handleApproveSelected = async () => {
    const selected = bookings.filter((b) => selectedBookingIds.includes(b.id) && b.status === "pending");
    const pending = selected.filter((b) => b.prepared_delivery_date);
    const missingDateCount = selected.length - pending.length;
    if (pending.length === 0) {
      return void toast.error(missingDateCount > 0
        ? "Set a prepared delivery date on the selected orders before approving them"
        : "Select pending orders to approve");
    }
    if (!(await confirmAction(`Approve ${pending.length} selected ${pending.length === 1 ? "order" : "orders"}?`))) return;

    const results = await Promise.all(pending.map(async (booking) => {
      try {
        const res = await fetch(`/api/bookings/${booking.id}/status`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
          body: JSON.stringify({ status: "approved" }),
        });
        if (!res.ok) return null;
        const { booking: updated } = await res.json();
        return updated as Booking;
      } catch {
        return null;
      }
    }));
    const approved = results.filter((b): b is Booking => b !== null);
    setBookings((prev) => prev.map((b) => approved.find((a) => a.id === b.id) ?? b));
    if (approved.length > 0) void fetchAll();
    setSelectedBookingIds((current) => current.filter((id) => !approved.some((b) => b.id === id)));
    if (approved.length > 0) toast.success(`${approved.length} order${approved.length === 1 ? "" : "s"} approved.`);
    if (approved.length < pending.length) toast.error(`${pending.length - approved.length} order(s) could not be approved.`);
    if (missingDateCount > 0) toast.error(`${missingDateCount} order(s) skipped: set a prepared delivery date first.`);
  };

  const openRejectModal = (booking: Booking) => {
    setSelectedBooking(booking);
    setRejectReason("");
    setShowRejectModal(true);
  };

  const closeRejectModal = () => {
    setShowRejectModal(false);
    setSelectedBooking(null);
    setRejectReason("");
  };

  const handleRejectBooking = async () => {
    if (!selectedBooking) return void toast.error("No booking selected");
    setIsRejecting(true);
    try {
      const res = await fetch(`/api/bookings/${selectedBooking.id}/status`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ status: "rejected" }),
      });
      if (!res.ok) {
        const errorData = await res.json();
        throw new Error(errorData.error || "Failed to reject booking");
      }
      const { booking: updated } = await res.json();
      setBookings((prev) => prev.map((b) => b.id === updated.id ? updated : b));
      void fetchAll();
      closeRejectModal();
      toast.success("Order rejected successfully.");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to reject booking");
    } finally {
      setIsRejecting(false);
    }
  };

  if (isLoading) return <LoadingSpinner />;

  if (isAgent) {
    return (
      <AgentOrderScreen
        customers={customers.filter((customer) => customer.district && agentDistricts.includes(customer.district))}
        products={products}
        productStock={productStock}
        orderItems={orderItems}
        newCustomerId={newCustomerId}
        preparedDeliveryDate={preparedDeliveryDate}
        isCreating={isCreating}
        onCustomerChange={setNewCustomerId}
        onPreparedDeliveryDateChange={setPreparedDeliveryDate}
        onAddItem={handleAddItem}
        onRemoveItem={handleRemoveItem}
        onItemChange={handleItemChange}
        pendingOrders={bookings.filter((b) => b.status === "pending")}
        currentUserId={user?.id ?? ""}
        rollingBackId={rollingBackId}
        onCancel={resetOrderDraft}
        onCreateOrder={handleCreateOrder}
        onRollbackOrder={handleRollbackOrder}
      />
    );
  }

  const closeAddModal = () => {
    setShowAddModal(false);
    setNewCustomerId("");
    setPreparedDeliveryDate("");
    setOrderItems([{ product_id: "", qty_ordered: 1 }]);
  };

  const filtered = newestFirst(bookings.filter((b) => {
    const matchesSearch =
      b.id.toLowerCase().includes(searchTerm.toLowerCase()) ||
      b.customer_id.toLowerCase().includes(searchTerm.toLowerCase());
    if (!matchesSearch) return false;
    if (statusFilter !== "all" && b.status !== statusFilter) return false;

    // Check approval status
    if (approvalFilter !== "all") {
      const isApproved = b.status === "approved";
      if (approvalFilter === "approved" && !isApproved) return false;
      if (approvalFilter === "unapproved" && isApproved) return false;
    }

    // Check date range filter
    if (!isDateInRange(b.created_at)) return false;

    return true;
  }));

  const { currentPage, totalPages, pageItems: paginated } = paginate(filtered, page);
  const pageIds = paginated.map((booking) => booking.id);
  const allPageSelected = pageIds.length > 0 && pageIds.every((id) => selectedBookingIds.includes(id));
  const selectedBookings = bookings.filter((booking) => selectedBookingIds.includes(booking.id));
  const toggleBookingSelection = (id: string, checked: boolean) =>
    setSelectedBookingIds((current) => (checked ? [...current, id] : current.filter((selectedId) => selectedId !== id)));
  const togglePageSelection = (checked: boolean) =>
    setSelectedBookingIds((current) => (checked ? Array.from(new Set([...current, ...pageIds])) : current.filter((id) => !pageIds.includes(id))));
  const bulkActions: TableBulkAction[] | undefined = canApprove
    ? [{ label: "Approve selected orders", onSelect: () => void handleApproveSelected() }]
    : undefined;

  return (
    <>
    <div className="flex-1 flex flex-col p-6 gap-6">
      {/* Header */}
      <div className="page-header">
        <div>
          <h1 className="page-title">Order Summary</h1>
          <p className="page-subtitle">Review, approve, and reject customer orders</p>
        </div>
        <div className="flex items-center gap-2">
          <Button type="button" onClick={() => setShowAddModal(true)}>
            <Plus size={16} /> Add Order
          </Button>
        </div>
      </div>

      {error && (
        <Card className="p-4 bg-destructive-soft border-destructive/30">
          <p className="text-destructive">{error}</p>
        </Card>
      )}

      <TableToolbar
        selectedCount={selectedBookings.length}
        bulkActions={bulkActions}
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
        <TableFilterSelect label="Approval" value={approvalFilter} onChange={(value) => setApprovalFilter(value as typeof approvalFilter)}>
          <option value="all">All Orders</option>
          <option value="approved">Approved</option>
          <option value="unapproved">Unapproved</option>
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

      {/* Table */}
      <Card className="overflow-hidden rounded-xl shadow-sm">
        <Table>
          <TableHeader>
            <TableRow className="whitespace-nowrap">
              {canApprove && (
                <TableHead className="w-10 px-3">
                  <input aria-label="Select all orders on this page" type="checkbox" checked={allPageSelected} onChange={(event) => togglePageSelection(event.target.checked)} />
                </TableHead>
              )}
              <TableHead>Order ID</TableHead>
              <TableHead>Customer</TableHead>
              <TableHead>Agent</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Prepared Delivery Date</TableHead>
              <TableHead>Created</TableHead>
              <TableHead className="text-right">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {paginated.length === 0 ? (
              <TableRow>
                <TableCell colSpan={canApprove ? 8 : 7} className="text-center py-8 text-muted-foreground">
                  {bookings.length === 0 ? "No orders found" : "No orders match your search"}
                </TableCell>
              </TableRow>
            ) : (
              paginated.map((booking) => {
                const customer = booking.customer;
                const creator = (booking as any).creator;
                return (
                  <TableRow key={booking.id} className={isNewRow(booking.created_at) ? "row-new" : undefined}>
                    {canApprove && (
                      <TableCell className="w-10 px-3">
                        <input aria-label={`Select order ${booking.id.slice(0, 8)}`} type="checkbox" checked={selectedBookingIds.includes(booking.id)} onChange={(event) => toggleBookingSelection(booking.id, event.target.checked)} />
                      </TableCell>
                    )}
                    <TableCell className="font-mono text-sm">
                      <Button
                        onClick={() => openDetailModal(booking)}
                        variant="link" className="h-auto p-0"
                      >
                        {booking.id.slice(0, 8)}
                      </Button>
                    </TableCell>
                    <TableCell className="text-sm">
                      {customer ? (
                        <div className="flex flex-col">
                          <TruncatedText className="font-semibold text-foreground">{customer.store_name}</TruncatedText>
                          {customer.contact_info && (
                            <span className="text-xs text-muted-foreground">{customer.contact_info}</span>
                          )}
                        </div>
                      ) : (
                        <span className="text-muted-foreground">Unknown customer</span>
                      )}
                    </TableCell>
                    <TableCell className="text-sm">
                      {creator ? (
                        <span className="font-semibold text-foreground">{creator.agent?.full_name ?? creator.username}</span>
                      ) : (
                        <span className="text-muted-foreground italic">Unknown</span>
                      )}
                    </TableCell>
                    <TableCell>
                      <StatusBadge label={booking.status} tone={getStatusTone(booking.status)} />
                    </TableCell>
                    <TableCell className="text-sm whitespace-nowrap">
                      {canApprove && booking.status === "pending" ? (
                        <Input
                          type="date"
                          aria-label={`Prepared delivery date for order ${booking.id.slice(0, 8)}`}
                          value={booking.prepared_delivery_date ?? ""}
                          onChange={(event) => void handlePreparedDeliveryDateChange(booking, event.target.value)}
                          className={`h-8 w-40 text-sm ${booking.prepared_delivery_date ? "" : "border-warning"}`}
                        />
                      ) : booking.prepared_delivery_date ? (
                        new Date(`${booking.prepared_delivery_date}T00:00:00`).toLocaleDateString()
                      ) : (
                        <span className="text-muted-foreground">—</span>
                      )}
                    </TableCell>
                    <TableCell className="text-sm">
                      {new Date(booking.created_at).toLocaleDateString()}
                    </TableCell>
                    <TableCell className="text-right">
                      {booking.status === "pending" && canApprove ? (
                        <div className="flex gap-2 justify-end">
                          <Button
                            onClick={() => openApproveModal(booking)}
                            variant="default"
                            disabled={!booking.prepared_delivery_date}
                            title={booking.prepared_delivery_date ? undefined : "Set a prepared delivery date first"}
                          >
                            <CheckCircle size={14} />
                            Approve
                          </Button>
                          <Button
                            onClick={() => openRejectModal(booking)}
                            variant="destructive"
                          >
                            <XCircle size={14} />
                            Reject
                          </Button>
                        </div>
                      ) : booking.status === "approved" && canApprove ? (
                        <div className="flex justify-end">
                          <Button
                            onClick={() => handleUnapproveBooking(booking)}
                            variant="outline"
                          >
                            <XCircle size={14} />
                            Unapprove
                          </Button>
                        </div>
                      ) : (
                        <StatusBadge label={booking.status} tone={getStatusTone(booking.status)} />
                      )}
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
      {(showAddModal) && (
        <PageDialog onClose={closeAddModal}>
      <AddOrderModal
        onClose={closeAddModal}
        customers={customers}
        agents={agents}
        trucks={trucks}
        products={products}
        productStock={productStock}
        orderItems={orderItems}
        newCustomerId={newCustomerId}
        preparedDeliveryDate={preparedDeliveryDate}
        onCustomerChange={setNewCustomerId}
        onPreparedDeliveryDateChange={setPreparedDeliveryDate}
        onAddItem={handleAddItem}
        onRemoveItem={handleRemoveItem}
        onItemChange={handleItemChange}
        onCreateOrder={handleCreateOrder}
        isCreating={isCreating}
      />
        </PageDialog>
      )}
      {(showApproveModal && selectedBooking) && (
        <PageDialog onClose={closeApproveModal}>
      <div className="mx-auto w-full !max-w-2xl flex-1 flex flex-col p-6 gap-6">
        <div className="page-header">
          <div>
            <h1 className="page-title">Approve Order</h1>
            <p className="page-subtitle">Confirm approval for this customer order</p>
          </div>
        </div>

        <div className="bg-card rounded-2xl border border-border p-6 space-y-4 max-w-2xl">
          <div>
            <label className="block text-xs font-semibold text-foreground mb-1">Order ID</label>
            <div className="px-3 py-2 bg-muted rounded-lg text-sm font-mono text-foreground">
              {selectedBooking.id.slice(0, 8)}
            </div>
          </div>
          <div>
            <label className="block text-xs font-semibold text-foreground mb-1">Customer</label>
            <div className="px-3 py-2 bg-muted rounded-lg text-sm text-foreground">
              <span className="font-semibold">{selectedBooking.customer?.store_name || "Unknown"}</span>
              {selectedBooking.customer?.contact_info && (
                <span className="text-xs text-muted-foreground block">{selectedBooking.customer.contact_info}</span>
              )}
            </div>
          </div>
          <div>
            <label className="block text-xs font-semibold text-foreground mb-1">Location</label>
            <div className="px-3 py-2 bg-muted rounded-lg text-sm text-foreground">
              {selectedBooking.customer?.location || "Unknown"}
            </div>
          </div>

          <div className="px-4 py-3 bg-info-soft border border-link/30 rounded-lg text-sm text-link">
            The truck will be automatically assigned based on the customer's truck district. After approving you will be taken to pallet preparation.
          </div>
        </div>

        <div className="flex justify-end gap-2 max-w-2xl">
          <Button onClick={closeApproveModal} variant="outline">Cancel</Button>
          <Button
            onClick={handleApproveBooking}
            disabled={isApproving}
            variant="default"
          >
            {isApproving ? "Approving…" : "Approve Order"}
          </Button>
        </div>
      </div>
        </PageDialog>
      )}
      {(showRejectModal && selectedBooking) && (
        <PageDialog onClose={closeRejectModal}>
      <div className="mx-auto w-full !max-w-2xl flex-1 flex flex-col p-6 gap-6">
        <div className="page-header">
          <div>
            <h1 className="page-title">Reject Order</h1>
            <p className="page-subtitle">Confirm rejection of this customer order</p>
          </div>
        </div>

        <div className="bg-card rounded-2xl border border-border p-6 space-y-4 max-w-2xl">
          <div>
            <label className="block text-xs font-semibold text-foreground mb-1">Order ID</label>
            <div className="px-3 py-2 bg-muted rounded-lg text-sm font-mono text-foreground">
              {selectedBooking.id.slice(0, 8)}
            </div>
          </div>
          <div>
            <label className="block text-xs font-semibold text-foreground mb-1">Customer</label>
            <div className="px-3 py-2 bg-muted rounded-lg text-sm text-foreground">
              <span className="font-semibold">{selectedBooking.customer?.store_name || "Unknown"}</span>
              {selectedBooking.customer?.contact_info && (
                <span className="text-xs text-muted-foreground block">{selectedBooking.customer.contact_info}</span>
              )}
            </div>
          </div>
          <div className="bg-destructive-soft p-3 rounded-lg border border-destructive/30">
            <p className="text-xs text-destructive">
              This order will be marked as rejected and cannot be processed further. This action cannot be undone easily.
            </p>
          </div>
        </div>

        <div className="flex justify-end gap-2 max-w-2xl">
          <Button onClick={closeRejectModal} variant="outline">
            Cancel
          </Button>
          <Button
            onClick={handleRejectBooking}
            disabled={isRejecting}
            variant="destructive"
          >
            {isRejecting ? "Rejecting…" : "Reject Order"}
          </Button>
        </div>
      </div>
        </PageDialog>
      )}
      {(showDetailModal && detailBooking) && (
        <PageDialog onClose={closeDetailModal}>
      <BookingDetailPage
        booking={detailBooking}
        products={products}
        getStatusTone={getStatusTone}
        onBack={closeDetailModal}
        onSaveItems={handleSaveBookingItems}
      />
        </PageDialog>
      )}
    </>
  );
}
