import { useCallback, useEffect, useState } from "react";
import { BadgeCheck, Printer } from "lucide-react";
import { createPortal } from "react-dom";
import { Link, useSearchParams } from "react-router-dom";
import { toast } from "sonner";
import { paymentNeedsClearance, todayInManila, type PaymentAgentOption, type UnverifiedPayment } from "@shared/api";
import { PageDialog } from "@/components/shared/PageDialog";
import { LoadingSpinner } from "@/components/LoadingSpinner";
import { TablePagination, paginate } from "@/components/TablePagination";
import { TableToolbar, type TableBulkAction } from "@/components/TableToolbar";
import { NativeSelect } from "@/components/ui/native-select";
import { Checkbox } from "@/components/ui/checkbox";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Textarea } from "@/components/ui/textarea";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { TruncatedText } from "@/components/ui/truncated-text";
import { useAutoRefresh } from "@/hooks/useAutoRefresh";
import { useAuth } from "@/hooks/useAuth";
import { useCan } from "@/hooks/useCan";
import { formatPeso, responseError } from "@/lib/format";
import { useNewRows } from "@/lib/unseen";
import { formatPeriod, parsePeriod, periodBounds } from "@/lib/paymentPeriod";
import { PaymentPeriodFilter } from "./PaymentPeriodFilter";
import { BulkVerifyDialog } from "./BulkVerifyDialog";

const formatDate = (value: string) => new Date(value).toLocaleDateString("en-PH");
const paymentAgentId = (payment: UnverifiedPayment) =>
  payment.agent_user_id ?? (payment.recorded_by_role === "agent" ? payment.recorded_by : null);
const businessDate = (value: string) => new Date(new Date(value).getTime() + 8 * 60 * 60 * 1000).toISOString().slice(0, 10);

