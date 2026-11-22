import type { AgentScheduleDelivery, AgentSchedulePallet, AgentScheduleStop, DeliveryItem } from "@shared/api";

export function localScheduleDate(date: Date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export function partitionAgentSchedule(deliveries: AgentScheduleDelivery[], today: string) {
  return {
    current: deliveries.filter((delivery) => delivery.status !== "completed" && delivery.scheduled_date === today),
    otherDates: deliveries.filter((delivery) => delivery.status !== "completed" && delivery.scheduled_date !== today),
    history: deliveries.filter((delivery) => delivery.status === "completed"),
  };
}

export function statusClasses(status: DeliveryItem["status"]) {
  if (status === "completed") return "border-green/20 bg-green/10 text-green";
  if (status === "in_transit") return "border-gold/30 bg-gold/10 text-foreground";
  return "border-link/30 bg-info-soft text-foreground";
}

export type UnconfirmedPayment = { amount: number; label: string };

export function unconfirmedPayment(stop: AgentScheduleStop): UnconfirmedPayment | null {
  if (stop.status !== "completed") return null;
  const unverified = stop.unverified_amount ?? 0;
  const total = Number(stop.invoice?.total_amount ?? 0);
  const unpaid = stop.is_paid ? 0 : (stop.outstanding_amount ?? 0) > 0 ? stop.outstanding_amount! : total;
  if (unverified <= 0 && unpaid <= 0) return null;
  if (stop.is_paid) return { amount: unverified, label: "Paid · awaiting Accounting" };
  if (unverified > 0) return { amount: unverified + unpaid, label: "Partially paid · awaiting Accounting" };
  return { amount: unpaid, label: "Not paid" };
}

export function palletStatusLabel(status: AgentSchedulePallet["status"]) {
  if (status === "draft") return "Preparing";
  if (status === "prepared") return "Prepared";
  if (status === "approved") return "Ready";
  return "Shipped";
}

export function palletTotals(pallets: AgentSchedulePallet[]) {
  const items = pallets.flatMap((pallet) => pallet.items);
  return {
    products: new Set(items.map((item) => item.product?.id ?? item.id)).size,
    units: items.reduce((total, item) => total + item.qty_units, 0),
  };
}
