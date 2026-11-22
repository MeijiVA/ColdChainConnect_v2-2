import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { PageDialog } from "@/components/shared/PageDialog";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { toast } from "sonner";
import { useState, useEffect, useCallback } from "react";
import { useAuth } from "../../hooks/useAuth";
import { useCan } from "@/hooks/useCan";
import { LoadingSpinner } from "@/components/LoadingSpinner";
import { StatusBadge, StatusTone } from "@/components/StatusBadge";
import { useAutoRefresh } from "@/hooks/useAutoRefresh";
import { RotateCcw, CheckCircle, XCircle } from "lucide-react";
import { AgentReturn, AgentScheduleResponse, Invoice, Customer, Product } from "@shared/api";
import { LogReturnForm } from "./LogReturnForm";
import { Table } from "@/components/ui/table";
import { newestFirst } from "@/components/SortableHeader";
import { TableBulkAction, TableToolbar } from "@/components/TableToolbar";
import { TablePagination, paginate } from "@/components/TablePagination";
import { confirmAction } from "@/lib/confirm";
import { RecordTitleButton } from "@/components/RecordTitleButton";
import { formatPeso } from "@/lib/format";

function authHeaders(token: string) {
  return { "Content-Type": "application/json", Authorization: `Bearer ${token}` };
}

function returnStatusTone(status: string): StatusTone {
  if (status === "accepted") return "success";
  if (status === "rejected") return "danger";
  return "warning";
}

function returnTypeBadge(type: string) {
  return type === "damaged"
    ? "bg-warning-soft text-warning"
    : "bg-info-soft text-link";
}

// ─── Agent: full-screen Log Return ────────────────────────────────────────────
function AgentLogReturnScreen({
  invoices, customers, products, token,
}: {
  invoices: Invoice[]; customers: Customer[]; products: Product[]; token: string;
}) {
  const [logged, setLogged] = useState(false);
  const [districts, setDistricts] = useState<string[]>([]);

  useEffect(() => {
    fetch("/api/agent-schedule", { headers: { Authorization: `Bearer ${token}` } })
      .then((res) => (res.ok ? res.json() as Promise<AgentScheduleResponse> : null))
      .then((schedule) => {
        setDistricts([...new Set(schedule?.deliveries.map((delivery) => delivery.truck?.district).filter((d): d is string => Boolean(d)))]);
      });
  }, [token]);

  const districtCustomers = customers.filter((customer) => customer.district && districts.includes(customer.district));

  return (
    <div className="px-4 md:px-6 lg:px-7 py-4 md:py-6 space-y-5 max-w-xl mx-auto">
      <div>
        <h1 className="page-title">Logging Returns</h1>
        <p className="page-subtitle">Record returned items and their condition</p>
      </div>

      {logged && (
        <div className="rounded-lg border border-green/30 bg-green/10 px-4 py-2 text-xs text-green">
          Return logged.
        </div>
      )}

      <div className="bg-card rounded-2xl border border-border flex flex-col">
        <LogReturnForm
          invoices={invoices}
          customers={districtCustomers}
          products={products}
          token={token}
          onSaved={() => setLogged(true)}
          onCancel={() => setLogged(false)}
        />
      </div>
    </div>
  );
}

// ─── Admin: Create Return Modal ───────────────────────────────────────────────
function CreateReturnModal({
  invoices, customers, products, token, onClose, onCreated,
}: {
  invoices: Invoice[]; customers: Customer[]; products: Product[];
  token: string; onClose: () => void; onCreated: () => void;
}) {
  return (
    <div className="p-6 space-y-5 max-w-xl mx-auto">
      <div className="page-header">
        <div>
          <h1 className="page-title">Log Return</h1>
        </div>
      </div>
      <div className="bg-card rounded-2xl border border-border flex flex-col">
        <LogReturnForm
          invoices={invoices}
          customers={customers}
          products={products}
          token={token}
          onSaved={() => { onCreated(); onClose(); }}
          onCancel={onClose}
        />
      </div>
    </div>
  );
}

