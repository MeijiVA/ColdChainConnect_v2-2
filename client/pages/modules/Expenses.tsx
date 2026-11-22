import { useCallback, useEffect, useState } from "react";
import { Plus } from "lucide-react";
import { toast } from "sonner";
import { CreateExpenseSchema, expenseStatuses, type Expense, type ExpenseStatus, type ExpensesResponse } from "@shared/api";
import { PageDialog } from "@/components/shared/PageDialog";
import { LoadingSpinner } from "@/components/LoadingSpinner";
import { newestFirst } from "@/components/SortableHeader";
import { StatusBadge, type StatusTone } from "@/components/StatusBadge";
import { TablePagination, paginate } from "@/components/TablePagination";
import { TableToolbar } from "@/components/TableToolbar";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Textarea } from "@/components/ui/textarea";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { TruncatedText } from "@/components/ui/truncated-text";
import { useAutoRefresh } from "@/hooks/useAutoRefresh";
import { useAuth } from "@/hooks/useAuth";
import { useCan } from "@/hooks/useCan";
import { formatPeso, responseError } from "@/lib/format";
import { useNewRows } from "@/lib/unseen";

type StatusFilter = "all" | ExpenseStatus;

const STATUS_TONE: Record<ExpenseStatus, StatusTone> = {
  submitted: "warning",
  approved: "info",
  paid: "success",
  rejected: "danger",
};

const CATEGORY_SUGGESTIONS = ["Fuel", "Maintenance", "Supplies", "Utilities", "Salaries", "Other"];

const formatDate = (value?: string | null) => (value ? new Date(value).toLocaleDateString("en-PH") : "—");

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="mb-1 text-xs font-semibold text-muted-foreground">{label}</div>
      <div className="text-sm font-medium text-foreground">{children}</div>
    </div>
  );
}

// ─── New expense ──────────────────────────────────────────────────────────────

interface FormErrors {
  category?: string;
  description?: string;
  amount?: string;
}

/** Mirrors the server: category and description are required, the amount is a positive decimal with at most 2 places. */
function validateExpense(category: string, description: string, amount: string): FormErrors {
  const errors: FormErrors = {};
  if (!category.trim()) errors.category = "Category is required";
  if (!description.trim()) errors.description = "Description is required";
  if (!amount.trim()) errors.amount = "Amount is required";
  else if (!CreateExpenseSchema.shape.amount.safeParse(amount.trim()).success) {
    errors.amount = "Amount must be greater than zero, with at most 2 decimal places";
  }
  return errors;
}

