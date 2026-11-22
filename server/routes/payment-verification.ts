import type { RequestHandler } from "express";
import { and, asc, eq, inArray, isNull } from "drizzle-orm";
import { db } from "../db";
import { agents, customers, deliveries, delivery_items, drivers, invoices, receipt_payment_entries, receipts, trucks, users } from "../db/schema";
import type { AuthRequest } from "../middleware/auth";
import { logAction } from "../middleware/audit-logger";
import { paymentNeedsClearance } from "../../shared/api";

const MAX_REMARKS_LENGTH = 500;

// Field staff record payments on delivery stops; Accounting verifies each collection separately.

// ─── GET /api/payments/unverified ─────────────────────────────────────────────

export const listUnverifiedPayments: RequestHandler = async (_req: AuthRequest, res) => {
  try {
    if (!process.env.DATABASE_URL) return res.json([]);

    const rows = await db
      .select({
        payment: receipt_payment_entries,
        receipt: receipts,
        customer_name: customers.store_name,
        invoice_receipt_number: invoices.receipt_number,
        agent_user_id: agents.user_id,
        agent_name: agents.full_name,
      })
      .from(receipt_payment_entries)
      .innerJoin(receipts, eq(receipts.id, receipt_payment_entries.receipt_id))
      .innerJoin(customers, eq(customers.id, receipts.customer_id))
      .innerJoin(invoices, eq(invoices.id, receipts.invoice_id))
      .leftJoin(delivery_items, eq(delivery_items.id, receipts.delivery_item_id))
      .leftJoin(deliveries, eq(deliveries.id, delivery_items.delivery_id))
      .leftJoin(agents, eq(agents.id, deliveries.agent_id))
      .where(isNull(receipt_payment_entries.verified_at))
      .orderBy(asc(receipt_payment_entries.created_at));

    const recorderIds = rows
      .map((row) => row.payment.recorded_by)
      .filter((userId): userId is string => Boolean(userId));
    const recorderDetails = new Map<string, { username: string; role: string; name: string }>();
    if (recorderIds.length > 0) {
      const ids = [...new Set(recorderIds)];
      const [found, agentNames, driverNames] = await Promise.all([
        db.select({ id: users.id, username: users.username, role: users.role }).from(users).where(inArray(users.id, ids)),
        db.select({ userId: agents.user_id, name: agents.full_name }).from(agents).where(inArray(agents.user_id, ids)),
        db.select({ userId: drivers.user_id, name: drivers.full_name }).from(drivers).where(inArray(drivers.user_id, ids)),
      ]);
      for (const user of found) {
        const name = user.role === "agent"
          ? agentNames.find((agent) => agent.userId === user.id)?.name
          : user.role === "driver"
            ? driverNames.find((driver) => driver.userId === user.id)?.name
            : null;
        recorderDetails.set(user.id, { username: user.username, role: user.role, name: name?.trim() || user.username });
      }
    }

    res.json(rows.map(({ payment, receipt, customer_name, invoice_receipt_number, agent_user_id, agent_name }) => {
      const recorder = payment.recorded_by ? recorderDetails.get(payment.recorded_by) : undefined;
      return {
        id: payment.id,
        receipt_id: receipt.id,
        receipt_number: receipt.receipt_number,
        delivery_item_id: receipt.delivery_item_id,
        customer_id: receipt.customer_id,
        invoice_id: receipt.invoice_id,
        confirmed_at: payment.created_at,
        customer_name,
        invoice_receipt_number,
        payment_method: payment.payment_method,
        payment_reference: payment.payment_reference,
        amount: payment.amount,
        recorded_by: payment.recorded_by,
        recorded_by_username: recorder?.username ?? null,
        recorded_by_name: recorder?.name ?? null,
        recorded_by_role: (recorder?.role as "admin" | "agent" | "driver" | "staff" | undefined) ?? null,
        agent_user_id: agent_user_id ?? null,
        agent_name: agent_name?.trim() || null,
      };
    }));
  } catch (error) {
    console.error("Error fetching unverified payments:", error);
    res.status(500).json({ error: "Internal server error" });
  }
};

// ─── GET /api/payments/agents ─────────────────────────────────────────────────

