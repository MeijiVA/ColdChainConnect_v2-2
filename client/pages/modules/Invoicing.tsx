import { Button } from "@/components/ui/button";
import { useNewRows } from "@/lib/unseen";
import { useState, useEffect } from "react";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { LoadingSpinner } from "@/components/LoadingSpinner";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Printer, Calendar, ArrowLeft } from "lucide-react";
import { useAutoRefresh } from "@/hooks/useAutoRefresh";
import { RecordTitleButton } from "@/components/RecordTitleButton";
import { TableFilterSelect, TableToolbar, type TableBulkAction } from "@/components/TableToolbar";
import { Checkbox } from "@/components/ui/checkbox";
import { newestFirst } from "@/components/SortableHeader";
import { TablePagination, paginate } from "@/components/TablePagination";
import { Invoice, InvoiceItem, BookingItem } from "@shared/api";
import { localScheduleDate } from "@/lib/agentSchedule";
import { useAuth } from "../../hooks/useAuth";

// ─── Printable Receipt Modal ───────────────────────────────────────────────

interface ReceiptModalProps {
  invoice: Invoice;
  onClose?: () => void;
  printOnly?: boolean;
}

function ReceiptModal({ invoice, onClose, printOnly = false }: ReceiptModalProps) {
  // Use snapshotted invoice_items; fall back to booking_items for legacy invoices
  const items: InvoiceItem[] = invoice.invoice_items && invoice.invoice_items.length > 0
    ? invoice.invoice_items
    : (invoice.booking?.booking_items || []).map((bi, idx) => ({
        id: `legacy-${idx}`,
        invoice_id: invoice.id,
        product_id: bi.product_id,
        product_name: bi.product?.name || bi.product_id,
        product_sku: bi.product?.sku || null,
        qty_ordered: bi.qty_ordered,
        unit_price: bi.product?.price || "0",
        unit_weight_kg: bi.product?.weight ?? null,
        unit_label: bi.product?.unit ?? null,
        amount: String(parseFloat(bi.product?.price || "0") * bi.qty_ordered),
        created_at: invoice.created_at,
      }));

  // Resolve customer fields — prefer snapshot, fall back to booking.customer
  const customerName    = invoice.customer_name    || invoice.booking?.customer?.store_name  || "—";
  const customerAddress = invoice.customer_address || invoice.booking?.customer?.location    || "—";
  const customerTerms   = invoice.customer_payment_type || invoice.booking?.customer?.payment_type || "COD";

  // Recompute totals from items if snapshot amounts are zero/missing
  const snapshotGross = parseFloat(invoice.gross_amount || "0");
  const computedGross = items.reduce((s, i) => s + parseFloat(i.amount), 0);
  const gross    = snapshotGross > 0 ? snapshotGross : computedGross;
  const DISCOUNT = parseFloat(invoice.discount_rate || "0.02");
  const discount = parseFloat(invoice.discount_amount || "0") || gross * DISCOUNT;
  const total    = parseFloat(invoice.total_amount    || "0") || gross - discount;
  const creditApplied = Math.min(total, Math.max(0, parseFloat(invoice.credit_applied_amount || "0")));
  const amountDue = Math.max(0, total - creditApplied);
  // kg comes from each product's weight frozen on the invoice; older receipts have none and show a dash.
  const lineKg = (item: InvoiceItem): number | null => {
    const unitKg = item.unit_weight_kg == null ? null : parseFloat(item.unit_weight_kg);
    return unitKg === null || Number.isNaN(unitKg) ? null : unitKg * item.qty_ordered;
  };
  const totalKg  = items.reduce((s, i) => s + (lineKg(i) ?? 0), 0);
  const kgLabel  = (n: number) => n.toLocaleString("en-PH", { maximumFractionDigits: 2 });

  const date = new Date(invoice.created_at).toLocaleDateString("en-US", {
    month: "numeric", day: "numeric", year: "numeric",
  });

  const fmt = (n: number) =>
    n.toLocaleString("en-PH", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

  return (
    <div className={printOnly ? "receipt-bulk-document" : "flex-1 flex flex-col gap-6 p-4 md:p-6"}>
      {!printOnly && (
        <div className="page-header no-print">
          <div>
            <h1 className="page-title">Delivery Receipt</h1>
          </div>
          <div className="flex gap-2 items-center">
            <Button onClick={() => window.print()} variant="default">
              <Printer size={16} /> Print
            </Button>
            <Button onClick={() => onClose?.()} variant="outline">
              <ArrowLeft size={15} />
              Back
            </Button>
          </div>
        </div>
      )}

      <div className="max-w-3xl w-full rounded-2xl border border-border bg-white text-black">
        <div className="receipt-print-area p-6 font-sans text-black">
          <style>{printOnly ? `
            @media print {
              body * { visibility: hidden !important; }
              .receipt-bulk-print, .receipt-bulk-print * { visibility: visible !important; }
              .receipt-bulk-print { display: block !important; position: absolute; inset: 0; width: 100%; }
              .receipt-bulk-print .receipt-bulk-document { display: block !important; }
              .receipt-bulk-print .receipt-bulk-document:not(:last-child) { break-after: page; page-break-after: always; }
              .receipt-bulk-print .receipt-print-area { position: static; width: 100%; padding: 24px; }
              .no-print { display: none !important; }
            }
          ` : `
            @media print {
              body * { visibility: hidden; }
              .receipt-print-area, .receipt-print-area * { visibility: visible; }
              .receipt-print-area { position: fixed; top: 0; left: 0; width: 100%; padding: 24px; }
              .no-print { display: none !important; }
            }
          `}</style>

          {/* ── Company Header ── */}
          <div className="flex items-start justify-between mb-0.5">
            <div>
              <div className="text-2xl font-black tracking-wide uppercase leading-tight">
                ACDP CONSUMER GOODS TRADING
              </div>
              <div className="text-xs text-muted-foreground mt-0.5">
                Seniorita St. Saguin 2000 City of San Fernando (Capital) Pampanga Philippines
              </div>
            </div>
            {/* Logo placeholder matching reference */}
            <div className="ml-4 shrink-0 border border-border px-3 py-1 text-center">
              <div className="text-sm font-black tracking-widest text-foreground">ACDP</div>
              <div className="text-2xs text-muted-foreground">Consumer Goods Trading</div>
            </div>
          </div>

          {/* ── Receipt number / title ── */}
          <div className="flex justify-end mt-1 mb-2">
            <div className="text-right">
              <div className="text-xs font-bold">DELIVERY RECEIPT</div>
              <div className="text-sm font-bold text-destructive">
                No. {invoice.receipt_number || invoice.id.slice(0, 8).toUpperCase()}
              </div>
            </div>
          </div>

          {/* ── Sold To / Date block ── */}
          <div className="border border-black text-xs">
            <div className="flex border-b border-black">
              <div className="w-24 shrink-0 border-r border-black px-2 py-1.5 font-bold">SOLD TO:</div>
              <div className="flex-1 border-r border-black px-2 py-1.5 font-bold text-center uppercase">
                {customerName}
              </div>
              <div className="flex items-center px-3 py-1.5 gap-6">
                <span className="font-bold">DATE:</span>
                <span>{date}</span>
              </div>
            </div>
            <div className="flex">
              <div className="w-24 shrink-0 border-r border-black px-2 py-1.5 font-bold">ADDRESS:</div>
              <div className="flex-1 border-r border-black px-2 py-1.5">
                {customerAddress}
              </div>
              <div className="flex items-center px-3 py-1.5 gap-6">
                <span className="font-bold">TERMS:</span>
                <span>{customerTerms.toUpperCase()}</span>
              </div>
            </div>
          </div>

          {/* ── Line Items Table ── */}
          <table className="w-full border-collapse text-xs border-l border-r border-b border-black">
            <thead>
              <tr className="border-b border-black">
                <th className="border-r border-black px-2 py-1 text-center font-bold w-12">QTY</th>
                <th className="border-r border-black px-2 py-1 text-center font-bold w-12">kg</th>
                <th className="border-r border-black px-2 py-1 text-center font-bold w-12">UNIT</th>
                <th className="border-r border-black px-2 py-1 text-left font-bold">DESCRIPTION</th>
                <th className="border-r border-black px-2 py-1 text-center font-bold w-24">SKU CODE</th>
                <th className="border-r border-black px-2 py-1 text-right font-bold w-24">UNIT PRICE</th>
                <th className="px-2 py-1 text-right font-bold w-28">AMOUNT</th>
              </tr>
            </thead>
            <tbody>
              {items.map((item, idx) => (
                <tr key={item.id || idx} className="border-b border-black">
                  <td className="border-r border-black px-2 py-1 text-center">{item.qty_ordered}</td>
                  <td className="border-r border-black px-2 py-1 text-center">{lineKg(item) === null ? "—" : kgLabel(lineKg(item)!)}</td>
                  <td className="border-r border-black px-2 py-1 text-center">{item.unit_label || "PK"}</td>
                  <td className="border-r border-black px-2 py-1">{item.product_name}</td>
                  <td className="border-r border-black px-2 py-1 text-center">{item.product_sku || "—"}</td>
                  <td className="border-r border-black px-2 py-1 text-right">
                    ₱ {fmt(parseFloat(item.unit_price))}
                  </td>
                  <td className="px-2 py-1 text-right">
                    ₱ {fmt(parseFloat(item.amount))}
                  </td>
                </tr>
              ))}
              {/* Padding rows to match receipt style */}
              {Array.from({ length: Math.max(0, 8 - items.length) }).map((_, i) => (
                <tr key={`pad-${i}`} className="border-b border-black">
                  <td className="border-r border-black px-2 py-2">&nbsp;</td>
                  <td className="border-r border-black px-2 py-2"></td>
                  <td className="border-r border-black px-2 py-2"></td>
                  <td className="border-r border-black px-2 py-2"></td>
                  <td className="border-r border-black px-2 py-2"></td>
                  <td className="border-r border-black px-2 py-2"></td>
                  <td className="px-2 py-2"></td>
                </tr>
              ))}
              {/* Gross row */}
              <tr className="border-b border-black">
                <td className="border-r border-black px-2 py-1" colSpan={5}></td>
                <td className="border-r border-black px-2 py-1 text-right font-bold">GROSS</td>
                <td className="px-2 py-1 text-right">₱ {fmt(gross)}</td>
              </tr>
              {/* Less discount row */}
              <tr>
                <td className="border-r border-black px-2 py-1" colSpan={5}></td>
                <td className="border-r border-black px-2 py-1 text-right font-bold">
                  LESS {Number((parseFloat(invoice.discount_rate || "0.02") * 100).toFixed(2))}%
                </td>
                <td className="px-2 py-1 text-right">{fmt(discount)}</td>
              </tr>
              {creditApplied > 0 && (
                <tr>
                  <td className="border-r border-black px-2 py-1" colSpan={5}></td>
                  <td className="border-r border-black px-2 py-1 text-right font-bold">CREDIT APPLIED</td>
                  <td className="px-2 py-1 text-right">−{fmt(creditApplied)}</td>
                </tr>
              )}
            </tbody>
          </table>

          {/* ── Total Footer ── */}
          <div className="border-l border-r border-b border-black flex items-stretch text-sm">
            <div className="border-r border-black px-3 py-2 flex items-center gap-3">
              <span className="text-xs font-bold">TOTAL kg</span>
              <span className="text-base font-extrabold">{kgLabel(totalKg)}</span>
            </div>
            <div className="flex-1 flex items-center justify-center py-2">
              <span className="font-extrabold uppercase tracking-wide">TOTAL AMOUNT DUE</span>
            </div>
            <div className="px-4 py-2 flex items-center">
              <span className="text-base font-extrabold">₱ {fmt(amountDue)}</span>
            </div>
          </div>

          {/* ── Signatures ── */}
          <div className="border-l border-r border-b border-black flex text-xs">
            <div className="flex-1 border-r border-black px-3 py-4">
              <span className="font-bold">PREPARED BY:</span>
              {invoice.prepared_by && (
                <span className="ml-2">{invoice.prepared_by}</span>
              )}
            </div>
            <div className="flex-1 px-3 py-4 text-right">
              <span className="font-bold">RECEIVED BY:</span>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

// ─── Main Invoicing Component ──────────────────────────────────────────────

export function Invoicing() {
  const isNewRow = useNewRows("receipts");
  const [invoices, setInvoices] = useState<Invoice[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const { token, user } = useAuth();
  const isAdmin = user?.role === "admin";
  const [searchTerm, setSearchTerm] = useState("");
  const [statusFilter, setStatusFilter] = useState<"all" | "draft" | "issued" | "paid">("all");
  const [paymentFilter, setPaymentFilter] = useState<"all" | "paid" | "partial" | "unpaid">("all");
  const [printDate, setPrintDate] = useState(() => localScheduleDate(new Date()));
  const [dateRangeFilter, setDateRangeFilter] = useState<"all" | "today" | "week" | "month" | "custom">("all");
  const [customDateStart, setCustomDateStart] = useState("");
  const [customDateEnd, setCustomDateEnd] = useState("");
  const [receiptInvoice, setReceiptInvoice] = useState<Invoice | null>(null);
  const [page, setPage] = useState(1);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => new Set());
  const [bulkPrint, setBulkPrint] = useState<Invoice[] | null>(null);

  useEffect(() => {
    setPage(1);
    setSelectedIds(new Set());
  }, [searchTerm, statusFilter, paymentFilter, dateRangeFilter, customDateStart, customDateEnd]);

  useEffect(() => {
    if (!bulkPrint) return;
    const clearBulkPrint = () => setBulkPrint(null);
    window.addEventListener("afterprint", clearBulkPrint, { once: true });
    window.print();
    return () => window.removeEventListener("afterprint", clearBulkPrint);
  }, [bulkPrint]);

  const fetchInvoices = async () => {
    try {
      const res = await fetch("/api/invoices", {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) throw new Error("Failed to fetch invoices");
      setInvoices(await res.json());
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Error loading invoices");
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => { if (token) fetchInvoices(); }, [token]);
  useAutoRefresh(fetchInvoices, { enabled: Boolean(token) });

  const getStatusColor = (status: string) => ({
    draft:  "bg-muted text-foreground",
    issued: "bg-info-soft text-link",
    paid:   "bg-success-soft text-success",
  }[status] || "bg-muted text-foreground");

  const isDateInRange = (dateStr: string): boolean => {
    if (dateRangeFilter === "all") return true;
    const d = new Date(dateStr);
    const now = new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const dOnly = new Date(d.getFullYear(), d.getMonth(), d.getDate());
    if (dateRangeFilter === "today") return dOnly.getTime() === today.getTime();
    if (dateRangeFilter === "week") {
      const ws = new Date(today); ws.setDate(today.getDate() - today.getDay());
      const we = new Date(ws);    we.setDate(ws.getDate() + 6);
      return dOnly >= ws && dOnly <= we;
    }
    if (dateRangeFilter === "month") return d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth();
    if (dateRangeFilter === "custom") {
      if (!customDateStart || !customDateEnd) return true;
      const end = new Date(customDateEnd); end.setHours(23, 59, 59, 999);
      return d >= new Date(customDateStart) && d <= end;
    }
    return true;
  };

  if (isLoading) return <LoadingSpinner />;

  if (receiptInvoice) return <ReceiptModal invoice={receiptInvoice} onClose={() => setReceiptInvoice(null)} />;

  const filtered = newestFirst(invoices.filter((inv) => {
    const matchSearch =
      inv.id.toLowerCase().includes(searchTerm.toLowerCase()) ||
      inv.booking_id.toLowerCase().includes(searchTerm.toLowerCase()) ||
      (inv.customer_name || "").toLowerCase().includes(searchTerm.toLowerCase());
    if (!matchSearch) return false;
    if (statusFilter !== "all" && inv.status !== statusFilter) return false;
    if (paymentFilter !== "all" && inv.payment_status !== paymentFilter) return false;
    if (!isDateInRange(inv.created_at)) return false;
    return true;
  }));

  const { currentPage, totalPages, pageItems: paginated } = paginate(filtered, page);
  const printInvoices = invoices.filter((invoice) => localScheduleDate(new Date(invoice.created_at)) === printDate);
  const selectedInvoices = filtered.filter((invoice) => selectedIds.has(invoice.id));
  const bulkActions: TableBulkAction[] = [{ label: "Print selected", onSelect: () => setBulkPrint(selectedInvoices) }];

  return (
    <div className="flex-1 flex flex-col p-6 gap-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="page-title">Receipts</h1>
          <p className="page-subtitle">Print and review delivery receipts</p>
        </div>
        {isAdmin && (
          <div className="flex flex-wrap items-center gap-2">
            <label className="flex items-center gap-2 rounded-lg border border-border bg-card px-3 py-2 text-sm text-muted-foreground">
              <span>Date</span>
              <Input type="date" value={printDate} onChange={(event) => setPrintDate(event.target.value)} className="h-auto w-auto border-0 bg-transparent p-0 text-foreground focus-visible:ring-0 focus-visible:ring-offset-0" />
            </label>
            <Button onClick={() => window.print()} disabled={printInvoices.length === 0} variant="outline" className="flex items-center gap-2">
              <Printer size={16} /> Print all ({printInvoices.length})
            </Button>
          </div>
        )}
      </div>

      {error && (
        <Card className="p-4 bg-destructive-soft border-destructive/30">
          <p className="text-destructive">{error}</p>
        </Card>
      )}

      <TableToolbar
        selectedCount={selectedInvoices.length}
        bulkActions={isAdmin ? bulkActions : undefined}
        searchValue={searchTerm}
        onSearchChange={setSearchTerm}
        searchPlaceholder="Search by invoice ID, booking ID, or customer…"
      >
        <TableFilterSelect label="Status" value={statusFilter} onChange={(value) => setStatusFilter(value as typeof statusFilter)}>
          <option value="all">All Status</option>
          <option value="draft">Draft</option>
          <option value="issued">Issued</option>
          <option value="paid">Paid</option>
        </TableFilterSelect>
        <TableFilterSelect label="Payment" value={paymentFilter} onChange={(value) => setPaymentFilter(value as typeof paymentFilter)}>
          <option value="all">All Payments</option>
          <option value="paid">Paid</option>
          <option value="partial">Partially paid</option>
          <option value="unpaid">Unpaid</option>
        </TableFilterSelect>
        <TableFilterSelect label="Date range" value={dateRangeFilter} onChange={(value) => setDateRangeFilter(value as typeof dateRangeFilter)}>
          <option value="all">All Dates</option>
          <option value="today">This Day</option>
          <option value="week">This Week</option>
          <option value="month">This Month</option>
          <option value="custom">Custom</option>
        </TableFilterSelect>
      </TableToolbar>

      {dateRangeFilter === "custom" && (
        <div className="flex flex-col sm:flex-row gap-3 items-end">
          <div className="flex-1">
            <label className="block text-sm font-medium text-foreground mb-1">Start Date</label>
            <div className="flex items-center gap-2 rounded-full border border-border bg-card px-4">
              <Calendar size={16} className="text-muted-foreground" />
              <Input type="date" value={customDateStart} onChange={(e) => setCustomDateStart(e.target.value)}
                className="flex-1 bg-transparent border-none py-2 text-sm text-foreground outline-none" />
            </div>
          </div>
          <div className="flex-1">
            <label className="block text-sm font-medium text-foreground mb-1">End Date</label>
            <div className="flex items-center gap-2 rounded-full border border-border bg-card px-4">
              <Calendar size={16} className="text-muted-foreground" />
              <Input type="date" value={customDateEnd} onChange={(e) => setCustomDateEnd(e.target.value)}
                className="flex-1 bg-transparent border-none py-2 text-sm text-foreground outline-none" />
            </div>
          </div>
        </div>
      )}

      <Card className="overflow-hidden rounded-xl shadow-sm">
        <Table>
          <TableHeader>
            <TableRow>
              {isAdmin && (
                <TableHead className="w-10">
                  <Checkbox
                    aria-label="Select all receipts on this page"
                    checked={paginated.length > 0 && paginated.every((inv) => selectedIds.has(inv.id))}
                    onCheckedChange={(checked) => setSelectedIds((current) => {
                      const next = new Set(current);
                      for (const inv of paginated) {
                        if (checked) next.add(inv.id);
                        else next.delete(inv.id);
                      }
                      return next;
                    })}
                  />
                </TableHead>
              )}
              <TableHead>Receipt No.</TableHead>
              <TableHead>Order / Booking</TableHead>
              <TableHead>Customer</TableHead>
              <TableHead>Items</TableHead>
              <TableHead>Gross</TableHead>
              <TableHead>Total Due</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Payment</TableHead>
              <TableHead>Date</TableHead>
              <TableHead className="text-right">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {paginated.length === 0 ? (
              <TableRow>
                <TableCell colSpan={isAdmin ? 11 : 10} className="text-center py-8 text-muted-foreground">
                  {invoices.length === 0 ? "No invoices found" : "No invoices match your search"}
                </TableCell>
              </TableRow>
            ) : (
              paginated.map((inv) => {
                const itemCount = inv.invoice_items?.length ?? 0;
                const legacyItems = inv.booking?.booking_items ?? [];
                const snapshotGross = parseFloat(inv.gross_amount || "0");
                const computedGross = itemCount > 0
                  ? snapshotGross
                  : legacyItems.reduce((s, bi) => s + parseFloat(bi.product?.price || "0") * bi.qty_ordered, 0);
                const gross = snapshotGross > 0 ? snapshotGross : computedGross;
                const DISCOUNT = parseFloat(inv.discount_rate || "0.02");
                const snapshotTotal = parseFloat(inv.total_amount || "0");
                const total = snapshotTotal > 0 ? snapshotTotal : gross * (1 - DISCOUNT);
                const amountDue = Math.max(0, total - Number(inv.credit_applied_amount || 0));
                const fmt = (n: number) =>
                  n.toLocaleString("en-PH", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
                return (
                  <TableRow key={inv.id} className={isNewRow(inv.created_at) ? "row-new" : undefined}>
                    {isAdmin && (
                      <TableCell>
                        <Checkbox
                          aria-label={`Select receipt ${inv.receipt_number || inv.id.slice(0, 8).toUpperCase()}`}
                          checked={selectedIds.has(inv.id)}
                          onCheckedChange={(checked) => setSelectedIds((current) => {
                            const next = new Set(current);
                            if (checked) next.add(inv.id);
                            else next.delete(inv.id);
                            return next;
                          })}
                        />
                      </TableCell>
                    )}
                    <TableCell className="font-mono text-sm font-semibold">
                      <RecordTitleButton onClick={() => setReceiptInvoice(inv)}>
                        {inv.receipt_number || inv.id.slice(0, 8).toUpperCase()}
                      </RecordTitleButton>
                    </TableCell>
                    <TableCell>
                      <div className="flex flex-col gap-0.5">
                        <span className="font-mono text-xs font-semibold text-foreground bg-muted px-1.5 py-0.5 rounded w-fit">
                          {inv.booking_id.slice(0, 8).toUpperCase()}
                        </span>
                        {inv.booking?.customer?.store_name && !inv.customer_name && (
                          <span className="text-xs text-muted-foreground">{inv.booking.customer.store_name}</span>
                        )}
                      </div>
                    </TableCell>
                    <TableCell>
                      <div className="flex flex-col">
                        <span className="text-sm font-semibold text-foreground">
                          {inv.customer_name || inv.booking?.customer?.store_name || "—"}
                        </span>
                        {(inv.customer_address || inv.booking?.customer?.location) && (
                          <span className="text-xs text-muted-foreground">
                            {inv.customer_address || inv.booking?.customer?.location}
                          </span>
                        )}
                      </div>
                    </TableCell>
                    <TableCell className="text-sm text-muted-foreground">
                      {(() => {
                        const count = itemCount > 0 ? itemCount : legacyItems.length;
                        return <>{count} item{count !== 1 ? "s" : ""}</>;
                      })()}
                    </TableCell>
                    <TableCell className="text-sm">₱ {fmt(gross)}</TableCell>
                    <TableCell className="text-sm font-semibold text-foreground">₱ {fmt(amountDue)}</TableCell>
                    <TableCell>
                      <span className={`px-2 py-1 rounded text-xs font-semibold ${getStatusColor(inv.status)}`}>
                        {inv.status}
                      </span>
                    </TableCell>
                    <TableCell>
                      <span className={`px-2 py-1 rounded text-xs font-semibold ${
                        inv.payment_status === "paid"
                          ? "bg-success-soft text-success"
                          : inv.payment_status === "partial"
                            ? "bg-info-soft text-link"
                            : "bg-warning-soft text-warning"
                      }`}>
                        {inv.payment_status}
                      </span>
                    </TableCell>
                    <TableCell className="text-sm">
                      {new Date(inv.created_at).toLocaleDateString()}
                    </TableCell>
                    <TableCell className="text-right">
                      <Button
                        onClick={() => setReceiptInvoice(inv)}
                        variant="default" size="sm" className="ml-auto"
                      >
                        <Printer size={14} /> Print
                      </Button>
                    </TableCell>
                  </TableRow>
                );
              })
            )}
          </TableBody>
        </Table>
        <TablePagination page={currentPage} totalPages={totalPages} totalItems={filtered.length} onPageChange={setPage} />
      </Card>

      {isAdmin && (
        <div className="hidden receipt-bulk-print" aria-hidden="true">
          {(bulkPrint ?? printInvoices).map((invoice) => <ReceiptModal key={invoice.id} invoice={invoice} printOnly />)}
        </div>
      )}
    </div>
  );
}
