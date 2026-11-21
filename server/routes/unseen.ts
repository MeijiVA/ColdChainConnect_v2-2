import type { RequestHandler } from "express";
import { count, eq, inArray, isNull, sql, type SQL } from "drizzle-orm";
import type { PgColumn, PgTable } from "drizzle-orm/pg-core";
import type { ModulePermission } from "@shared/api";
import { db } from "../db";
import { accounts_receivable, agent_returns, agents, bookings, customers, deliveries, expenses, invoices, receipt_payment_entries } from "../db/schema";
import type { AuthRequest } from "../middleware/auth";
import type { TokenPayload } from "../auth";
import { calculateProductInventory } from "./pallets";
import { findLowStockProducts } from "./dashboard";

/** Sidebar tabs that show a "new" badge; each counts rows created after the viewer last opened the tab. */
const SECTIONS: Record<string, { table: PgTable; column: PgColumn; module: ModulePermission; /** Extra condition on top of "created after the viewer last looked"; may depend on the viewer. */ where?: SQL | ((viewer: TokenPayload | undefined) => SQL) }> = {
  receipts: { table: invoices, column: invoices.created_at, module: "order-fulfillment" },
  customers: { table: customers, column: customers.created_at, module: "product-customer" },
  // Agents only see runs they manage; everyone else sees all runs. Finished runs are not news.
  dispatch: {
    table: deliveries,
    column: deliveries.created_at,
    module: "delivery-operations",
    where: (viewer) => sql`${inArray(deliveries.status, ["pending", "in_transit"])}${viewer?.role === "agent" ? sql` and ${deliveries.agent_id} in (select ${agents.id} from ${agents} where ${agents.user_id} = ${viewer.userId})` : sql``}`,
  },
  accounts: { table: accounts_receivable, column: accounts_receivable.created_at, module: "delivery-operations" },
  returns: { table: agent_returns, column: agent_returns.created_at, module: "delivery-operations" },
  // Expenses the viewer submitted themselves are not news to them.
  expenses: { table: expenses, column: expenses.created_at, module: "accounting", where: (viewer) => sql`${expenses.submitted_by} is distinct from ${viewer?.userId ?? null}` },
};

/** GET /api/unseen?receipts=<ISO>...: how many records each tab gained since the given time, plus current counts: `reorder`, `outstanding`, `pendingOrders`, and `unverifiedPayments`. One round trip to the database for all tabs. */
export const getUnseenCounts: RequestHandler = async (req, res) => {
  try {
    const user = (req as AuthRequest).user;
    const permissions = (req as AuthRequest).modulePermissions;
    const parts: ReturnType<typeof sql>[] = [];
    const result: Record<string, number> = { reorder: 0, outstanding: 0, pendingOrders: 0, unverifiedPayments: 0 };
    if (user?.role === "admin" || permissions?.includes("product-customer")) {
      result.reorder = (await findLowStockProducts(await calculateProductInventory())).length;
    }
    if (user?.role === "admin" || permissions?.includes("delivery-operations")) {
      const [{ n }] = await db.select({ n: count() }).from(accounts_receivable).where(eq(accounts_receivable.status, "outstanding"));
      result.outstanding = Number(n);
    }
    if (user?.role === "admin" || permissions?.includes("order-fulfillment")) {
      const [{ n }] = await db.select({ n: count() }).from(bookings).where(eq(bookings.status, "pending"));
      result.pendingOrders = Number(n);
    }
    if (user?.role === "admin" || permissions?.includes("accounting")) {
      const [{ n }] = await db.select({ n: count() }).from(receipt_payment_entries).where(isNull(receipt_payment_entries.verified_at));
      result.unverifiedPayments = Number(n);
    }
    for (const [key, section] of Object.entries(SECTIONS)) {
      result[key] = 0;
      const raw = req.query[key];
      const since = typeof raw === "string" ? new Date(raw) : null;
      const allowed = user?.role === "admin" || permissions?.includes(section.module);
      if (!allowed || !since || Number.isNaN(since.getTime())) continue;
      const extra = typeof section.where === "function" ? section.where(user) : section.where;
      parts.push(sql`(select count(*)::int from ${section.table} where ${section.column} > ${since.toISOString()}::timestamp${extra ? sql` and ${extra}` : sql``}) as ${sql.identifier(key)}`);
    }
    if (parts.length > 0) {
      const { rows } = await db.execute(sql`select ${sql.join(parts, sql`, `)}`);
      for (const [key, value] of Object.entries(rows[0] ?? {})) result[key] = Number(value);
    }
    res.json(result);
  } catch (error) {
    console.error("Error counting unseen records:", error);
    res.status(500).json({ error: "Internal server error" });
  }
};
