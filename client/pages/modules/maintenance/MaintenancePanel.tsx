import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { Wrench } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { LoadingSpinner } from "@/components/LoadingSpinner";
import { useAuth } from "@/hooks/useAuth";
import { useCan } from "@/hooks/useCan";
import { useAutoRefresh } from "@/hooks/useAutoRefresh";
import { confirmAction } from "@/lib/confirm";
import type { MaintenanceRequest, MaintenanceRequestsResponse, MaintenanceStatus } from "@shared/api";
import { MaintenanceRequestForm } from "./MaintenanceRequestForm";
import { MaintenanceRequestList } from "./MaintenanceRequestList";

type StatusFilter = "all" | MaintenanceStatus;
const statusFilters: StatusFilter[] = ["all", "submitted", "approved", "rejected"];

async function errorMessage(res: Response, fallback: string) {
  const body = await res.json().catch(() => ({}));
  return (body as { error?: string }).error ?? fallback;
}

export function MaintenancePanel() {
  const token = useAuth((state) => state.token);
  const canRequest = useCan("maintenance:request");
  const canDecide = useCan("maintenance:decide");

  const [requests, setRequests] = useState<MaintenanceRequest[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");
  const [formKey, setFormKey] = useState(0);

  const load = useCallback(async () => {
    if (!token) return;
    try {
      const res = await fetch("/api/maintenance-requests", { headers: { Authorization: `Bearer ${token}` } });
      if (!res.ok) throw new Error("load failed");
      const data = (await res.json()) as MaintenanceRequestsResponse;
      setRequests(data.requests);
      setError(null);
    } catch {
      setError("Failed to load maintenance requests.");
    } finally {
      setLoading(false);
    }
  }, [token]);

  useEffect(() => { load(); }, [load]);
  useAutoRefresh(load, { enabled: Boolean(token) });

  const decide = async (request: MaintenanceRequest, action: "approve" | "reject", rejectReason?: string) => {
    if (!token) return;
    const res = await fetch(`/api/maintenance-requests/${request.id}/${action}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify(action === "reject" ? { reject_reason: rejectReason } : {}),
    });
    if (!res.ok) {
      toast.error(await errorMessage(res, `Could not ${action} the request.`));
    } else {
      toast.success(action === "approve" ? "Request approved." : "Request rejected.");
    }
    await load();
  };

  const approve = async (request: MaintenanceRequest) => {
    if (!(await confirmAction(`Approve maintenance for "${request.asset}"?`))) return;
    await decide(request, "approve");
  };

  const reject = async (request: MaintenanceRequest) => {
    const input = prompt(`Reason for rejecting "${request.asset}":`);
    if (input === null) return;
    if (!input.trim()) return void toast.error("A reason is required to reject a request.");
    await decide(request, "reject", input.trim());
  };

  const visible = requests.filter((request) => statusFilter === "all" || request.status === statusFilter);

  if (!canDecide) {
    return (
      <div className="flex-1 px-4 md:px-6 lg:px-7 py-4 md:py-6 overflow-y-auto space-y-6">
        <div>
          <h1 className="page-title">Maintenance</h1>
          <p className="page-subtitle">Ask for repairs on any equipment or vehicle</p>
        </div>
        {token && (
          <MaintenanceRequestForm
            key={formKey}
            token={token}
            onSubmitted={() => setFormKey((key) => key + 1)}
            onCancel={() => setFormKey((key) => key + 1)}
          />
        )}
      </div>
    );
  }

  return (
    <div className="flex-1 px-4 md:px-6 lg:px-7 py-4 md:py-6 overflow-y-auto space-y-6">
      <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-4">
        <div>
          <h1 className="page-title">Maintenance</h1>
          <p className="page-subtitle">Review maintenance requests for any equipment or vehicle</p>
        </div>
        {canRequest && !showForm && (
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

      <ToggleGroup
        type="single"
        value={statusFilter}
        onValueChange={(value) => { if (value) setStatusFilter(value as StatusFilter); }}
        aria-label="Filter maintenance requests by status"
        className="hide-scrollbar w-fit max-w-full justify-start overflow-x-auto rounded-full border border-border bg-card p-1"
      >
        {statusFilters.map((status) => (
          <ToggleGroupItem key={status} value={status} variant="pill" size="sm" className="capitalize">
            {status}
          </ToggleGroupItem>
        ))}
      </ToggleGroup>

      {loading ? (
        <LoadingSpinner className="min-h-32" />
      ) : (
        <MaintenanceRequestList
          requests={visible}
          canDecide={canDecide}
          emptyMessage={requests.length === 0 ? "No maintenance requests yet." : "No requests match this filter."}
          onApprove={approve}
          onReject={reject}
        />
      )}
    </div>
  );
}
