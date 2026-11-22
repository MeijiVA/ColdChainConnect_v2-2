import type { RequestHandler } from "express";
import { randomUUID } from "crypto";
import { and, desc, eq } from "drizzle-orm";
import { agentInvoiceFilter } from "../services/agent-bookings";
import { db } from "../db";
import {
  receipts,
  delivery_items,
  deliveries,
  invoices,
  accounts_receivable,
  agents,
  drivers,
  order_pallets,
  receipt_payment_entries,
} from "../db/schema";
import type { AuthRequest } from "../middleware/auth";
import { logAction } from "../middleware/audit-logger";

// ─── GET /api/receipts ────────────────────────────────────────────────────────
// Returns all receipts (joined data is resolved on the client via separate
// /api/customers, /api/trucks, /api/invoices calls — same pattern as deliveries).

export const listReceipts: RequestHandler = async (req: AuthRequest, res) => {
  try {
    if (!process.env.DATABASE_URL) {
      return res.json([]);
    }

    const scope = await agentInvoiceFilter(req, receipts.invoice_id);
    if (scope.none) return res.json([]);

    const all = await db.select().from(receipts)
      .where(scope.where)
      .orderBy(desc(receipts.confirmed_at));
    res.json(all);
  } catch (error) {
    console.error("Error fetching receipts:", error);
    res.status(500).json({ error: "Internal server error" });
  }
};

class PaymentConflict extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

function newReceiptNumber() {
  const datePart = new Date()
    .toISOString()
    .slice(0, 10)
    .replace(/-/g, "");
  const suffix = randomUUID().slice(0, 4).toUpperCase();
  return `OR-${datePart}-${suffix}`;
}

async function issueReceipt(
  tx: Tx,
  values: {
    receiptNumber: string;
    itemId: string;
    customerId: string;
    truckId: string | null;
    invoiceId: string;
    confirmedBy: string | null;
    confirmedAt: Date;
    cashCollectedAmount: string;
    paymentReference: string | null;
    notes: string | null;
  },
) {
  const [receipt] = await tx.insert(receipts).values({
    id: randomUUID(),
    receipt_number: values.receiptNumber,
    delivery_item_id: values.itemId,
    customer_id: values.customerId,
    truck_id: values.truckId,
    invoice_id: values.invoiceId,
    confirmed_by: values.confirmedBy,
    notes: values.notes,
    payment_reference: values.paymentReference,
    cash_collected_amount: values.cashCollectedAmount,
    confirmed_at: values.confirmedAt,
  }).returning();
  return receipt;
}

// ─── POST /api/deliveries/:id/items/:itemId/confirm ───────────────────────────
// Called by the mobile app (or the admin UI) to confirm a delivery stop.
// Side-effects:
//   1. Sets delivery_item.status = "completed", completed_at, receipt_number
//   2. Sets invoice.status = "paid", payment_status = "paid"
//   3. Creates a receipts row
//   4. If every item in the delivery is now completed, sets delivery.status = "completed"

