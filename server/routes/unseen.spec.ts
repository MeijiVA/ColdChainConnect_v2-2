// New-item badge counts for the sidebar, including the Accounting tabs. Runs against the in-memory
// Postgres harness; the shared database is never touched.
import { beforeAll, describe, expect, it, vi } from "vitest";
import type { Request, Response } from "express";
import { db } from "../db";
import { agents, bookings, customers, deliveries, delivery_items, expenses, invoices, products, receipt_payment_entries, receipts, trucks } from "../db/schema";
import type { AuthRequest } from "../middleware/auth";
import { seedUsers } from "../test/test-db";
import { getUnseenCounts } from "./unseen";

vi.mock("../db", async () => {
  const { createTestDb: create } = await import("../test/test-db");
  return { db: (await create()).db };
});

let seeded: Awaited<ReturnType<typeof seedUsers>>;
const SINCE = "2026-01-01T00:00:00.000Z";
const AFTER = new Date("2026-02-01T00:00:00Z");
const BEFORE = new Date("2025-12-01T00:00:00Z");

beforeAll(async () => {
  seeded = await seedUsers(db as never);
  await db.insert(trucks).values({ id: "truck-1", license_plate: "AAA-111", district: "d" });
  await db.insert(customers).values({ id: "cust-1", store_name: "Store One", location: "Somewhere" });
  await db.insert(products).values({ id: "prod-low", name: "Low stock", price: "10.00", reorder_point: 10 });
  await db.insert(agents).values({ id: "agent-1", user_id: seeded.agent.id, full_name: "Agent One" });
  await db.insert(deliveries).values([
    { id: "del-1", truck_id: "truck-1" },
    { id: "del-transit", truck_id: "truck-1", status: "in_transit" },
    { id: "del-done", truck_id: "truck-1", status: "completed" },
    { id: "del-agent", truck_id: "truck-1", agent_id: "agent-1" },
  ]);
  const stops = ["recorded", "nothing-paid", "verified", "old"];
  await db.insert(bookings).values([
    ...stops.map((id) => ({ id: `book-${id}`, customer_id: "cust-1", created_by: seeded.admin.id })),
    { id: "book-approved", customer_id: "cust-1", created_by: seeded.admin.id, status: "approved" as const },
  ]);
  await db.insert(invoices).values(
    stops.map((id) => ({ id: `inv-${id}`, booking_id: `book-${id}`, agent_id: seeded.admin.id, receipt_number: `INV-${id}`, customer_name: "Store One", total_amount: "100.00" })),
  );
  await db.insert(delivery_items).values(
    stops.map((id) => ({
      id: `di-${id}`,
      delivery_id: "del-1",
      invoice_id: `inv-${id}`,
      destination_customer_id: "cust-1",
      status: "completed" as const,
      payment_method: id === "nothing-paid" ? null : "cash",
    })),
  );
  await db.insert(receipts).values(
    stops.map((id) => ({
      id: `rec-${id}`,
      receipt_number: `OR-${id}`,
      delivery_item_id: `di-${id}`,
      customer_id: "cust-1",
      truck_id: "truck-1",
      invoice_id: `inv-${id}`,
      confirmed_at: id === "old" ? BEFORE : AFTER,
      payment_verified_at: id === "verified" ? AFTER : null,
    })),
  );
  await db.insert(receipt_payment_entries).values([
    { id: "pay-recorded", receipt_id: "rec-recorded", idempotency_key: "k-recorded", amount: "100.00", payment_method: "cash" },
    { id: "pay-old", receipt_id: "rec-old", idempotency_key: "k-old", amount: "100.00", payment_method: "cash", created_at: BEFORE },
    { id: "pay-verified", receipt_id: "rec-verified", idempotency_key: "k-verified", amount: "100.00", payment_method: "cash", verified_at: AFTER },
  ]);
  await db.insert(expenses).values([
    { id: "exp-new", category: "Fuel", description: "d", amount: "10.00", submitted_by: seeded.admin.id, created_at: AFTER },
    { id: "exp-old", category: "Fuel", description: "d", amount: "10.00", submitted_by: seeded.admin.id, created_at: BEFORE },
  ]);
});

async function counts(role: "admin" | "staff" | "agent", modulePermissions: string[] | undefined, keys: string[], userId = "u") {
  let body: Record<string, number> = {};
  const query = Object.fromEntries(keys.map((key) => [key, SINCE]));
  const req = { user: { userId, username: userId, role }, modulePermissions, query } as unknown as AuthRequest;
  const res = { json: (payload: Record<string, number>) => (body = payload), status: () => res } as unknown as Response;
  await getUnseenCounts(req as Request, res, () => {});
  return body;
}

describe("GET /api/unseen accounting tabs", () => {
  it("counts every unverified payment entry, whenever it was recorded", async () => {
    expect((await counts("admin", undefined, [])).unverifiedPayments).toBe(2);
    expect((await counts("staff", ["accounting"], [])).unverifiedPayments).toBe(2);
    expect((await counts("staff", ["order-fulfillment"], [])).unverifiedPayments).toBe(0);
  });

  it("counts expenses created since last seen", async () => {
    const result = await counts("admin", undefined, ["expenses"]);
    expect(result.expenses).toBe(1);
  });

  it("does not count expenses the viewer submitted themselves", async () => {
    // exp-new was submitted by the admin: it is news to everyone else, not to them.
    expect((await counts("admin", undefined, ["expenses"], seeded.admin.id)).expenses).toBe(0);
    expect((await counts("staff", ["accounting"], ["expenses"], seeded.staff.id)).expenses).toBe(1);
  });

  it("gives staff with the accounting module the same expense count", async () => {
    expect(await counts("staff", ["accounting"], ["expenses"])).toMatchObject({ expenses: 1 });
  });

  it("counts products at or below their reorder point for viewers with product access", async () => {
    expect((await counts("admin", undefined, [])).reorder).toBe(1);
    expect((await counts("staff", ["product-customer"], [])).reorder).toBe(1);
    expect((await counts("staff", ["accounting"], [])).reorder).toBe(0);
  });

  it("counts orders awaiting approval for viewers with order access", async () => {
    expect((await counts("admin", undefined, [])).pendingOrders).toBe(4);
    expect((await counts("staff", ["order-fulfillment"], [])).pendingOrders).toBe(4);
    expect((await counts("staff", ["accounting"], [])).pendingOrders).toBe(0);
  });

  it("counts only open runs for the dispatch badge", async () => {
    expect((await counts("admin", undefined, ["dispatch"])).dispatch).toBe(3);
  });

  it("counts only the agent's own open runs for the dispatch badge", async () => {
    expect((await counts("agent", ["delivery-operations"], ["dispatch"], seeded.agent.id)).dispatch).toBe(1);
  });

  it("reports zero for staff without the accounting module", async () => {
    expect(await counts("staff", ["order-fulfillment"], ["expenses"])).toMatchObject({ expenses: 0 });
  });
});
