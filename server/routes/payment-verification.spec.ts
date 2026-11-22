// Accounting verifies payments that field staff recorded. Runs against the in-memory Postgres
// harness; the shared database is never touched.
import { beforeAll, afterAll, describe, expect, it, vi } from "vitest";
import type { Request, RequestHandler, Response } from "express";
import { eq } from "drizzle-orm";
import { db } from "../db";
import {
  accounts_receivable,
  agents,
  audit_logs,
  bookings,
  customers,
  deliveries,
  delivery_items,
  drivers,
  invoices,
  receipt_payment_entries,
  receipts,
  trucks,
  users,
} from "../db/schema";
import type { AuthRequest } from "../middleware/auth";
import { requirePermission, staffModuleGuard } from "../middleware/permissions";
import { getPaymentReceipt, listPaymentAgents, listUnverifiedPayments, verifyReceiptPayment } from "./payment-verification";
import { seedUsers } from "../test/test-db";

vi.mock("../db", async () => {
  const { createTestDb: create } = await import("../test/test-db");
  return { db: (await create()).db };
});

type Role = "admin" | "staff" | "agent" | "driver";
let seeded: Awaited<ReturnType<typeof seedUsers>>;

beforeAll(async () => {
  vi.stubEnv("DATABASE_URL", "postgres://unused-the-db-module-is-mocked");
  seeded = await seedUsers(db as never);
  // `staff` holds the accounting module; `plain-staff` does not.
  await db.update(users).set({ module_permissions: ["accounting"] }).where(eq(users.id, seeded.staff.id));
  await db.insert(users).values({ id: "plain-staff", username: "plain_staff", password_hash: "x", role: "staff", mfa_required: false });

  await db.insert(agents).values({ id: "agent-1", user_id: seeded.agent.id, full_name: "Alice Agent" });
  await db.insert(drivers).values({ id: "driver-1", user_id: seeded.driver.id, full_name: "Dave Driver" });
  await db.insert(trucks).values({ id: "truck-1", license_plate: "AAA-111", district: "d" });
  await db.insert(customers).values([
    { id: "cust-1", store_name: "Store One", location: "Somewhere" },
    { id: "cust-2", store_name: "Store Two", location: "Elsewhere" },
  ]);
  await db.insert(deliveries).values({ id: "del-1", truck_id: "truck-1" });

  const ids = ["full", "partial", "unpaid", "verified", "overpaid"];
  await db.insert(bookings).values(ids.map((id) => ({ id: `book-${id}`, customer_id: "cust-1", created_by: seeded.admin.id })));
  await db.insert(invoices).values(
    ids.map((id) => ({
      id: `inv-${id}`,
      booking_id: `book-${id}`,
      agent_id: seeded.admin.id,
      receipt_number: `INV-${id}`,
      customer_name: "Store One",
      total_amount: "100.00",
    })),
  );
  const paid = { status: "completed" as const, payment_method: "cash" };
  await db.insert(delivery_items).values([
    { id: "di-full", delivery_id: "del-1", invoice_id: "inv-full", destination_customer_id: "cust-1", is_paid: true, ...paid },
    { id: "di-partial", delivery_id: "del-1", invoice_id: "inv-partial", destination_customer_id: "cust-2", ...paid },
    { id: "di-unpaid", delivery_id: "del-1", invoice_id: "inv-unpaid", destination_customer_id: "cust-1", status: "completed" },
    { id: "di-verified", delivery_id: "del-1", invoice_id: "inv-verified", destination_customer_id: "cust-1", is_paid: true, ...paid },
    { id: "di-overpaid", delivery_id: "del-1", invoice_id: "inv-overpaid", destination_customer_id: "cust-1", is_paid: true, ...paid },
  ]);
  await db.insert(receipts).values(
    ids.map((id) => ({
      id: `rec-${id}`,
      receipt_number: `OR-${id}`,
      delivery_item_id: `di-${id}`,
      customer_id: id === "partial" ? "cust-2" : "cust-1",
      truck_id: "truck-1",
      invoice_id: `inv-${id}`,
      confirmed_by: seeded.driver.id,
      cash_collected_amount: id === "partial" ? "60.00" : id === "overpaid" ? "120.00" : id === "unpaid" ? "0.00" : "100.00",
    })),
  );
  await db.insert(receipt_payment_entries).values([
    { id: "pay-full", receipt_id: "rec-full", idempotency_key: "key-full", amount: "100.00", payment_method: "cash", recorded_by: seeded.driver.id },
    { id: "pay-partial", receipt_id: "rec-partial", idempotency_key: "key-partial", amount: "60.00", payment_method: "cash", recorded_by: seeded.agent.id },
    { id: "pay-verified", receipt_id: "rec-verified", idempotency_key: "key-verified", amount: "100.00", payment_method: "cash", recorded_by: seeded.driver.id, verified_by: seeded.admin.id, verified_at: new Date() },
    { id: "pay-overpaid", receipt_id: "rec-overpaid", idempotency_key: "key-overpaid", amount: "120.00", payment_method: "cash", recorded_by: seeded.driver.id },
  ]);

  // 60.00 collected on the partial stop, 40.00 still owed; the unpaid stop owes everything.
  await db.insert(accounts_receivable).values([
    { id: "ar-partial", customer_id: "cust-2", delivery_item_id: "di-partial", invoice_id: "inv-partial", amount_due: "40.00", status: "outstanding" },
    { id: "ar-unpaid", customer_id: "cust-1", delivery_item_id: "di-unpaid", invoice_id: "inv-unpaid", amount_due: "100.00", status: "outstanding" },
  ]);
  // Who recorded each payment: the driver confirmed every stop; the agent later took the partial balance.
  await db.insert(audit_logs).values([
    { id: "log-1", user_id: seeded.driver.id, action: "confirm", resource_type: "delivery_item", resource_id: "di-full", created_at: new Date("2026-01-01T10:00:00Z") },
    { id: "log-2", user_id: seeded.driver.id, action: "confirm", resource_type: "delivery_item", resource_id: "di-partial", created_at: new Date("2026-01-01T10:00:00Z") },
    { id: "log-3", user_id: seeded.agent.id, action: "record_payment", resource_type: "delivery_item", resource_id: "di-partial", created_at: new Date("2026-01-01T11:00:00Z") },
  ]);
});

