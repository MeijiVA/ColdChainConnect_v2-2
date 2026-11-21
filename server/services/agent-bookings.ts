import { and, eq, inArray, isNull, or, type SQL } from "drizzle-orm";
import type { PgColumn } from "drizzle-orm/pg-core";
import { db } from "../db";
import { agents, bookings, deliveries, delivery_items, drivers, invoices, trucks } from "../db/schema";
import type { AuthRequest } from "../middleware/auth";

/** Districts of the trucks an agent is assigned to, plus those of deliveries they manage. */
export async function getAgentDistricts(userId: string): Promise<string[]> {
  const agent = await db.query.agents.findFirst({
    where: eq(agents.user_id, userId),
    columns: { id: true },
  });
  if (!agent) return [];

  const [assignedTrucks, deliveryTrucks] = await Promise.all([
    db.selectDistinct({ district: trucks.district }).from(trucks).where(eq(trucks.agent_id, agent.id)),
    db
      .selectDistinct({ district: trucks.district })
      .from(deliveries)
      .innerJoin(trucks, eq(deliveries.truck_id, trucks.id))
      .where(eq(deliveries.agent_id, agent.id)),
  ]);
  return [...new Set([...assignedTrucks, ...deliveryTrucks].map((row) => row.district))];
}

/** Invoices for the orders an agent created or is delivering. */
export async function getAgentInvoiceIds(userId: string): Promise<string[]> {
  const orderIds = await getAgentOrderIds(userId);
  if (!orderIds.length) return [];
  const rows = await db.select({ id: invoices.id }).from(invoices).where(inArray(invoices.booking_id, orderIds));
  return rows.map((row) => row.id);
}

/**
 * Invoices on the deliveries assigned to a driver: the delivery's own driver, or the truck's
 * default driver when the delivery has none (same rule as confirming a delivery stop).
 */
export async function getDriverInvoiceIds(userId: string): Promise<string[]> {
  const profile = await db.query.drivers.findFirst({
    where: eq(drivers.user_id, userId),
    columns: { id: true },
  });
  if (!profile) return [];
  const rows = await db
    .selectDistinct({ id: delivery_items.invoice_id })
    .from(delivery_items)
    .innerJoin(deliveries, eq(delivery_items.delivery_id, deliveries.id))
    .innerJoin(trucks, eq(deliveries.truck_id, trucks.id))
    .where(
      or(
        eq(deliveries.driver_id, profile.id),
        and(isNull(deliveries.driver_id), eq(trucks.driver_id, profile.id)),
      ),
    );
  return rows.map((row) => row.id);
}

/**
 * For agents and drivers, the invoice ids they may see; for admin and staff, null (no restriction).
 * Use to scope financial lists (invoices, receipts, AR, returns) server-side.
 */
export async function agentInvoiceScope(req: AuthRequest): Promise<string[] | null> {
  if (req.user?.role === "agent") return getAgentInvoiceIds(req.user.userId);
  if (req.user?.role === "driver") return getDriverInvoiceIds(req.user.userId);
  return null;
}

/**
 * The agent or driver restriction as a query condition on an invoice-id column.
 * `none` means the caller has no invoices (return an empty list without querying);
 * `where` is undefined for roles that see everything.
 */
export async function agentInvoiceFilter(
  req: AuthRequest,
  invoiceIdColumn: PgColumn,
): Promise<{ none: boolean; where: SQL | undefined }> {
  const scope = await agentInvoiceScope(req);
  if (scope?.length === 0) return { none: true, where: undefined };
  return { none: false, where: scope ? inArray(invoiceIdColumn, scope) : undefined };
}

export async function getAgentOrderIds(userId: string): Promise<string[]> {
  const agent = await db.query.agents.findFirst({
    where: eq(agents.user_id, userId),
    columns: { id: true },
  });

  const [ownedOrders, assignedRuns] = await Promise.all([
    db.select({ id: bookings.id }).from(bookings).where(eq(bookings.created_by, userId)),
    agent
      ? db.query.deliveries.findMany({
          where: eq(deliveries.agent_id, agent.id),
          with: { delivery_items: { with: { invoice: { columns: { booking_id: true } } } } },
        })
      : Promise.resolve([]),
  ]);

  return [...new Set([
    ...ownedOrders.map((order) => order.id),
    ...assignedRuns.flatMap((run) => run.delivery_items.map((item) => item.invoice.booking_id)),
  ])];
}