function NewExpenseForm({ token, onClose, onCreated }: { token: string | null; onClose: () => void; onCreated: () => void }) {
  const [category, setCategory] = useState("");
  const [description, setDescription] = useState("");
  const [amount, setAmount] = useState("");
  const [errors, setErrors] = useState<FormErrors>({});
  const [saving, setSaving] = useState(false);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    const found = validateExpense(category, description, amount);
    setErrors(found);
    if (Object.keys(found).length > 0) return;
    setSaving(true);
    try {
      const res = await fetch("/api/expenses", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ category: category.trim(), description: description.trim(), amount: amount.trim() }),
      });
      if (!res.ok) throw new Error(await responseError(res, "Could not submit the expense"));
      toast.success("Expense submitted for approval");
      onCreated();
      onClose();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not submit the expense");
    } finally {
      setSaving(false);
    }
  };

  const errorText = (id: string, message?: string) =>
    message ? (
      <p id={id} role="alert" className="mt-1 text-xs font-medium text-destructive">
        {message}
      </p>
    ) : null;

  return (
    <form onSubmit={submit} noValidate className="space-y-5 px-4 py-4 md:px-6 md:py-6">
      <div className="page-header">
        <div>
          <h1 className="page-title">New expense</h1>
          <p className="page-subtitle">An admin approves it, then Accounting pays it.</p>
        </div>
      </div>

      <div className="space-y-4">
        <div>
          <label htmlFor="expense-category" className="mb-1 block text-xs font-semibold text-muted-foreground">Category</label>
          <Input
            id="expense-category"
            list="expense-categories"
            value={category}
            onChange={(event) => setCategory(event.target.value)}
            aria-invalid={Boolean(errors.category)}
            aria-describedby={errors.category ? "expense-category-error" : undefined}
            placeholder="e.g. Fuel"
          />
          <datalist id="expense-categories">
            {CATEGORY_SUGGESTIONS.map((suggestion) => <option key={suggestion} value={suggestion} />)}
          </datalist>
          {errorText("expense-category-error", errors.category)}
        </div>
        <div>
          <label htmlFor="expense-description" className="mb-1 block text-xs font-semibold text-muted-foreground">Description</label>
          <Textarea
            id="expense-description"
            value={description}
            onChange={(event) => setDescription(event.target.value)}
            aria-invalid={Boolean(errors.description)}
            aria-describedby={errors.description ? "expense-description-error" : undefined}
            placeholder="What was this for?"
          />
          {errorText("expense-description-error", errors.description)}
        </div>
        <div>
          <label htmlFor="expense-amount" className="mb-1 block text-xs font-semibold text-muted-foreground">Amount</label>
          <Input
            id="expense-amount"
            inputMode="decimal"
            value={amount}
            onChange={(event) => setAmount(event.target.value)}
            aria-invalid={Boolean(errors.amount)}
            aria-describedby={errors.amount ? "expense-amount-error" : undefined}
            placeholder="0.00"
          />
          {errorText("expense-amount-error", errors.amount)}
        </div>
      </div>

      <div className="flex justify-end gap-2 border-t border-border pt-4">
        <Button type="button" variant="outline" onClick={onClose} disabled={saving}>Cancel</Button>
        <Button type="submit" disabled={saving}>{saving ? "Submitting…" : "Submit expense"}</Button>
      </div>
    </form>
  );
}

// ─── Details and actions ──────────────────────────────────────────────────────