afterAll(() => {
  vi.unstubAllEnvs();
});

function reqFor(role: Role, userId: string, params: Record<string, string> = {}, modulePermissions?: string[]): AuthRequest {
  return { user: { userId, username: userId, role }, modulePermissions, query: {}, params, body: {} } as unknown as AuthRequest;
}

/** Runs the middleware chain the way express does; stops at the first one that responds. */
async function run(chain: RequestHandler[], req: AuthRequest) {
  let status = 200;
  let body: unknown;
  let responded = false;
  const res = {
    status(code: number) {
      status = code;
      return res;
    },
    json(payload: unknown) {
      body = payload;
      responded = true;
      return res;
    },
  } as unknown as Response;
  for (const handler of chain) {
    let advanced = false;
    await handler(req as Request, res, () => {
      advanced = true;
    });
    if (responded || !advanced) break;
  }
  return { status, body };
}

const asAccounting = (params: Record<string, string> = {}) => reqFor("staff", seeded.staff.id, params, ["accounting"]);
const list = [requirePermission("payment:verify"), listUnverifiedPayments];
const verify = [requirePermission("payment:verify"), verifyReceiptPayment];

type Row = { id: string } & Record<string, unknown>;

describe("GET /api/payments/unverified", () => {
  it("lists receipts with a recorded payment that is not yet verified", async () => {
    const { status, body } = await run(list, asAccounting());
    expect(status).toBe(200);
    expect((body as Row[]).map((r) => r.id).sort()).toEqual(["pay-full", "pay-overpaid", "pay-partial"]);
  });

  it("filters by status: accomplished lists verified payments, all lists everything", async () => {
    const withStatus = (status: string) => ({ ...asAccounting(), query: { status } }) as unknown as AuthRequest;
    const accomplished = await run(list, withStatus("accomplished"));
    expect(accomplished.status).toBe(200);
    expect((accomplished.body as Row[]).map((r) => r.id)).toEqual(["pay-verified"]);
    expect((accomplished.body as Row[])[0].verified_at).toEqual(expect.any(String));
    const all = await run(list, withStatus("all"));
    expect((all.body as Row[]).map((r) => r.id).sort()).toEqual(["pay-full", "pay-overpaid", "pay-partial", "pay-verified"]);
  });

  it("rejects an unknown status", async () => {
    const req = { ...asAccounting(), query: { status: "pending" } } as unknown as AuthRequest;
    expect((await run(list, req)).status).toBe(400);
  });

  it("shows what accounting needs to check a row", async () => {
    const { body } = await run(list, asAccounting());
    const rows = body as Row[];
    expect(rows.find((r) => r.id === "pay-full")).toMatchObject({
      receipt_number: "OR-full",
      invoice_receipt_number: "INV-full",
      customer_name: "Store One",
      amount: "100.00",
      payment_method: "cash",
      recorded_by: seeded.driver.id,
      recorded_by_username: "test_driver",
      recorded_by_name: "Dave Driver",
      recorded_by_role: "driver",
    });
    // The later payment is included in the receipt's accumulated cash collected amount.
    expect(rows.find((r) => r.id === "pay-partial")).toMatchObject({
      customer_name: "Store Two",
      amount: "60.00",
      recorded_by: seeded.agent.id,
      recorded_by_username: "test_agent",
      recorded_by_name: "Alice Agent",
      recorded_by_role: "agent",
    });
    expect(rows.find((r) => r.id === "pay-overpaid")).toMatchObject({ amount: "120.00" });
  });

  it("falls back to the username when no full name is available", async () => {
    await db.update(agents).set({ full_name: null }).where(eq(agents.user_id, seeded.agent.id));
    const { body } = await run(list, asAccounting());
    expect((body as Row[]).find((row) => row.id === "pay-partial")).toMatchObject({ recorded_by_name: "test_agent" });
    await db.update(agents).set({ full_name: "Alice Agent" }).where(eq(agents.user_id, seeded.agent.id));
  });

  it("is open to admin and denied to staff without accounting, agents and drivers", async () => {
    expect((await run(list, reqFor("admin", seeded.admin.id))).status).toBe(200);
    expect((await run(list, reqFor("staff", "plain-staff", {}, []))).status).toBe(403);
    expect((await run(list, reqFor("agent", seeded.agent.id))).status).toBe(403);
    expect((await run(list, reqFor("driver", seeded.driver.id))).status).toBe(403);
  });
});

