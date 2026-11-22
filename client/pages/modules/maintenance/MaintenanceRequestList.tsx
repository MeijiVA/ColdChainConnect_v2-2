import { Button } from "@/components/ui/button";
import { StatusBadge, StatusTone } from "@/components/StatusBadge";
import { Table } from "@/components/ui/table";
import type { MaintenanceRequest, MaintenanceStatus } from "@shared/api";

const statusTone: Record<MaintenanceStatus, StatusTone> = {
  submitted: "warning",
  approved: "success",
  rejected: "danger",
};

interface MaintenanceRequestListProps {
  requests: MaintenanceRequest[];
  canDecide: boolean;
  emptyMessage: string;
  onApprove: (request: MaintenanceRequest) => void;
  onReject: (request: MaintenanceRequest) => void;
}

export function MaintenanceRequestList({ requests, canDecide, emptyMessage, onApprove, onReject }: MaintenanceRequestListProps) {
  const columns = ["Submitted", "Equipment", "Details", "Requested by", "Status", ...(canDecide ? ["Actions"] : [])];

  return (
    <div className="data-table-frame overflow-x-auto">
      <Table>
        <thead>
          <tr>
            {columns.map((heading) => (
              <th key={heading} className="bg-navy-mid text-muted-foreground font-barlow-cond text-xs font-bold px-3 py-3 text-left border-b border-border whitespace-nowrap">
                {heading}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {requests.length === 0 ? (
            <tr>
              <td colSpan={columns.length} className="px-6 py-8 text-center text-muted-foreground">{emptyMessage}</td>
            </tr>
          ) : (
            requests.map((request) => (
              <tr key={request.id} className="border-b border-border last:border-b-0 align-top">
                <td className="px-3 py-3 text-muted-foreground whitespace-nowrap">
                  {new Date(request.created_at).toLocaleDateString("en-PH")}
                </td>
                <td className="px-3 py-3 font-medium text-foreground">{request.asset}</td>
                <td className="px-3 py-3 text-muted-foreground max-w-md whitespace-pre-line">{request.description}</td>
                <td className="px-3 py-3 text-muted-foreground whitespace-nowrap">{request.requested_by_name ?? "—"}</td>
                <td className="px-3 py-3">
                  <div className="flex flex-col gap-1 items-start">
                    <StatusBadge label={request.status} tone={statusTone[request.status]} />
                    {request.status !== "submitted" && request.reviewed_by_name && (
                      <span className="text-xs text-muted-foreground">by {request.reviewed_by_name}</span>
                    )}
                    {request.status === "rejected" && request.reject_reason && (
                      <span className="text-xs text-red">{request.reject_reason}</span>
                    )}
                  </div>
                </td>
                {canDecide && (
                  <td className="px-3 py-3">
                    {request.status === "submitted" ? (
                      <div className="flex gap-1">
                        <Button size="sm" onClick={() => onApprove(request)}>Approve</Button>
                        <Button size="sm" variant="outline" onClick={() => onReject(request)}>Reject</Button>
                      </div>
                    ) : (
                      <span className="text-muted-foreground">—</span>
                    )}
                  </td>
                )}
              </tr>
            ))
          )}
        </tbody>
      </Table>
    </div>
  );
}