// Every agent account, so the End-of-Day agent filter lists agents with no payment on the chosen day.
export const listPaymentAgents: RequestHandler = async (_req: AuthRequest, res) => {
  try {
    if (!process.env.DATABASE_URL) return res.json([]);

    const rows = await db
      .select({ id: agents.user_id, name: agents.full_name, username: users.username })
      .from(agents)
      .innerJoin(users, eq(users.id, agents.user_id))
      .where(eq(agents.is_archived, false))
      .orderBy(asc(agents.full_name));

    res.json(rows.map((row) => ({ id: row.id, name: row.name?.trim() || row.username })));
  } catch (error) {
    console.error("Error fetching payment agents:", error);
    res.status(500).json({ error: "Internal server error" });
  }
};

export const getPaymentReceipt: RequestHandler = async (req: AuthRequest, res) => {
  try {
    if (!process.env.DATABASE_URL) return res.status(503).json({ error: "Database not configured" });

    const [row] = await db.select({
      receipt: receipts,
      customer: { store_name: customers.store_name, location: customers.location, contact_info: customers.contact_info },
      truck: { license_plate: trucks.license_plate },
      invoice: { payment_status: invoices.payment_status },
    })
      .from(receipt_payment_entries)
      .innerJoin(receipts, eq(receipts.id, receipt_payment_entries.receipt_id))
      .innerJoin(customers, eq(customers.id, receipts.customer_id))
      .innerJoin(trucks, eq(trucks.id, receipts.truck_id))
      .innerJoin(invoices, eq(invoices.id, receipts.invoice_id))
      .where(eq(receipt_payment_entries.id, req.params.id));

    if (!row) return res.status(404).json({ error: "Receipt not found" });
    res.json({ ...row.receipt, customer: row.customer, truck: row.truck, invoice: row.invoice });
  } catch (error) {
    console.error("Error fetching payment receipt:", error);
    res.status(500).json({ error: "Internal server error" });
  }
};

// ─── POST /api/receipt-payments/:id/verify ────────────────────────────────────

export const verifyReceiptPayment: RequestHandler = async (req: AuthRequest, res) => {
  const { id } = req.params;

  if (!req.user) return res.status(401).json({ error: "Authentication required" });
  if (!process.env.DATABASE_URL) return res.status(503).json({ error: "Database not configured" });

  const rawRemarks = req.body?.remarks;
  if (rawRemarks !== undefined && rawRemarks !== null && typeof rawRemarks !== "string") {
    return res.status(400).json({ error: "Remarks must be text" });
  }
  const remarks = typeof rawRemarks === "string" ? rawRemarks.trim() : "";
  if (remarks.length > MAX_REMARKS_LENGTH) {
    return res.status(400).json({ error: `Remarks can be at most ${MAX_REMARKS_LENGTH} characters` });
  }

  try {
    const existing = await db.query.receipt_payment_entries.findFirst({
      where: eq(receipt_payment_entries.id, id),
    });

    if (!existing) return res.status(404).json({ error: "Payment not found" });
    if (existing.verified_at) return res.status(409).json({ error: "This payment is already verified" });

    if (paymentNeedsClearance(existing.payment_method) && !remarks) {
      return res.status(400).json({ error: "Add a clearance remark before verifying a bank transfer or check" });
    }

    if (existing.recorded_by && existing.recorded_by === req.user.userId) {
      return res.status(409).json({ error: "You recorded this payment, so someone else must verify it" });
    }

    const [verified] = await db
      .update(receipt_payment_entries)
      .set({
        verified_by: req.user.userId,
        verified_at: new Date(),
        verification_remarks: remarks || null,
      })
      .where(and(eq(receipt_payment_entries.id, id), isNull(receipt_payment_entries.verified_at)))
      .returning();

    if (!verified) return res.status(409).json({ error: "This payment is already verified" });

    await logAction(
      req.user.userId,
      "verify_payment",
      "receipt_payment",
      id,
      { verified_by: null, verified_at: null },
      {
        amount: verified.amount,
        payment_method: verified.payment_method,
        verified_by: verified.verified_by,
        verified_at: verified.verified_at,
        verification_remarks: verified.verification_remarks,
      },
    );

    res.json(verified);
  } catch (error) {
    console.error("Error verifying payment:", error);
    res.status(500).json({ error: "Internal server error" });
  }
};