export const confirmDeliveryItem: RequestHandler = async (
  req: AuthRequest,
  res
) => {
  const { id: deliveryId, itemId } = req.params;
  const { notes, is_paid, payment_amount, payment_method, payment_reference, payment_id } = req.body ?? {};

  if (!process.env.DATABASE_URL) {
    return res.status(503).json({ error: "Database not configured" });
  }

  try {
    // 1. Load the item with its invoice
    const item = await db.query.delivery_items.findFirst({
      where: and(
        eq(delivery_items.id, itemId),
        eq(delivery_items.delivery_id, deliveryId)
      ),
    });

    if (!item) {
      return res.status(404).json({ error: "Delivery item not found" });
    }
    if (item.status === "completed") {
      return res.status(409).json({ error: "Delivery item already confirmed" });
    }

    // 2. Load the invoice to get amount details
    const invoice = await db.query.invoices.findFirst({
      where: eq(invoices.id, item.invoice_id),
      with: {
        booking: {
          with: {
            booking_items: true,
          },
        },
      },
    });

    if (!invoice) {
      return res.status(404).json({ error: "Invoice not found" });
    }

    const invoiceTotalCents = Math.round(Number(invoice.total_amount ?? invoice.gross_amount ?? 0) * 100);
    const creditAppliedCents = Math.round(Number(invoice.credit_applied_amount ?? 0) * 100);
    const amountDueCents = Math.max(0, invoiceTotalCents - creditAppliedCents);
    const collectedAmount = payment_amount === undefined
      ? (is_paid ? amountDueCents / 100 : 0)
      : Number(payment_amount);

    if (!Number.isFinite(collectedAmount) || collectedAmount < 0) {
      return res.status(400).json({ error: "Payment amount must be zero or greater" });
    }
    if (collectedAmount > 0 && (typeof payment_method !== "string" || !payment_method || typeof payment_id !== "string" || !payment_id || payment_id.length > 100)) {
      return res.status(400).json({ error: "Payment method and payment ID are required when recording a payment" });
    }

    const collectedCents = Math.round(collectedAmount * 100);
    const remainingCents = Math.max(0, amountDueCents - collectedCents);
    const overpaidCents = Math.max(0, collectedCents - amountDueCents);
    const isFullyPaid = remainingCents === 0;

    // 3. Load the parent delivery to get the truck_id
    const delivery = await db.query.deliveries.findFirst({
      where: eq(deliveries.id, deliveryId),
      with: { truck: { columns: { driver_id: true } } },
    });

    if (!delivery) {
      return res.status(404).json({ error: "Delivery not found" });
    }

    if (req.user?.role === "agent") {
      const profile = await db.query.agents.findFirst({
        where: eq(agents.user_id, req.user.userId),
        columns: { id: true },
      });
      if (!profile || delivery.agent_id !== profile.id) {
        return res.status(403).json({ error: "Only the assigned agent can confirm this delivery" });
      }
    } else if (req.user?.role === "driver") {
      const profile = await db.query.drivers.findFirst({
        where: eq(drivers.user_id, req.user.userId),
        columns: { id: true },
      });
      if (!profile || (delivery.driver_id ?? delivery.truck?.driver_id) !== profile.id) {
        return res.status(403).json({ error: "Only the assigned driver can confirm this delivery" });
      }
    } else if (req.user?.role !== "admin") {
      return res.status(403).json({ error: "Not authorized to confirm this delivery" });
    }

    const pallets = await db.query.order_pallets.findMany({
      where: eq(order_pallets.order_id, invoice.booking_id),
      columns: { status: true },
    });
    if (pallets.length === 0 || pallets.some((pallet) => pallet.status !== "shipped")) {
      return res.status(409).json({ error: "All pallets for this order must be shipped before delivery confirmation" });
    }

    // Receipts are only issued for money actually collected; an unpaid stop keeps its invoice and AR.
    const now = new Date();
    const receiptNumber = collectedCents > 0 ? newReceiptNumber() : null;

    let newReceipt;
    try {
      newReceipt = await db.transaction(async (tx) => {
        const [lockedItem] = await tx.select({ status: delivery_items.status }).from(delivery_items)
          .where(eq(delivery_items.id, itemId)).for("update");
        if (!lockedItem) throw new PaymentConflict(404, "Delivery item not found");
        if (lockedItem.status === "completed") throw new PaymentConflict(409, "Delivery item already confirmed");

        await tx.update(delivery_items).set({
          status: "completed",
          completed_at: now,
          receipt_number: receiptNumber,
          is_paid: isFullyPaid,
          payment_method: collectedCents > 0 ? payment_method : null,
          payment_reference: collectedCents > 0 ? (payment_reference ?? null) : null,
          paid_at: isFullyPaid ? now : null,
          updated_at: now,
        }).where(eq(delivery_items.id, itemId));

        let createdReceipt: Awaited<ReturnType<typeof issueReceipt>> | null = null;
        if (receiptNumber) {
          createdReceipt = await issueReceipt(tx, {
            receiptNumber,
            itemId,
            customerId: item.destination_customer_id,
            truckId: delivery.truck_id,
            invoiceId: item.invoice_id,
            confirmedBy: req.user?.userId ?? null,
            confirmedAt: now,
            cashCollectedAmount: (collectedCents / 100).toFixed(2),
            paymentReference: payment_reference ?? null,
            notes: notes ?? null,
          });
          await tx.insert(receipt_payment_entries).values({
            id: randomUUID(),
            receipt_id: createdReceipt.id,
            idempotency_key: payment_id,
            amount: (collectedCents / 100).toFixed(2),
            payment_method,
            payment_reference: payment_reference ?? null,
            recorded_by: req.user?.userId ?? null,
          });
        }

        if (remainingCents > 0) {
          await tx.insert(accounts_receivable).values({
            id: randomUUID(),
            customer_id: item.destination_customer_id,
            delivery_item_id: itemId,
            invoice_id: item.invoice_id,
            amount_due: (remainingCents / 100).toFixed(2),
            status: "outstanding",
            notes: `Delivery confirmed on ${now.toISOString()}. ${collectedCents > 0 ? `Partial payment of ${(collectedCents / 100).toFixed(2)} received.` : "Payment pending."}`,
          });
        }

        if (overpaidCents > 0) {
          await tx.insert(accounts_receivable).values({
            id: randomUUID(),
            customer_id: item.destination_customer_id,
            delivery_item_id: null,
            invoice_id: item.invoice_id,
            amount_due: (-overpaidCents / 100).toFixed(2),
            credit_type: "overpayment",
            status: "outstanding",
            notes: `Delivery overpayment on ${receiptNumber}; available for a future order.`,
          });
        }

        if (isFullyPaid || collectedCents > 0) {
          await tx.update(invoices).set({
            ...(isFullyPaid ? { status: "paid" as const, payment_status: "paid" } : { payment_status: "partial" }),
            updated_at: now,
          }).where(eq(invoices.id, item.invoice_id));
        }

        return createdReceipt;
      });
    } catch (error) {
      if (error instanceof PaymentConflict) return res.status(error.status).json({ error: error.message });
      throw error;
    }

    // 9. Check if all items in the delivery are completed → mark delivery done
    const remainingItems = await db.query.delivery_items.findMany({
      where: and(
        eq(delivery_items.delivery_id, deliveryId),
      ),
    });

    const allDone = remainingItems.every((i) =>
      i.id === itemId ? true : i.status === "completed"
    );

    if (allDone) {
      await db
        .update(deliveries)
        .set({ status: "completed", updated_at: now })
        .where(eq(deliveries.id, deliveryId));
    }

    // 10. Audit log
    if (req.user) {
      await logAction(
        req.user.userId,
        "confirm",
        "delivery_item",
        itemId,
        { status: item.status },
        {
          status: "completed",
          receipt_number: receiptNumber,
          is_paid: isFullyPaid,
          payment_amount: (collectedCents / 100).toFixed(2),
          payment_method: collectedCents > 0 ? payment_method : null,
        }
      );
    }

    // Answer with the row just written: a read-back after the commit could fail and report an
    // error for a confirmation that went through.
    res.status(201).json(newReceipt ?? { delivery_item_id: itemId, invoice_id: item.invoice_id, receipt_number: null });
  } catch (error) {
    console.error("Error confirming delivery item:", error);
    res.status(500).json({ error: "Internal server error" });
  }
};