describe("GET /api/payments/agents", () => {
  const agentList = [requirePermission("payment:verify"), listPaymentAgents];

  it("lists every agent account, including agents with no payment", async () => {
    const { status, body } = await run(agentList, asAccounting());
    expect(status).toBe(200);
    expect(body).toEqual([{ id: seeded.agent.id, name: "Alice Agent" }]);
  });

  it("denies staff without accounting and agents", async () => {
    expect((await run(agentList, reqFor("staff", "plain-staff", {}, []))).status).toBe(403);
    expect((await run(agentList, reqFor("agent", seeded.agent.id))).status).toBe(403);
  });
});

describe("GET /api/payments/:id/receipt", () => {
  const receipt = [requirePermission("payment:verify"), getPaymentReceipt];

  it("returns the matching original receipt and its details", async () => {
    const { status, body } = await run(receipt, asAccounting({ id: "pay-partial" }));
    expect(status).toBe(200);
    expect(body).toMatchObject({ id: "rec-partial", receipt_number: "OR-partial", customer: { store_name: "Store Two" }, truck: { license_plate: "AAA-111" } });
    expect((await run(receipt, asAccounting({ id: "missing" }))).status).toBe(404);
  });

  it("denies users without accounting permission", async () => {
    expect((await run(receipt, reqFor("staff", "plain-staff", { id: "pay-partial" }, []))).status).toBe(403);
    expect((await run(receipt, reqFor("agent", seeded.agent.id, { id: "pay-partial" }))).status).toBe(403);
  });
});