function ExpenseDetails({
  expense,
  token,
  userId,
  onClose,
  onChanged,
}: {
  expense: Expense;
  token: string | null;
  userId: string | undefined;
  onClose: () => void;
  onChanged: () => Promise<void> | void;
}) {
  const canApprove = useCan("expense:approve");
  const canPay = useCan("expense:pay");
  const [rejecting, setRejecting] = useState(false);
  const [reason, setReason] = useState("");
  const [reasonError, setReasonError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Permission, status and actor rules, mirroring the server (which still has the final say).
  const mayReview = canApprove && expense.status === "submitted" && expense.submitted_by !== userId;
  const mayPay = canPay && expense.status === "approved" && expense.approved_by !== userId;

  const act = async (action: "approve" | "reject" | "pay", body?: unknown) => {
    setBusy(true);
    try {
      const res = await fetch(`/api/expenses/${expense.id}/${action}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify(body ?? {}),
      });
      if (!res.ok) {
        // 409: someone else got there first or a rule blocks it; show why and refresh the row.
        toast.error(await responseError(res, "The action could not be completed"));
        await onChanged();
        return;
      }
      toast.success({ approve: "Expense approved", reject: "Expense rejected", pay: "Expense marked as paid" }[action]);
      await onChanged();
      onClose();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "The action could not be completed");
    } finally {
      setBusy(false);
    }
  };

  const confirmReject = () => {
    if (!reason.trim()) {
      setReasonError("A reason is required to reject an expense");
      return;
    }
    setReasonError(null);
    void act("reject", { reject_reason: reason.trim() });
  };

  return (
    <div className="space-y-5 px-4 py-4 md:px-6 md:py-6">
      <div className="page-header">
        <div>
          <h1 className="page-title">Expense details</h1>
        </div>
        <StatusBadge label={expense.status} tone={STATUS_TONE[expense.status]} />
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Category">{expense.category}</Field>
        <Field label="Amount">{formatPeso(expense.amount)}</Field>
        <div className="sm:col-span-2"><Field label="Description">{expense.description || "—"}</Field></div>
        <Field label="Submitted by">{expense.submitted_by_name || "—"} · {formatDate(expense.created_at)}</Field>
        {expense.approved_by && (
          <Field label={expense.status === "rejected" ? "Rejected by" : "Approved by"}>
            {expense.approved_by_name || "—"} · {formatDate(expense.approved_at)}
          </Field>
        )}
        {expense.status === "rejected" && <div className="sm:col-span-2"><Field label="Reason">{expense.reject_reason || "—"}</Field></div>}
        {expense.status === "paid" && <Field label="Paid by">{expense.paid_by_name || "—"} · {formatDate(expense.paid_at)}</Field>}
      </div>

      {rejecting && (
        <div>
          <label htmlFor="reject-reason" className="mb-1 block text-xs font-semibold text-muted-foreground">Reason</label>
          <Textarea
            id="reject-reason"
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            aria-invalid={Boolean(reasonError)}
            aria-describedby={reasonError ? "reject-reason-error" : undefined}
            placeholder="Why is this expense being rejected?"
          />
          {reasonError && <p id="reject-reason-error" role="alert" className="mt-1 text-xs font-medium text-destructive">{reasonError}</p>}
        </div>
      )}

      <div className="flex flex-wrap justify-end gap-2 border-t border-border pt-4">
        <Button type="button" variant="outline" onClick={onClose} disabled={busy}>Close</Button>
        {mayReview && !rejecting && (
          <>
            <Button type="button" variant="danger" onClick={() => setRejecting(true)} disabled={busy}>Reject</Button>
            <Button type="button" variant="success" onClick={() => void act("approve")} disabled={busy}>Approve</Button>
          </>
        )}
        {mayReview && rejecting && (
          <>
            <Button type="button" variant="outline" onClick={() => { setRejecting(false); setReasonError(null); }} disabled={busy}>Back</Button>
            <Button type="button" variant="destructive" onClick={confirmReject} disabled={busy}>Confirm rejection</Button>
          </>
        )}
        {mayPay && <Button type="button" onClick={() => void act("pay")} disabled={busy}>Pay</Button>}
      </div>
    </div>
  );
}

// ─── Screen ───────────────────────────────────────────────────────────────────

const FILTERS: { key: StatusFilter; label: string }[] = [
  { key: "all", label: "All" },
  ...expenseStatuses.map((status) => ({ key: status, label: status[0].toUpperCase() + status.slice(1) })),
];

export function Expenses() {
  const isNewRow = useNewRows("expenses");
  const { token, user } = useAuth();
  const canSubmit = useCan("expense:submit");
  const [expenses, setExpenses] = useState<Expense[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");
  const [searchTerm, setSearchTerm] = useState("");
  const [page, setPage] = useState(1);
  const [showForm, setShowForm] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const fetchData = useCallback(async () => {
    if (!token) return;
    try {
      const res = await fetch("/api/expenses", { headers: { Authorization: `Bearer ${token}` } });
      if (!res.ok) throw new Error(await responseError(res, "Failed to load expenses"));
      const data: ExpensesResponse = await res.json();
      setExpenses(data.expenses);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load expenses");
    } finally {
      setIsLoading(false);
    }
  }, [token]);

  useEffect(() => {
    void fetchData();
  }, [fetchData]);
  useAutoRefresh(fetchData, { enabled: Boolean(token) });

  const countFor = (key: StatusFilter) => (key === "all" ? expenses.length : expenses.filter((item) => item.status === key).length);

  const query = searchTerm.trim().toLowerCase();
  const filtered = newestFirst(
    expenses.filter(
      (item) =>
        (statusFilter === "all" || item.status === statusFilter) &&
        (!query ||
          [item.category, item.description, item.submitted_by_name].some((value) => value?.toLowerCase().includes(query))),
    ),
  );
  const { currentPage, totalPages, pageItems } = paginate(filtered, page);
  const selected = expenses.find((item) => item.id === selectedId) ?? null;

  if (isLoading) return <LoadingSpinner />;

  return (
    <div className="flex flex-1 flex-col gap-6 p-6">
      <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
        <div>
          <h1 className="page-title">Expenses</h1>
          <p className="page-subtitle">Submit, approve and pay company expenses</p>
        </div>
        {canSubmit && (
          <Button onClick={() => setShowForm(true)}>
            <Plus size={16} /> New expense
          </Button>
        )}
      </div>

      {error && (
        <Card className="border-destructive/30 bg-destructive-soft p-4">
          <p className="text-sm text-destructive">{error}</p>
        </Card>
      )}

      <div className="flex flex-col gap-3">
        <TableToolbar
          searchValue={searchTerm}
          onSearchChange={(value) => { setSearchTerm(value); setPage(1); }}
          searchPlaceholder="Search by category, description or submitter…"
        >
          <ToggleGroup
            type="single"
            value={statusFilter}
            onValueChange={(value) => { if (value) { setStatusFilter(value as StatusFilter); setPage(1); } }}
            aria-label="Filter expenses by status"
            className="hide-scrollbar w-fit max-w-full justify-start overflow-x-auto rounded-full border border-border bg-card p-1"
          >
            {FILTERS.map((filter) => (
              <ToggleGroupItem key={filter.key} value={filter.key} variant="pill" size="sm" className="gap-1.5">
                {filter.label}
                <span className={`rounded-full px-1.5 py-0.5 text-xs font-bold ${
                  statusFilter === filter.key ? "bg-primary-foreground/20 text-primary-foreground" : "bg-muted text-muted-foreground"
                }`}>
                  {countFor(filter.key)}
                </span>
              </ToggleGroupItem>
            ))}
          </ToggleGroup>
        </TableToolbar>
      </div>

      <Card className="overflow-hidden rounded-xl shadow-sm">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Date</TableHead>
              <TableHead>Category</TableHead>
              <TableHead>Description</TableHead>
              <TableHead>Amount</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Submitted by</TableHead>
              <TableHead className="text-right">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {pageItems.length === 0 ? (
              <TableRow>
                <TableCell colSpan={7} className="py-10 text-center text-sm text-muted-foreground">
                  {expenses.length === 0 ? "No expenses yet." : "No expenses match your filters."}
                </TableCell>
              </TableRow>
            ) : (
              pageItems.map((item) => (
                <TableRow key={item.id} className={isNewRow(item.created_at) ? "row-new" : undefined}>
                  <TableCell className="whitespace-nowrap text-xs text-muted-foreground">{formatDate(item.created_at)}</TableCell>
                  <TableCell className="text-sm font-semibold text-foreground">{item.category}</TableCell>
                  <TableCell className="max-w-[240px] text-sm text-muted-foreground">
                    <TruncatedText>{item.description || "—"}</TruncatedText>
                  </TableCell>
                  <TableCell className="whitespace-nowrap text-sm font-bold">{formatPeso(item.amount)}</TableCell>
                  <TableCell><StatusBadge label={item.status} tone={STATUS_TONE[item.status]} /></TableCell>
                  <TableCell className="text-sm text-muted-foreground">{item.submitted_by_name || "—"}</TableCell>
                  <TableCell className="text-right">
                    <Button variant="outline" size="sm" onClick={() => setSelectedId(item.id)}>Details</Button>
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
        <TablePagination page={currentPage} totalPages={totalPages} totalItems={filtered.length} onPageChange={setPage} />
      </Card>

      {showForm && (
        <PageDialog onClose={() => setShowForm(false)} label="New expense">
          <NewExpenseForm token={token} onClose={() => setShowForm(false)} onCreated={() => void fetchData()} />
        </PageDialog>
      )}
      {selected && (
        <PageDialog onClose={() => setSelectedId(null)} label="Expense details">
          <ExpenseDetails
            expense={selected}
            token={token}
            userId={user?.id}
            onClose={() => setSelectedId(null)}
            onChanged={fetchData}
          />
        </PageDialog>
      )}
    </div>
  );
}