// ─── POST /api/deliveries/:id/items/:itemId/payment ───────────────────────────
// Records payment for a stop that was confirmed as unpaid.
// Side-effects:
//   1. Sets delivery_item.is_paid = true with payment method, reference and paid_at
//   2. Marks the outstanding accounts_receivable entry for this stop as paid
//   3. Sets invoice.status = "paid", payment_status = "paid"

export const recordDeliveryItemPayment: RequestHandler = async (
  req: AuthRequest,
  res
) => {
  const { id: deliveryId, itemId } = req.params;
  const { payment_amount, payment_method, payment_reference, payment_id, notes } = req.body ?? {};

  if (!process.env.DATABASE_URL) {
    return res.status(503).json({ error: "Database not configured" });
  }
  if (typeof payment_method !== "string" || !payment_method) {
    return res.status(400).json({ error: "Payment method is required" });
  }
  if (payment_amount === undefined || !Number.isFinite(Number(payment_amount)) || Number(payment_amount) <= 0) {
    return res.status(400).json({ error: "A payment amount greater than zero is required" });
  }
  if (typeof payment_id !== "string" || !payment_id || payment_id.length > 100) {
    return res.status(400).json({ error: "Payment ID is required" });
  }

  try {
    const item = await db.query.delivery_items.findFirst({
      where: and(
        eq(delivery_items.id, itemId),
        eq(delivery_items.delivery_id, deliveryId)
      ),
    });

    if (!item) {
      return res.status(404).json({ error: "Delivery item not found" });
    }
    if (item.status !== "completed") {
      return res.status(409).json({ error: "Confirm the delivery before recording payment" });
    }
    const delivery = await db.query.deliveries.findFirst({
      where: eq(deliveries.id, deliveryId),
      with: { truck: { columns: { driver_id: true } } },
    });

    if (!delivery) {
      return res.status(404).json({ error: "Delivery not found" });
    }

    if (req.user?.role === "agent") {
      const profile = await db.query.agents.findFirst({
        where: eq(agents.user_id, req.user.userId),
        columns: { id: true },
      });
      if (!profile || delivery.agent_id !== profile.id) {
        return res.status(403).json({ error: "Only the assigned agent can record payment for this delivery" });
      }
    } else if (req.user?.role === "driver") {
      const profile = await db.query.drivers.findFirst({
        where: eq(drivers.user_id, req.user.userId),
        columns: { id: true },
      });
      if (!profile || (delivery.driver_id ?? delivery.truck?.driver_id) !== profile.id) {
        return res.status(403).json({ error: "Only the assigned driver can record payment for this delivery" });
      }
    } else if (req.user?.role !== "admin") {
      return res.status(403).json({ error: "Not authorized to record payment for this delivery" });
    }

    let result: { paymentCents: number; remainingCents: number; overpaidCents: number; isFullyPaid: boolean; duplicate: boolean };
    try {
      // One transaction with the AR row locked: two simultaneous submissions
      // (double tap, agent + admin) cannot both spend the same balance, and a
      // failure part-way leaves no half-updated invoice/AR state.
      result = await db.transaction(async (tx) => {
        const [lockedItem] = await tx.select({ is_paid: delivery_items.is_paid }).from(delivery_items)
          .where(eq(delivery_items.id, itemId)).for("update");
        if (!lockedItem) throw new PaymentConflict(404, "Delivery item not found");
        const [existingReceipt] = await tx.select().from(receipts)
          .where(eq(receipts.delivery_item_id, itemId)).limit(1).for("update");

        const [priorPayment] = await tx.select().from(receipt_payment_entries)
          .where(eq(receipt_payment_entries.idempotency_key, payment_id)).limit(1);
        if (priorPayment) {
          if (!existingReceipt || priorPayment.receipt_id !== existingReceipt.id) throw new PaymentConflict(409, "Payment ID has already been used");
          return { paymentCents: 0, remainingCents: 0, overpaidCents: 0, isFullyPaid: lockedItem.is_paid ?? false, duplicate: true };
        }
        if (lockedItem.is_paid) throw new PaymentConflict(409, "Payment is already recorded for this delivery item");

        const [outstanding] = await tx.select().from(accounts_receivable)
          .where(and(eq(accounts_receivable.delivery_item_id, itemId), eq(accounts_receivable.status, "outstanding")))
          .limit(1).for("update");
        if (!outstanding) throw new PaymentConflict(409, "No outstanding balance was found for this delivery item");

        const paymentCents = Math.round(Number(payment_amount) * 100);
        const outstandingCents = Math.round(Number(outstanding.amount_due) * 100);
        if (paymentCents <= 0) {
          throw new PaymentConflict(400, "Payment amount must be greater than zero");
        }
        const remainingCents = Math.max(0, outstandingCents - paymentCents);
        const overpaidCents = Math.max(0, paymentCents - outstandingCents);
        const isFullyPaid = remainingCents === 0;
        const now = new Date();

        // An unpaid stop has no receipt yet; the first confirmed payment issues it.
        const receipt = existingReceipt ?? await issueReceipt(tx, {
          receiptNumber: newReceiptNumber(),
          itemId,
          customerId: item.destination_customer_id,
          truckId: delivery.truck_id,
          invoiceId: item.invoice_id,
          confirmedBy: req.user?.userId ?? null,
          confirmedAt: now,
          cashCollectedAmount: "0.00",
          paymentReference: null,
          notes: null,
        });

        const totalCollectedCents = Math.round(Number(receipt.cash_collected_amount) * 100) + paymentCents;

        await tx.update(delivery_items).set({
          receipt_number: receipt.receipt_number,
          is_paid: isFullyPaid,
          payment_method,
          payment_reference: payment_reference ?? null,
          paid_at: isFullyPaid ? now : null,
          updated_at: now,
        }).where(eq(delivery_items.id, itemId));

        await tx.update(receipts).set({
          payment_reference: payment_reference ?? null,
          cash_collected_amount: (totalCollectedCents / 100).toFixed(2),
        }).where(eq(receipts.id, receipt.id));

        await tx.insert(receipt_payment_entries).values({
          id: randomUUID(),
          receipt_id: receipt.id,
          idempotency_key: payment_id,
          amount: (paymentCents / 100).toFixed(2),
          payment_method,
          payment_reference: payment_reference ?? null,
          notes: notes ?? null,
          recorded_by: req.user?.userId ?? null,
        });

        await tx.update(accounts_receivable).set({
          amount_due: (remainingCents / 100).toFixed(2),
          status: isFullyPaid ? "paid" : "outstanding",
          updated_at: now,
        }).where(eq(accounts_receivable.id, outstanding.id));

        if (overpaidCents > 0) {
          await tx.insert(accounts_receivable).values({
            id: randomUUID(),
            customer_id: item.destination_customer_id,
            delivery_item_id: null,
            invoice_id: item.invoice_id,
            amount_due: (-overpaidCents / 100).toFixed(2),
            credit_type: "overpayment",
            status: "outstanding",
            notes: `Delivery overpayment on ${receipt.receipt_number}; available for a future order.`,
          });
        }

        await tx.update(invoices).set({
          ...(isFullyPaid ? { status: "paid" as const, payment_status: "paid" } : { payment_status: "partial" }),
          updated_at: now,
        }).where(eq(invoices.id, item.invoice_id));

        return { paymentCents, remainingCents, overpaidCents, isFullyPaid, duplicate: false };
      });
    } catch (error) {
      if (error instanceof PaymentConflict) return res.status(error.status).json({ error: error.message });
      throw error;
    }
    const { paymentCents, remainingCents, overpaidCents, isFullyPaid } = result;

    if (req.user && !result.duplicate) {
      await logAction(
        req.user.userId,
        "record_payment",
        "delivery_item",
        itemId,
        { is_paid: false },
        { is_paid: isFullyPaid, payment_amount: (paymentCents / 100).toFixed(2), remaining_amount: (remainingCents / 100).toFixed(2), overpayment_credit: (overpaidCents / 100).toFixed(2), payment_method }
      );
    }

    const updated = await db.query.delivery_items.findFirst({
      where: eq(delivery_items.id, itemId),
    });

    res.json(updated);
  } catch (error) {
    console.error("Error recording delivery payment:", error);
    res.status(500).json({ error: "Internal server error" });
  }
};