function PaymentPrintSheet({ payments, periodText }: { payments: UnverifiedPayment[]; periodText: string }) {
  const total = payments.reduce((sum, payment) => sum + Number(payment.amount), 0);

  return (
    <div id="payment-print-area" aria-hidden="true" className="hidden bg-white p-4 font-sans text-black print:block">
      <style>{`
        @media print {
          @page { size: auto; margin: 0.35in; }
          html, body { height: auto !important; overflow: visible !important; background: #fff !important; }
          body * { visibility: hidden !important; }
          #payment-print-area, #payment-print-area * { visibility: visible !important; }
          #payment-print-area { position: absolute !important; top: 0; left: 0; width: 100%; padding: 0 !important; background: #fff !important; color: #111 !important; }
          #payment-print-area tr, #payment-print-area th, #payment-print-area td { break-inside: avoid; }
        }
      `}</style>
      <h1 className="text-xl font-black">End-of-Day</h1>
      <p className="mb-4 text-sm">{periodText}</p>
      <table className="w-full border-collapse text-xs">
        <thead><tr className="border-b border-black text-left"><th className="py-1">Customer</th><th className="py-1">Receipt / invoice</th><th className="py-1">Recorded by</th><th className="py-1">Method</th><th className="py-1 text-right">Amount</th></tr></thead>
        <tbody>
          {payments.map((payment) => (
            <tr key={payment.id} className="border-b border-black/20">
              <td className="py-1">{payment.customer_name}</td>
              <td className="py-1">{payment.receipt_number} · {payment.invoice_receipt_number}</td>
              <td className="py-1">{payment.recorded_by_name || "—"}</td>
              <td className="py-1 capitalize">{payment.payment_method?.replace(/_/g, " ") ?? "—"}</td>
              <td className="py-1 text-right">{formatPeso(payment.amount)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="mt-3 text-right text-sm font-bold">Total pending: {formatPeso(total)}</p>
    </div>
  );
}

function VerifyDialog({
  payment,
  token,
  onClose,
  onDone,
  onVerified,
}: {
  payment: UnverifiedPayment;
  token: string | null;
  onClose: () => void;
  onDone: () => Promise<void> | void;
  onVerified: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [remarks, setRemarks] = useState("");
  const needsClearance = paymentNeedsClearance(payment.payment_method);
  const missingRemarks = needsClearance && !remarks.trim();

  const verify = async () => {
    setBusy(true);
    try {
      const res = await fetch(`/api/payments/${payment.id}/verify`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ remarks: remarks.trim() || undefined }),
      });
      if (!res.ok) {
        // 409 means it was already verified (or has no payment): show the server's reason and refresh the table.
        toast.error(await responseError(res, "Could not verify this payment"));
        await onDone();
        onVerified();
        return;
      }
      toast.success("Payment verified");
      await onDone();
      onVerified();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not verify this payment");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-5 px-4 py-4 md:px-6 md:py-6">
      <div className="page-header">
        <div>
          <h1 className="page-title">Verify payment</h1>
          <p className="page-subtitle">Confirm the money recorded in the field was received.</p>
        </div>
      </div>
      <dl className="grid gap-4 sm:grid-cols-2">
        {[
          ["Customer", payment.customer_name],
          ["Receipt / invoice", `${payment.receipt_number} · ${payment.invoice_receipt_number}`],
          ["Amount", formatPeso(payment.amount)],
          ["Method", payment.payment_method?.replace("_", " ") || "—"],
          ...(payment.payment_reference ? [["Reference no.", payment.payment_reference]] : []),
          ["Recorded by", payment.recorded_by_name || "—"],
          ["Date", formatDate(payment.confirmed_at)],
        ].map(([label, value]) => (
          <div key={label}>
            <dt className="mb-1 text-xs font-semibold text-muted-foreground">{label}</dt>
            <dd className="text-sm font-medium capitalize text-foreground">{value}</dd>
          </div>
        ))}
      </dl>
      <label className="grid gap-1.5 text-sm font-semibold text-foreground">
        Clearance remarks{needsClearance ? " (required)" : " (optional)"}
        <Textarea
          value={remarks}
          rows={3}
          maxLength={500}
          onChange={(event) => setRemarks(event.target.value)}
          placeholder={needsClearance ? "e.g. Cleared in the bank account on Nov 20, ref matches" : "Anything Accounting should note"}
        />
      </label>
      <div className="flex justify-end gap-2 border-t border-border pt-4">
        <Button type="button" variant="outline" onClick={onClose} disabled={busy}>Cancel</Button>
        <Button type="button" variant="success" onClick={() => void verify()} disabled={busy || missingRemarks}>
          <BadgeCheck size={15} /> {busy ? "Verifying…" : "Confirm payment received"}
        </Button>
      </div>
    </div>
  );
}

export function PaymentVerification() {
  const isNewRow = useNewRows("payments");
  const { token } = useAuth();
  const canVerify = useCan("payment:verify");
  const [payments, setPayments] = useState<UnverifiedPayment[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [searchParams, setSearchParams] = useSearchParams();
  const [allAgents, setAllAgents] = useState<PaymentAgentOption[]>([]);
  const today = todayInManila();
  const period = parsePeriod(searchParams.get("period"));
  const bounds = periodBounds(period, today);
  const [searchTerm, setSearchTerm] = useState("");
  const [agentFilter, setAgentFilter] = useState("all");
  const [page, setPage] = useState(1);
  const [verifying, setVerifying] = useState<UnverifiedPayment | null>(null);
  const [bulkTarget, setBulkTarget] = useState<UnverifiedPayment[] | null>(null);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => new Set());
  const [printTarget, setPrintTarget] = useState<UnverifiedPayment[] | null>(null);

  const fetchData = useCallback(async () => {
    if (!token) return;
    try {
      const headers = { Authorization: `Bearer ${token}` };
      const [res, agentsRes] = await Promise.all([
        fetch("/api/payments/unverified", { headers }),
        fetch("/api/payments/agents", { headers }),
      ]);
      if (!res.ok) throw new Error(await responseError(res, "Failed to load payments"));
      setPayments(await res.json());
      if (agentsRes.ok) {
        const agentList = await agentsRes.json();
        if (Array.isArray(agentList)) setAllAgents(agentList);
      }
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load payments");
    } finally {
      setIsLoading(false);
    }
  }, [token]);

  useEffect(() => {
    void fetchData();
  }, [fetchData]);
  useAutoRefresh(fetchData, { enabled: Boolean(token) });
  useEffect(() => {
    if (!printTarget) return;
    const clearPrintTarget = () => setPrintTarget(null);
    window.addEventListener("afterprint", clearPrintTarget, { once: true });
    window.print();
    return () => window.removeEventListener("afterprint", clearPrintTarget);
  }, [printTarget]);
  useEffect(() => {
    setPage(1);
    setSelectedIds(new Set());
  }, [period]);

  const agentOptions = Array.from(
    new Map<string, string>([
      ...payments
        .filter((payment) => paymentAgentId(payment))
        .map((payment): [string, string] => [paymentAgentId(payment)!, payment.agent_name || payment.recorded_by_name || paymentAgentId(payment)!]),
      ...allAgents.map((agent): [string, string] => [agent.id, agent.name]),
    ]),
  ).sort((a, b) => a[1].localeCompare(b[1]));
  const changePeriod = (value: string) => {
    const nextParams = new URLSearchParams(searchParams);
    if (value === "all") nextParams.delete("period");
    else nextParams.set("period", value);
    setSearchParams(nextParams, { replace: true });
  };
  const query = searchTerm.trim().toLowerCase();
  const filtered = payments.filter((payment) => {
    const day = businessDate(payment.confirmed_at);
    if (bounds && (day < bounds.from || day > bounds.to)) return false;
    if (agentFilter !== "all" && paymentAgentId(payment) !== agentFilter && payment.recorded_by !== agentFilter) return false;
    if (!query) return true;
    return [payment.agent_name, payment.customer_name, payment.receipt_number, payment.invoice_receipt_number, payment.recorded_by_name, payment.recorded_by_username, payment.payment_reference, payment.payment_method]
      .some((value) => value?.toLowerCase().includes(query));
  });
  const { currentPage, totalPages, pageItems } = paginate(filtered, page);
  const totalAmount = filtered.reduce((sum, payment) => sum + Number(payment.amount), 0);
  const cashAmount = filtered.filter((payment) => payment.payment_method === "cash").reduce((sum, payment) => sum + Number(payment.amount), 0);
  const agentCount = new Set(filtered.map(paymentAgentId).filter(Boolean)).size;
  const selectedPayments = filtered.filter((payment) => selectedIds.has(payment.id));
  const bulkActions: TableBulkAction[] = [
    ...(canVerify ? [{ label: "Verify selected", onSelect: () => setBulkTarget(selectedPayments) }] : []),
    { label: "Print selected", onSelect: () => setPrintTarget(selectedPayments) },
  ];
  if (isLoading) return <LoadingSpinner />;

  return (
    <div className="flex flex-1 flex-col gap-6 p-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="page-title">End-of-Day</h1>
          <p className="page-subtitle">Payments drivers and agents recorded on deliveries, waiting for Accounting</p>
        </div>
        <div className="no-print flex flex-wrap items-center gap-2">
          <Button type="button" variant="outline" onClick={() => setPrintTarget(filtered)} disabled={filtered.length === 0}>
            <Printer size={15} /> Print payments
          </Button>
        </div>
      </div>

      {error && (
        <Card className="border-destructive/30 bg-destructive-soft p-4">
          <p className="text-sm text-destructive">{error}</p>
        </Card>
      )}

      <div className="no-print grid grid-cols-2 gap-4 md:grid-cols-4">
        <Card className="p-4"><div className="text-2xl font-bold">{formatPeso(totalAmount)}</div><p className="mt-1 text-xs font-semibold text-muted-foreground">Total to verify</p></Card>
        <Card className="p-4"><div className="text-2xl font-bold">{filtered.length}</div><p className="mt-1 text-xs font-semibold text-muted-foreground">Pending payments</p></Card>
        <Card className="p-4"><div className="text-2xl font-bold">{formatPeso(cashAmount)}</div><p className="mt-1 text-xs font-semibold text-muted-foreground">Cash payments</p></Card>
        <Card className="p-4"><div className="text-2xl font-bold">{agentCount}</div><p className="mt-1 text-xs font-semibold text-muted-foreground">Agents</p></Card>
      </div>

      <div className="no-print">
        <TableToolbar
          searchValue={searchTerm}
          onSearchChange={(value) => { setSearchTerm(value); setPage(1); setSelectedIds(new Set()); }}
          searchPlaceholder="Search by customer, receipt or recorder…"
          selectedCount={selectedPayments.length}
          bulkActions={bulkActions}
        >
          <NativeSelect aria-label="Filter by agent" value={agentFilter} onChange={(event) => { setAgentFilter(event.target.value); setPage(1); setSelectedIds(new Set()); }}>
            <option value="all">All agents</option>
            {agentOptions.map(([id, name]) => <option key={id} value={id}>{name}</option>)}
          </NativeSelect>
          <PaymentPeriodFilter period={period} today={today} onChange={changePeriod} />
        </TableToolbar>
      </div>

      <Card className="overflow-hidden rounded-xl shadow-sm">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>
                <Checkbox
                  aria-label="Select all payments on this page"
                  checked={pageItems.length > 0 && pageItems.every((payment) => selectedIds.has(payment.id))}
                  onCheckedChange={(checked) => setSelectedIds((current) => {
                    const next = new Set(current);
                    for (const payment of pageItems) {
                      if (checked) next.add(payment.id);
                      else next.delete(payment.id);
                    }
                    return next;
                  })}
                />
              </TableHead>
              <TableHead>Customer</TableHead>
              <TableHead>Receipt / invoice</TableHead>
              <TableHead>Method</TableHead>
              <TableHead>Amount</TableHead>
              <TableHead>Recorded by</TableHead>
              <TableHead>Date</TableHead>
              {canVerify && <TableHead className="text-right">Actions</TableHead>}
            </TableRow>
          </TableHeader>
          <TableBody>
            {pageItems.length === 0 ? (
              <TableRow>
                <TableCell colSpan={canVerify ? 8 : 7} className="py-10 text-center text-sm text-muted-foreground">
                  {payments.length === 0 ? "No payments are waiting to be verified." : "No payments match the selected filters."}
                </TableCell>
              </TableRow>
            ) : (
              pageItems.map((payment) => (
                <TableRow key={payment.id} className={isNewRow(payment.confirmed_at) ? "row-new" : undefined}>
                  <TableCell>
                    <Checkbox
                      aria-label={`Select payment ${payment.receipt_number}`}
                      checked={selectedIds.has(payment.id)}
                      onCheckedChange={(checked) => setSelectedIds((current) => {
                        const next = new Set(current);
                        if (checked) next.add(payment.id);
                        else next.delete(payment.id);
                        return next;
                      })}
                    />
                  </TableCell>
                  <TableCell className="max-w-[220px] text-sm font-semibold text-foreground">
                    <TruncatedText>{payment.customer_name}</TruncatedText>
                  </TableCell>
                  <TableCell className="whitespace-nowrap font-mono text-xs text-muted-foreground">
                    <Link to={`/accounting/payments/${encodeURIComponent(payment.id)}/receipt`} className="font-semibold text-primary underline-offset-2 hover:underline focus-visible:underline">
                      {payment.receipt_number} · {payment.invoice_receipt_number}
                    </Link>
                  </TableCell>
                  <TableCell className="text-sm capitalize text-muted-foreground">{payment.payment_method?.replace(/_/g, " ") || "—"}</TableCell>
                  <TableCell className="whitespace-nowrap text-sm font-bold">{formatPeso(payment.amount)}</TableCell>
                  <TableCell className="text-sm text-muted-foreground">
                    {payment.recorded_by_name || "—"}
                    {payment.agent_name && payment.agent_user_id !== payment.recorded_by && (
                      <span className="block text-xs">Agent: {payment.agent_name}</span>
                    )}
                  </TableCell>
                  <TableCell className="whitespace-nowrap text-xs text-muted-foreground">{formatDate(payment.confirmed_at)}</TableCell>
                  {canVerify && (
                    <TableCell className="text-right">
                      <Button variant="success" size="sm" onClick={() => setVerifying(payment)}>
                        <BadgeCheck size={13} /> Verify
                      </Button>
                    </TableCell>
                  )}
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
        <TablePagination page={currentPage} totalPages={totalPages} totalItems={filtered.length} onPageChange={setPage} />
      </Card>

      {printTarget && createPortal(<PaymentPrintSheet payments={printTarget} periodText={formatPeriod(bounds)} />, document.body)}

      {verifying && (
        <PageDialog onClose={() => setVerifying(null)} label="Verify payment">
          <VerifyDialog
            key={verifying.id}
            payment={verifying}
            token={token}
            onClose={() => setVerifying(null)}
            onDone={fetchData}
            onVerified={() => setVerifying(null)}
          />
        </PageDialog>
      )}

      {bulkTarget && (
        <PageDialog onClose={() => setBulkTarget(null)} label="Verify selected payments">
          <BulkVerifyDialog
            payments={bulkTarget}
            token={token}
            onClose={() => setBulkTarget(null)}
            onDone={fetchData}
            onVerified={() => {
              setBulkTarget(null);
              setSelectedIds(new Set());
            }}
          />
        </PageDialog>
      )}
    </div>
  );
}