describe("POST /api/receipts/:id/verify", () => {
  it("verifies once, then answers 409", async () => {
    const first = await run(verify, asAccounting({ id: "pay-full" }));
    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({ id: "pay-full", verified_by: seeded.staff.id });
    expect((first.body as Row).verified_at).toBeTruthy();

    const again = await run(verify, asAccounting({ id: "pay-full" }));
    expect(again.status).toBe(409);
  });

  it("takes the verifier from the token, never from the request body", async () => {
    const req = asAccounting({ id: "pay-partial" });
    (req as unknown as { body: unknown }).body = { payment_verified_by: seeded.admin.id };
    const { body } = await run(verify, req);
    expect(body).toMatchObject({ verified_by: seeded.staff.id });
  });

  it("removes verified rows from the unverified list", async () => {
    await run(verify, asAccounting({ id: "pay-overpaid" }));
    const { body } = await run(list, asAccounting());
    expect(body).toEqual([]);
  });

  it("audit-logs the verification with the actor", async () => {
    const [entry] = await db.select().from(audit_logs).where(eq(audit_logs.resource_id, "pay-full"));
    expect(entry).toMatchObject({ user_id: seeded.staff.id, action: "verify_payment", resource_type: "receipt_payment" });
    expect(JSON.parse(entry.after_state!)).toMatchObject({ verified_by: seeded.staff.id });
  });

  it("does not let two simultaneous verifications both succeed", async () => {
    await db.update(receipt_payment_entries).set({ verified_by: null, verified_at: null }).where(eq(receipt_payment_entries.id, "pay-full"));
    const results = await Promise.all([
      run(verify, asAccounting({ id: "pay-full" })),
      run(verify, reqFor("admin", seeded.admin.id, { id: "pay-full" })),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
  });

  describe("separation of duties", () => {
    // A stop whose payment was recorded by the accounting user, with no audit entry: the receipt's
    // confirmed_by is the recorder, as in the unverified list.
    async function addStop(id: string, recordedBy: string, audit?: { user: string }) {
      await db.insert(bookings).values({ id: `book-${id}`, customer_id: "cust-1", created_by: seeded.admin.id });
      await db.insert(invoices).values({ id: `inv-${id}`, booking_id: `book-${id}`, agent_id: seeded.admin.id, receipt_number: `INV-${id}`, customer_name: "Store One", total_amount: "100.00" });
      await db.insert(delivery_items).values({ id: `di-${id}`, delivery_id: "del-1", invoice_id: `inv-${id}`, destination_customer_id: "cust-1", status: "completed", is_paid: true, payment_method: "cash" });
      await db.insert(receipts).values({ id: `rec-${id}`, receipt_number: `OR-${id}`, delivery_item_id: `di-${id}`, customer_id: "cust-1", truck_id: "truck-1", invoice_id: `inv-${id}`, confirmed_by: recordedBy });
      await db.insert(receipt_payment_entries).values({
        id: `pay-${id}`,
        receipt_id: `rec-${id}`,
        idempotency_key: `key-${id}`,
        amount: "100.00",
        payment_method: "cash",
        recorded_by: audit?.user ?? recordedBy,
      });
      if (audit) {
        await db.insert(audit_logs).values({ id: `log-${id}`, user_id: audit.user, action: "record_payment", resource_type: "delivery_item", resource_id: `di-${id}` });
      }
    }

    it("answers 409 when the verifier is the user who recorded the payment", async () => {
      await addStop("self", seeded.staff.id);
      const { status, body } = await run(verify, asAccounting({ id: "pay-self" }));
      expect(status).toBe(409);
      expect(body).toMatchObject({ error: expect.stringContaining("recorded") });
      const [row] = await db.select().from(receipt_payment_entries).where(eq(receipt_payment_entries.id, "pay-self"));
      expect(row.verified_at).toBeNull();
    });

    it("uses the latest audit entry as the recorder, like the unverified list", async () => {
      // Confirmed by the driver, but the accounting user took the later payment.
      await addStop("later", seeded.driver.id, { user: seeded.staff.id });
      expect((await run(verify, asAccounting({ id: "pay-later" }))).status).toBe(409);
    });

    it("lets a different user verify the same receipt", async () => {
      const { status, body } = await run(verify, reqFor("admin", seeded.admin.id, { id: "pay-self" }));
      expect(status).toBe(200);
      expect(body).toMatchObject({ verified_by: seeded.admin.id });
    });
  });

  it("denies staff without accounting, agents and drivers", async () => {
    for (const req of [
      reqFor("staff", "plain-staff", { id: "rec-unpaid" }, []),
      reqFor("agent", seeded.agent.id, { id: "rec-unpaid" }),
      reqFor("driver", seeded.driver.id, { id: "rec-unpaid" }),
    ]) {
      expect((await run(verify, req)).status).toBe(403);
    }
  });

  it("answers 404 for an unknown receipt", async () => {
    expect((await run(verify, asAccounting({ id: "nope" }))).status).toBe(404);
  });

  it("refuses to verify a receipt where no payment was recorded", async () => {
    const { status } = await run(verify, asAccounting({ id: "rec-unpaid" }));
    expect(status).toBe(404);
  });
});

describe("staff module guard", () => {
  const guardFor = (path: string, modules: string[]) => run([staffModuleGuard], { ...reqFor("staff", seeded.staff.id, {}, modules), path } as AuthRequest);

  it.each(["/payments/unverified", "/payments/pay-1/verify"])("lets an accounting-only staff account reach %s", async (path) => {
    expect((await guardFor(path, ["accounting"])).status).toBe(200);
  });

  it("keeps staff without accounting out of the payments routes", async () => {
    expect((await guardFor("/payments/unverified", ["order-fulfillment"])).status).toBe(403);
  });
});

describe("clearance remarks", () => {
  beforeAll(async () => {
    await db.insert(bookings).values({ id: "book-bank", customer_id: "cust-1", created_by: seeded.admin.id });
    await db.insert(invoices).values({
      id: "inv-bank", booking_id: "book-bank", agent_id: seeded.admin.id, receipt_number: "INV-bank", customer_name: "Store One", total_amount: "100.00",
    });
    await db.insert(delivery_items).values({
      id: "di-bank", delivery_id: "del-1", invoice_id: "inv-bank", destination_customer_id: "cust-1", status: "completed", is_paid: true, payment_method: "bank_transfer",
    });
    await db.insert(receipts).values({
      id: "rec-bank", receipt_number: "OR-bank", delivery_item_id: "di-bank", customer_id: "cust-1", truck_id: "truck-1", invoice_id: "inv-bank",
      confirmed_by: seeded.driver.id, payment_reference: "BDO-12345",
    });
    await db.insert(receipt_payment_entries).values({
      id: "pay-bank", receipt_id: "rec-bank", idempotency_key: "key-bank", amount: "100.00",
      payment_method: "bank_transfer", payment_reference: "BDO-12345", recorded_by: seeded.driver.id,
    });
  });

  const withRemarks = (remarks: unknown) => {
    const req = asAccounting({ id: "pay-bank" });
    (req as unknown as { body: unknown }).body = { remarks };
    return req;
  };

  it("lists the bank reference so Accounting can match it", async () => {
    const { body } = await run(list, asAccounting());
    expect((body as Row[]).find((row) => row.id === "pay-bank")).toMatchObject({ payment_reference: "BDO-12345" });
  });

  it("refuses a bank transfer without a remark, and leaves it unverified", async () => {
    for (const remarks of [undefined, "", "   "]) {
      expect((await run(verify, withRemarks(remarks))).status).toBe(400);
    }
    const [row] = await db.select().from(receipt_payment_entries).where(eq(receipt_payment_entries.id, "pay-bank"));
    expect(row.verified_at).toBeNull();
  });

  it("rejects remarks that are not text or are too long", async () => {
    expect((await run(verify, withRemarks(42))).status).toBe(400);
    expect((await run(verify, withRemarks("x".repeat(501)))).status).toBe(400);
  });

  it("stores the trimmed remark and audit-logs it", async () => {
    const { status, body } = await run(verify, withRemarks("  Cleared in BDO on Nov 20  "));
    expect(status).toBe(200);
    expect(body).toMatchObject({ verification_remarks: "Cleared in BDO on Nov 20" });
    const logs = await db.select().from(audit_logs).where(eq(audit_logs.resource_id, "pay-bank"));
    expect(JSON.parse(logs[0].after_state!)).toMatchObject({ verification_remarks: "Cleared in BDO on Nov 20" });
  });
});
