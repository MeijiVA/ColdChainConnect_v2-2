import { useCallback, useEffect, useState } from "react";
import { Wrench } from "lucide-react";
import { Button } from "@/components/ui/button";
import { LoadingSpinner } from "@/components/LoadingSpinner";
import { StatusBadge, type StatusTone } from "@/components/StatusBadge";
import { useAuth } from "@/hooks/useAuth";
import { useAutoRefresh } from "@/hooks/useAutoRefresh";
import { formatPeso } from "@/lib/format";
import { MAINTENANCE_EXPENSE_CATEGORY, type Expense, type ExpenseStatus, type ExpensesResponse } from "@shared/api";
import { MaintenanceRequestForm } from "./MaintenanceRequestForm";

const STATUS_TONE: Record<ExpenseStatus, StatusTone> = {
  submitted: "warning",
  approved: "info",
  paid: "success",
  rejected: "danger",
};

export function MaintenancePanel() {
  const token = useAuth((state) => state.token);
  const [expenses, setExpenses] = useState<Expense[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);

  const load = useCallback(async () => {
    if (!token) return;
    try {
      const res = await fetch("/api/expenses", { headers: { Authorization: `Bearer ${token}` } });
      if (!res.ok) throw new Error("load failed");
      const data = (await res.json()) as ExpensesResponse;
      setExpenses(data.expenses.filter((item) => item.category === MAINTENANCE_EXPENSE_CATEGORY));
      setError(null);
    } catch {
      setError("Failed to load maintenance requests.");
    } finally {
      setLoading(false);
    }
  }, [token]);

  useEffect(() => { load(); }, [load]);
  useAutoRefresh(load, { enabled: Boolean(token) });

  return (
    <div className="flex-1 px-4 md:px-6 lg:px-7 py-4 md:py-6 overflow-y-auto space-y-6">
      <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-4">
        <div>
          <h1 className="page-title">Maintenance</h1>
          <p className="page-subtitle">Ask for repairs on any equipment or vehicle</p>
        </div>
        {!showForm && (
          <Button onClick={() => setShowForm(true)}>
            <Wrench size={15} /> New request
          </Button>
        )}
      </div>

      {error && <div className="rounded-lg border border-red/30 bg-red/10 px-4 py-2 text-xs text-red">{error}</div>}

      {showForm && token && (
        <MaintenanceRequestForm
          token={token}
          onSubmitted={() => { setShowForm(false); load(); }}
          onCancel={() => setShowForm(false)}
        />
      )}

      {loading ? (
        <LoadingSpinner className="min-h-32" />
      ) : expenses.length === 0 ? (
        <p className="text-sm text-muted-foreground">No maintenance requests yet.</p>
      ) : (
        <ul className="space-y-2">
          {expenses.map((item) => (
            <li key={item.id} className="bg-card border border-border rounded-2xl p-4 flex flex-wrap items-center justify-between gap-2">
              <div className="min-w-0">
                <p className="text-sm font-semibold text-foreground break-words">{item.description}</p>
                <p className="text-xs text-muted-foreground">{new Date(item.created_at).toLocaleDateString("en-PH")} · {formatPeso(item.amount)}</p>
                {item.reject_reason && <p className="text-xs text-destructive">Rejected: {item.reject_reason}</p>}
              </div>
              <StatusBadge label={item.status} tone={STATUS_TONE[item.status]} />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