// ─── Main Returns Component ───────────────────────────────────────────────────
function OrderInfo({ invoiceId, invoice, customerName, returns, onClose }: { invoiceId: string; invoice: Invoice | undefined; customerName: string; returns: AgentReturn[]; onClose: () => void }) {
  const items = invoice?.invoice_items ?? [];
  const returnedQty = (productId: string) => returns.filter((ret) => ret.product_id === productId).reduce((sum, ret) => sum + ret.qty_returned, 0);
  return (
    <div className="space-y-5 px-4 py-4 md:px-6 md:py-6">
      <div>
        <h1 className="page-title">Order {invoice?.receipt_number || invoiceId.slice(0, 8).toUpperCase()}</h1>
        <p className="page-subtitle">The order this return was logged against</p>
      </div>
      <dl className="grid gap-4 sm:grid-cols-2">
        {[
          ["Customer", customerName],
          ["Order date", invoice ? new Date(invoice.created_at).toLocaleDateString("en-PH") : "—"],
          ["Invoice status", invoice?.status ?? "—"],
          ["Payment", invoice?.payment_status ?? "—"],
          ["Total", formatPeso(invoice?.total_amount)],
          ["Prepared by", invoice?.prepared_by || "—"],
        ].map(([label, value]) => (
          <div key={label}>
            <dt className="mb-1 text-xs font-semibold text-muted-foreground">{label}</dt>
            <dd className="text-sm font-medium capitalize text-foreground">{value}</dd>
          </div>
        ))}
      </dl>
      <div className="data-table-frame overflow-x-auto">
        <Table>
          <thead>
            <tr className="border-b border-border bg-muted text-left">
              <th className="px-3 py-2 font-semibold">Product</th>
              <th className="px-3 py-2 text-right font-semibold">Ordered</th>
              <th className="px-3 py-2 text-right font-semibold">Unit price</th>
              <th className="px-3 py-2 text-right font-semibold">Amount</th>
            </tr>
          </thead>
          <tbody>
            {items.length === 0 ? (
              <tr><td colSpan={4} className="px-3 py-6 text-center text-muted-foreground">No line items on this order.</td></tr>
            ) : items.map((item) => (
              <tr key={item.id} className={`border-b border-border last:border-b-0 ${returnedQty(item.product_id) > 0 ? "bg-warning-soft" : ""}`}>
                <td className="px-3 py-2 text-foreground">
                  {item.product_name}
                  {returnedQty(item.product_id) > 0 && <span className="ml-2 text-xs font-semibold text-warning">returning {returnedQty(item.product_id)}</span>}
                </td>
                <td className="px-3 py-2 text-right">{item.qty_ordered}</td>
                <td className="px-3 py-2 text-right">{formatPeso(item.unit_price)}</td>
                <td className="px-3 py-2 text-right">{formatPeso(item.amount)}</td>
              </tr>
            ))}
          </tbody>
        </Table>
      </div>
      <div className="space-y-3">
        <h2 className="text-sm font-semibold text-foreground">Returns on this order</h2>
        <div className="data-table-frame overflow-x-auto">
          <Table>
            <thead>
              <tr className="border-b border-border bg-muted text-left">
                <th className="px-3 py-2 font-semibold">Product</th>
                <th className="px-3 py-2 text-right font-semibold">Qty</th>
                <th className="px-3 py-2 font-semibold">Type</th>
                <th className="px-3 py-2 font-semibold">Reason</th>
                <th className="px-3 py-2 font-semibold">Status</th>
              </tr>
            </thead>
            <tbody>
              {returns.map((ret) => (
                <tr key={ret.id} className="border-b border-border last:border-b-0">
                  <td className="px-3 py-2 text-foreground">{ret.product_name}</td>
                  <td className="px-3 py-2 text-right">{ret.qty_returned}</td>
                  <td className="px-3 py-2">
                    <span className={`px-2 py-0.5 rounded text-xs font-semibold ${returnTypeBadge(ret.return_type)}`}>
                      {ret.return_type === "damaged" ? "Damaged" : "Good"}
                    </span>
                  </td>
                  <td className="px-3 py-2 text-muted-foreground">{ret.reason || "—"}</td>
                  <td className="px-3 py-2"><StatusBadge label={ret.status} tone={returnStatusTone(ret.status)} /></td>
                </tr>
              ))}
            </tbody>
          </Table>
        </div>
      </div>
      <div className="flex justify-end border-t border-border pt-4">
        <Button type="button" variant="outline" onClick={onClose}>Close</Button>
      </div>
    </div>
  );
}

