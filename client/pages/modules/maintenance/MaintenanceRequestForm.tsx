import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { MAINTENANCE_EXPENSE_CATEGORY } from "@shared/api";

interface MaintenanceRequestFormProps {
  token: string;
  onSubmitted: () => void;
  onCancel: () => void;
}

export function MaintenanceRequestForm({ token, onSubmitted, onCancel }: MaintenanceRequestFormProps) {
  const [asset, setAsset] = useState("");
  const [description, setDescription] = useState("");
  const [estimatedCost, setEstimatedCost] = useState("");
  const [saving, setSaving] = useState(false);

  const submit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setSaving(true);
    try {
      const res = await fetch("/api/expenses", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({
          category: MAINTENANCE_EXPENSE_CATEGORY,
          description: `${asset.trim()}: ${description.trim()}`,
          amount: estimatedCost.trim(),
        }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        toast.error(body.error ?? "Could not submit the maintenance request.");
        return;
      }
      toast.success("Maintenance request submitted.");
      onSubmitted();
    } catch {
      toast.error("Could not submit the maintenance request.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <form onSubmit={submit} className="bg-card border border-border rounded-2xl p-4 space-y-3">
      <div className="space-y-1">
        <label htmlFor="maintenance-asset" className="text-xs font-semibold text-muted-foreground">Equipment or asset</label>
        <Input
          id="maintenance-asset"
          value={asset}
          maxLength={120}
          placeholder="e.g. Truck TRK-07, walk-in freezer, pallet jack"
          onChange={(event) => setAsset(event.target.value)}
          required
        />
      </div>
      <div className="space-y-1">
        <label htmlFor="maintenance-description" className="text-xs font-semibold text-muted-foreground">What needs fixing</label>
        <Textarea
          id="maintenance-description"
          value={description}
          rows={3}
          placeholder="Describe the problem and when it started"
          onChange={(event) => setDescription(event.target.value)}
          required
        />
      </div>
      <div className="space-y-1">
        <label htmlFor="maintenance-cost" className="text-xs font-semibold text-muted-foreground">Estimated cost</label>
        <Input
          id="maintenance-cost"
          type="number"
          min="0.01"
          step="0.01"
          value={estimatedCost}
          placeholder="0.00"
          onChange={(event) => setEstimatedCost(event.target.value)}
          required
        />
      </div>
      <div className="flex justify-end gap-2">
        <Button type="button" variant="outline" onClick={onCancel} disabled={saving}>Cancel</Button>
        <Button type="submit" disabled={saving || !asset.trim() || !description.trim() || !estimatedCost.trim()}>
          {saving ? "Submitting…" : "Submit request"}
        </Button>
      </div>
    </form>
  );
}