export function AgentReports() {
  const { token, user } = useAuth();
  const role = user?.role;
  const isAgent = role === "agent";
  const canDecideReturns = useCan("agentReturn:decide");

  const [returns,   setReturns]   = useState<AgentReturn[]>([]);
  const [invoices,  setInvoices]  = useState<Invoice[]>([]);
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [products,  setProducts]  = useState<Product[]>([]);
  const [loading,   setLoading]   = useState(true);
  const [error,     setError]     = useState<string | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  const [viewingOrder, setViewingOrder] = useState<string | null>(null);
  const [processing, setProcessing] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState<"all" | "pending" | "accepted" | "rejected">("all");
  const [searchTerm, setSearchTerm] = useState("");
  const [dateFilter, setDateFilter] = useState("");
  const [page, setPage] = useState(1);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);

  const fetchAll = useCallback(async () => {
    if (!token) return;
    try {
      const [rRes, iRes, cRes, pRes] = await Promise.all([
        fetch("/api/agent-returns",  { headers: { Authorization: `Bearer ${token}` } }),
        fetch("/api/invoices",       { headers: { Authorization: `Bearer ${token}` } }),
        fetch("/api/customers",      { headers: { Authorization: `Bearer ${token}` } }),
        fetch("/api/products",       { headers: { Authorization: `Bearer ${token}` } }),
      ]);
      const [returnsData, invoicesData, customersData, productsData] = await Promise.all([
        rRes.ok ? rRes.json() : [],
        iRes.ok ? iRes.json() : [],
        cRes.ok ? cRes.json() : [],
        pRes.ok ? pRes.json() : [],
      ]);
      setReturns(returnsData);
      setInvoices(invoicesData);
      setCustomers(customersData);
      setProducts(productsData);
      setError(null);
    } catch {
      setError("Failed to load returns.");
    } finally {
      setLoading(false);
    }
  }, [token]);

  useEffect(() => { fetchAll(); }, [fetchAll]);
  useAutoRefresh(fetchAll, { enabled: Boolean(token) });

  const decideReturns = async (targets: AgentReturn[], action: "accept" | "reject", reason: string) => {
    if (!token) return;
    const results = await Promise.all(targets.map(async (ret) => {
      try {
        const res = await fetch(`/api/agent-returns/${ret.id}/${action}`, {
          method: "POST",
          headers: authHeaders(token),
          ...(action === "reject" && { body: JSON.stringify({ reason }) }),
        });
        return res.ok;
      } catch {
        return false;
      }
    }));
    const failed = results.filter((ok) => !ok).length;
    await fetchAll();
    if (failed > 0) toast.error(`${failed} return(s) could not be ${action === "accept" ? "accepted" : "rejected"}.`);
  };

  const decideOrder = async (invoiceId: string, action: "accept" | "reject") => {
    let reason = "";
    if (action === "reject") {
      const input = prompt("Reason for rejection (optional):");
      if (input === null) return;
      reason = input;
    }
    setProcessing(invoiceId);
    try {
      await decideReturns(returns.filter((ret) => ret.invoice_id === invoiceId && ret.status === "pending"), action, reason);
    } finally {
      setProcessing(null);
    }
  };

  const processSelected = async (action: "accept" | "reject") => {
    if (!token) return;
    const pending = returns.filter((ret) => selectedIds.includes(ret.invoice_id) && ret.status === "pending");
    if (pending.length === 0) return void toast.error("Select pending returns to review");

    let reason = "";
    if (action === "reject") {
      const input = prompt("Reason for rejection (optional):");
      if (input === null) return;
      reason = input;
    } else if (!(await confirmAction(`Accept ${pending.length} selected ${pending.length === 1 ? "return" : "returns"}?`))) {
      return;
    }

    await decideReturns(pending, action, reason);
    setSelectedIds([]);
  };

  if (isAgent) {
    return (
      <AgentLogReturnScreen
        invoices={invoices}
        customers={customers}
        products={products}
        token={token!}
      />
    );
  }

  const filtered = newestFirst(returns.filter((ret) => {
    const invoice = invoices.find((entry) => entry.id === ret.invoice_id);
    const customer = customers.find((entry) => entry.id === ret.customer_id);
    const query = searchTerm.trim().toLowerCase();
    const matchesSearch = !query || [ret.id, invoice?.receipt_number, ret.customer_id, customer?.store_name, ret.product_name, ret.reason]
      .some((value) => value?.toLowerCase().includes(query));
    const matchesDate = !dateFilter || new Date(ret.created_at).toLocaleDateString("en-CA") === dateFilter;
    return matchesSearch && matchesDate && (statusFilter === "all" || ret.status === statusFilter);
  }));

  const pendingCount  = returns.filter((r) => r.status === "pending").length;
  const acceptedCount = returns.filter((r) => r.status === "accepted").length;
  const rejectedCount = returns.filter((r) => r.status === "rejected").length;

  const orderGroups = Array.from(
    filtered.reduce((groups, ret) => groups.set(ret.invoice_id, [...(groups.get(ret.invoice_id) ?? []), ret]), new Map<string, AgentReturn[]>()),
  ).map(([invoiceId, orderReturns]) => ({
    invoiceId,
    receipt: invoices.find((entry) => entry.id === invoiceId)?.receipt_number || invoiceId.slice(0, 8).toUpperCase(),
    customerId: orderReturns[0].customer_id,
    returns: orderReturns,
  }));
  const viewingReturns = returns.filter((ret) => ret.invoice_id === viewingOrder);

  const { currentPage, totalPages, pageItems: paginated } = paginate(orderGroups, page);
  const pageIds = paginated.map((group) => group.invoiceId);
  const allPageSelected = pageIds.length > 0 && pageIds.every((id) => selectedIds.includes(id));
  const toggleOrderSelection = (invoiceId: string, checked: boolean) =>
    setSelectedIds((current) => (checked ? [...current, invoiceId] : current.filter((selectedId) => selectedId !== invoiceId)));
  const togglePageSelection = (checked: boolean) =>
    setSelectedIds((current) => (checked ? Array.from(new Set([...current, ...pageIds])) : current.filter((id) => !pageIds.includes(id))));
  const bulkActions: TableBulkAction[] | undefined = canDecideReturns
    ? [
        { label: "Accept selected returns", onSelect: () => void processSelected("accept") },
        { label: "Reject selected returns", onSelect: () => void processSelected("reject"), destructive: true },
      ]
    : undefined;

  return (
    <>
    <div className="flex-1 px-4 md:px-6 lg:px-7 py-4 md:py-6 overflow-y-auto space-y-6">

      <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-4">
        <div>
          <h1 className="page-title">Returns</h1>
          <p className="page-subtitle">Manage returned goods — restock or write off</p>
        </div>
        <div className="flex gap-2">
          <Button onClick={() => setShowCreate(true)}
            variant="default">
            <RotateCcw size={15} /> Log Return
          </Button>
        </div>
      </div>

      {error && (
        <div className="rounded-lg border border-red/30 bg-red/10 px-4 py-2 text-xs text-red">{error}</div>
      )}

      <div className="grid grid-cols-3 gap-4">
        <div className="bg-card border border-border rounded-2xl p-4">
          <div className="text-2xl font-bold text-warning">{pendingCount}</div>
          <div className="text-xs text-muted-foreground font-semibold tracking-tight mt-1">Pending Review</div>
        </div>
        <div className="bg-card border border-border rounded-2xl p-4">
          <div className="text-2xl font-bold text-green">{acceptedCount}</div>
          <div className="text-xs text-muted-foreground font-semibold tracking-tight mt-1">Accepted</div>
        </div>
        <div className="bg-card border border-border rounded-2xl p-4">
          <div className="text-2xl font-bold text-red">{rejectedCount}</div>
          <div className="text-xs text-muted-foreground font-semibold tracking-tight mt-1">Rejected</div>
        </div>
      </div>

      <div className="flex flex-col gap-3">
        <TableToolbar
          selectedCount={selectedIds.length}
          bulkActions={bulkActions}
          searchValue={searchTerm}
          onSearchChange={(value) => { setSearchTerm(value); setPage(1); }}
          searchPlaceholder="Search order, customer, product…"
        >
          <ToggleGroup
            type="single"
            value={statusFilter}
            onValueChange={(value) => { if (value) { setStatusFilter(value as typeof statusFilter); setPage(1); } }}
            aria-label="Filter returns by status"
            className="hide-scrollbar w-fit max-w-full justify-start overflow-x-auto rounded-full border border-border bg-card p-1"
          >
            {(["all", "pending", "accepted", "rejected"] as const).map((s) => (
              <ToggleGroupItem key={s} value={s} variant="pill" size="sm" className="capitalize">
                {s}
              </ToggleGroupItem>
            ))}
          </ToggleGroup>
          <input type="date" aria-label="Logged on date" title="Show returns logged on this date" value={dateFilter} onChange={(event) => { setDateFilter(event.target.value); setPage(1); }} className="rounded-full border border-border bg-card px-3 py-2 text-sm text-foreground focus:border-accent-2 focus:outline-none" />
        </TableToolbar>
      </div>

      <div className="data-table-frame overflow-hidden">
        {loading ? (
          <LoadingSpinner className="min-h-32" />
        ) : (
          <div className="overflow-x-auto">
            <Table>
              <thead>
                <tr>
                  {canDecideReturns && (
                    <th className="w-10 bg-navy-mid px-3 py-3 text-left border-b border-border">
                      <input aria-label="Select all orders on this page" type="checkbox" checked={allPageSelected} onChange={(event) => togglePageSelection(event.target.checked)} />
                    </th>
                  )}
                  {["Date", "Order", "Customer", "Items", "Status", "Actions"].map((h) => (
                    <th key={h} className="bg-navy-mid text-muted-foreground font-barlow-cond text-xs font-bold px-3 py-3 text-left border-b border-border whitespace-nowrap">
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {paginated.length === 0 ? (
                  <tr>
                    <td colSpan={canDecideReturns ? 7 : 6} className="px-6 py-8 text-center text-muted-foreground">
                      {returns.length === 0 ? "No returns logged yet." : "No records match this filter."}
                    </td>
                  </tr>
                ) : (
                  paginated.map((group) => {
                    const cust = customers.find((c) => c.id === group.customerId);
                    const pendingInOrder = group.returns.filter((ret) => ret.status === "pending").length;
                    const reviewedAt = group.returns.reduce<string | null>((latest, ret) => (ret.reviewed_at && (!latest || ret.reviewed_at > latest) ? ret.reviewed_at : latest), null);
                    return (
                      <tr key={group.invoiceId} className="border-b border-border hover:bg-accent/40 transition-colors align-top">
                        {canDecideReturns && (
                          <td className="w-10 px-3 py-3">
                            <input aria-label={`Select order ${group.receipt}`} type="checkbox" checked={selectedIds.includes(group.invoiceId)} onChange={(event) => toggleOrderSelection(group.invoiceId, event.target.checked)} />
                          </td>
                        )}
                        <td className="px-3 py-3 text-muted-foreground whitespace-nowrap">
                          {new Date(group.returns[0].created_at).toLocaleDateString("en-PH")}
                        </td>
                        <td className="px-3 py-3 font-mono text-foreground">
                          <RecordTitleButton onClick={() => setViewingOrder(group.invoiceId)} className="font-mono">
                            {group.receipt}
                          </RecordTitleButton>
                        </td>
                        <td className="px-3 py-3 text-foreground font-semibold">
                          {cust?.store_name || group.customerId.slice(0, 8)}
                          {cust?.contact_person && (
                            <p className="text-xs text-muted-foreground font-normal">{cust.contact_person}</p>
                          )}
                        </td>
                        <td className="px-3 py-3 text-foreground">
                          <ul className="space-y-1">
                            {group.returns.map((ret) => (
                              <li key={ret.id} className="flex flex-wrap items-center gap-2">
                                <span>{ret.product_name}</span>
                                <span className="font-semibold">×{ret.qty_returned}</span>
                                <span className={`px-2 py-0.5 rounded text-xs font-semibold ${returnTypeBadge(ret.return_type)}`}>
                                  {ret.return_type === "damaged" ? "Damaged" : "Good"}
                                </span>
                                {ret.status === "accepted" && ret.return_type === "good" && (
                                  <span className="text-xs text-muted-foreground">
                                    {ret.restored_to_pallet_id ? "Restocked ✓" : "Written off"}
                                  </span>
                                )}
                              </li>
                            ))}
                          </ul>
                        </td>
                        <td className="px-3 py-3">
                          <div className="flex flex-wrap gap-1">
                            {(["pending", "accepted", "rejected"] as const).map((status) => {
                              const count = group.returns.filter((ret) => ret.status === status).length;
                              return count > 0 ? <StatusBadge key={status} label={`${count} ${status}`} tone={returnStatusTone(status)} /> : null;
                            })}
                          </div>
                        </td>
                        <td className="px-3 py-3">
                          {pendingInOrder > 0 && canDecideReturns ? (
                            <div className="flex gap-1">
                              <Button
                                disabled={processing === group.invoiceId}
                                onClick={() => decideOrder(group.invoiceId, "accept")}
                                variant="success" size="sm"
                              >
                                <CheckCircle size={12} /> Accept
                              </Button>
                              <Button
                                disabled={processing === group.invoiceId}
                                onClick={() => decideOrder(group.invoiceId, "reject")} variant="danger" size="sm" className="h-8 gap-1 px-2 text-xs">
                                <XCircle size={12} /> Reject
                              </Button>
                            </div>
                          ) : (
                            <span className="text-xs text-muted-foreground">
                              {reviewedAt ? new Date(reviewedAt).toLocaleDateString("en-PH") : "—"}
                            </span>
                          )}
                        </td>
                      </tr>
                    );
                  })
                )}
              </tbody>
            </Table>
          </div>
        )}
        <TablePagination page={currentPage} totalPages={totalPages} totalItems={filtered.length} onPageChange={setPage} />
      </div>

    </div>
      {viewingOrder && (
        <PageDialog onClose={() => setViewingOrder(null)} label="Order details">
          <OrderInfo
            invoiceId={viewingOrder}
            invoice={invoices.find((entry) => entry.id === viewingOrder)}
            customerName={customers.find((entry) => entry.id === viewingReturns[0]?.customer_id)?.store_name ?? viewingReturns[0]?.customer_id.slice(0, 8) ?? "—"}
            returns={viewingReturns}
            onClose={() => setViewingOrder(null)}
          />
        </PageDialog>
      )}
      {showCreate && (
        <PageDialog onClose={() => setShowCreate(false)} label="Log return">
      <CreateReturnModal
        invoices={invoices}
        customers={customers}
        products={products}
        token={token!}
        onClose={() => setShowCreate(false)}
        onCreated={fetchAll}
      />
        </PageDialog>
      )}
    </>
  );
}
