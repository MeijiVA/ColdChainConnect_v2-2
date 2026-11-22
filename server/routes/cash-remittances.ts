import type { RequestHandler } from "express";
import { randomUUID } from "crypto";
import { and, eq, gte, inArray, lt } from "drizzle-orm";
import { db } from "../db";
import { audit_logs, cash_remittances, delivery_items, invoices, users } from "../db/schema";
import type { AuthRequest } from "../middleware/auth";
import { logAction } from "../middleware/audit-logger";
import { denominationTotalCents, todayInManila, type CashCollectionRow, type CashRemittance, type DenominationCounts, type MyCashPayment } from "../../shared/api";

// End-of-day cash: collectors (drivers, agents) record cash payments on deliveries during the day and
// hand the cash to the office, which counts it by denomination and confirms here.
//
// "Expected" is never taken from the client. It is rebuilt from the audit trail: every confirm and
// record_payment entry on a delivery item carries the amount collected and the method.

const DAY_MS = 24 * 60 * 60 * 1000;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_NOTES_LENGTH = 500;
const CASH_ACTIONS = ["confirm", "record_payment"];

/** The business runs on Philippine time (UTC+8), whatever timezone the server is in. */
export function businessDayBounds(date: string): { start: Date; end: Date } | null {
  if (!ISO_DATE.test(date)) return null;
  const start = new Date(`${date}T00:00:00+08:00`);
  if (Number.isNaN(start.getTime())) return null;
  // Reject rolled-over dates such as 2026-02-31.
  if (new Date(start.getTime() + 8 * 60 * 60 * 1000).toISOString().slice(0, 10) !== date) return null;
  return { start, end: new Date(start.getTime() + DAY_MS) };
}

export { todayInManila };

interface CashEntry {
  user_id: string;
  after_state: string | null;
}

/** The cash amount in centavos recorded by one audit entry, or null when it is not a cash payment. */
function cashPaymentCents(afterState: string | null): number | null {
  if (!afterState) return null;
  let state: { payment_method?: unknown; payment_amount?: unknown };
  try {
    state = JSON.parse(afterState);
  } catch {
    return null;
  }
  if (state.payment_method !== "cash") return null;
  const cents = Math.round(Number(state.payment_amount) * 100);
  return Number.isFinite(cents) && cents > 0 ? cents : null;
}

/** Pure: sums the cash payments in audit entries per user, in centavos. */
export function sumCashByUser(entries: CashEntry[]): Map<string, { cents: number; count: number }> {
  const totals = new Map<string, { cents: number; count: number }>();
  for (const entry of entries) {
    const cents = cashPaymentCents(entry.after_state);
    if (cents === null) continue;
    const current = totals.get(entry.user_id) ?? { cents: 0, count: 0 };
    current.cents += cents;
    current.count += 1;
    totals.set(entry.user_id, current);
  }
  return totals;
}

async function cashCollectedOn(date: string) {
  const bounds = businessDayBounds(date)!;
  const entries = await db
    .select({ user_id: audit_logs.user_id, after_state: audit_logs.after_state })
    .from(audit_logs)
    .where(
      and(
        eq(audit_logs.resource_type, "delivery_item"),
        inArray(audit_logs.action, CASH_ACTIONS),
        gte(audit_logs.created_at, bounds.start),
        lt(audit_logs.created_at, bounds.end),
      ),
    );
  return sumCashByUser(entries);
}

const toPesos = (cents: number) => (cents / 100).toFixed(2);

/** Postgres unique violation (23505). Drizzle wraps driver errors, so the code may be on `cause`. */
function isUniqueViolation(error: unknown): boolean {
  for (let current: unknown = error, depth = 0; current && typeof current === "object" && depth < 3; depth++) {
    if ((current as { code?: unknown }).code === "23505") return true;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

async function toRemittances(rows: (typeof cash_remittances.$inferSelect)[]): Promise<CashRemittance[]> {
  const ids = [...new Set(rows.flatMap((row) => [row.remitted_by, row.received_by]))];
  const names = new Map<string, string>();
  if (ids.length > 0) {
    for (const user of await db.select({ id: users.id, username: users.username }).from(users).where(inArray(users.id, ids))) {
      names.set(user.id, user.username);
    }
  }
  return rows.map((row) => ({
    id: row.id,
    remitted_by: row.remitted_by,
    remitted_by_username: names.get(row.remitted_by) ?? null,
    received_by: row.received_by,
    received_by_username: names.get(row.received_by) ?? null,
    business_date: row.business_date,
    expected_amount: row.expected_amount,
    counted_amount: row.counted_amount,
    denominations: row.denominations as DenominationCounts,
    notes: row.notes,
    created_at: row.created_at.toISOString(),
  }));
}

// ─── GET /api/cash-remittances/collections?date=YYYY-MM-DD ────────────────────

export const listCashCollections: RequestHandler = async (req: AuthRequest, res) => {
  const date = typeof req.query.date === "string" && req.query.date ? req.query.date : todayInManila();
  if (!businessDayBounds(date)) return res.status(400).json({ error: "date must be a real YYYY-MM-DD date" });
  if (!process.env.DATABASE_URL) return res.json([]);

  try {
    const [collected, remittanceRows] = await Promise.all([
      cashCollectedOn(date),
      db.select().from(cash_remittances).where(eq(cash_remittances.business_date, date)),
    ]);
    const remittances = new Map((await toRemittances(remittanceRows)).map((row) => [row.remitted_by, row]));

    const userIds = [...new Set([...collected.keys(), ...remittances.keys()])];
    if (userIds.length === 0) return res.json([]);
    const people = await db
      .select({ id: users.id, username: users.username, role: users.role })
      .from(users)
      .where(inArray(users.id, userIds));

    const rows: CashCollectionRow[] = people
      .map((person) => ({
        user_id: person.id,
        username: person.username,
        role: person.role,
        expected: toPesos(collected.get(person.id)?.cents ?? 0),
        payment_count: collected.get(person.id)?.count ?? 0,
        remittance: remittances.get(person.id) ?? null,
      }))
      .sort((a, b) => Number(Boolean(a.remittance)) - Number(Boolean(b.remittance)) || a.username.localeCompare(b.username));

    res.json(rows);
  } catch (error) {
    console.error("Error listing cash collections:", error);
    res.status(500).json({ error: "Internal server error" });
  }
};

// ─── GET /api/cash-remittances/mine ───────────────────────────────────────────

const MY_CASH_LOOKBACK_DAYS = 60;

export const listMyUnconfirmedPayments: RequestHandler = async (req: AuthRequest, res) => {
  if (!req.user) return res.status(401).json({ error: "Authentication required" });
  if (!process.env.DATABASE_URL) return res.json([]);

  const userId = req.user.userId;
  const since = new Date(Date.now() - MY_CASH_LOOKBACK_DAYS * DAY_MS);
  const sinceDate = todayInManila(since);

  try {
    const [entries, remittanceRows] = await Promise.all([
      db
        .select({ id: audit_logs.id, resource_id: audit_logs.resource_id, after_state: audit_logs.after_state, created_at: audit_logs.created_at })
        .from(audit_logs)
        .where(
          and(
            eq(audit_logs.resource_type, "delivery_item"),
            eq(audit_logs.user_id, userId),
            inArray(audit_logs.action, CASH_ACTIONS),
            gte(audit_logs.created_at, since),
          ),
        ),
      db
        .select({ business_date: cash_remittances.business_date })
        .from(cash_remittances)
        .where(and(eq(cash_remittances.remitted_by, userId), gte(cash_remittances.business_date, sinceDate))),
    ]);

    const handedOverDays = new Set(remittanceRows.map((row) => row.business_date));
    const cashPayments = entries
      .map((entry) => ({ entry, cents: cashPaymentCents(entry.after_state) }))
      .filter((payment): payment is { entry: (typeof entries)[number]; cents: number } => payment.cents !== null)
      .filter(({ entry }) => !handedOverDays.has(todayInManila(entry.created_at)));

    const itemIds = [...new Set(cashPayments.map(({ entry }) => entry.resource_id).filter((id): id is string => Boolean(id)))];
    const items = itemIds.length
      ? await db
          .select({ id: delivery_items.id, invoice_id: delivery_items.invoice_id })
          .from(delivery_items)
          .where(inArray(delivery_items.id, itemIds))
      : [];
    const invoiceIds = [...new Set(items.map((item) => item.invoice_id))];
    const invoiceRows = invoiceIds.length
      ? await db
          .select({ id: invoices.id, booking_id: invoices.booking_id, customer_name: invoices.customer_name })
          .from(invoices)
          .where(inArray(invoices.id, invoiceIds))
      : [];
    const invoiceByItem = new Map(items.map((item) => [item.id, invoiceRows.find((invoice) => invoice.id === item.invoice_id)]));

    const payments: MyCashPayment[] = cashPayments
      .map(({ entry, cents }) => {
        const invoice = entry.resource_id ? invoiceByItem.get(entry.resource_id) : undefined;
        return {
          id: entry.id,
          business_date: todayInManila(entry.created_at),
          order_number: invoice?.booking_id.slice(0, 8).toUpperCase() ?? "",
          customer_name: invoice?.customer_name ?? null,
          amount: toPesos(cents),
          created_at: entry.created_at.toISOString(),
        };
      })
      .sort((a, b) => b.created_at.localeCompare(a.created_at));

    res.json(payments);
  } catch (error) {
    console.error("Error listing own unconfirmed payments:", error);
    res.status(500).json({ error: "Internal server error" });
  }
};

// ─── POST /api/cash-remittances ───────────────────────────────────────────────

export const createCashRemittance: RequestHandler = async (req: AuthRequest, res) => {
  if (!req.user) return res.status(401).json({ error: "Authentication required" });
  if (!process.env.DATABASE_URL) return res.status(503).json({ error: "Database not configured" });

  const { remitted_by, business_date, denominations, notes } = req.body ?? {};
  if (typeof remitted_by !== "string" || !remitted_by) {
    return res.status(400).json({ error: "Choose who handed over the cash" });
  }
  if (typeof business_date !== "string" || !businessDayBounds(business_date)) {
    return res.status(400).json({ error: "business_date must be a real YYYY-MM-DD date" });
  }
  if (business_date > todayInManila()) {
    return res.status(400).json({ error: "Cash cannot be reconciled for a future date" });
  }
  const countedCents = denominationTotalCents(denominations);
  if (countedCents === null) {
    return res.status(400).json({ error: "denominations must be whole-number counts for known bills and coins" });
  }
  if (notes !== undefined && notes !== null && typeof notes !== "string") {
    return res.status(400).json({ error: "Notes must be text" });
  }
  const cleanedNotes = typeof notes === "string" ? notes.trim() : "";
  if (cleanedNotes.length > MAX_NOTES_LENGTH) {
    return res.status(400).json({ error: `Notes can be at most ${MAX_NOTES_LENGTH} characters` });
  }

  // Separation of duties, like payment verification: you cannot confirm your own cash.
  if (remitted_by === req.user.userId) {
    return res.status(409).json({ error: "You cannot confirm your own cash; someone else must receive it" });
  }

  try {
    const [remitter] = await db.select({ id: users.id }).from(users).where(eq(users.id, remitted_by));
    if (!remitter) return res.status(404).json({ error: "That user does not exist" });

    const expectedCents = (await cashCollectedOn(business_date)).get(remitted_by)?.cents ?? 0;
    if (countedCents !== expectedCents && !cleanedNotes) {
      return res.status(400).json({ error: "The count does not match what was expected. Add a note explaining the difference." });
    }

    const id = randomUUID();
    try {
      await db.insert(cash_remittances).values({
        id,
        remitted_by,
        received_by: req.user.userId,
        business_date,
        expected_amount: toPesos(expectedCents),
        counted_amount: toPesos(countedCents),
        denominations: denominations as Record<string, number>,
        notes: cleanedNotes || null,
      });
    } catch (error) {
      // The unique index (collector, day) is the real guard; two clerks confirming at once cannot both win.
      if (isUniqueViolation(error)) {
        return res.status(409).json({ error: "This person's cash for that day is already confirmed" });
      }
      throw error;
    }

    const [row] = await db.select().from(cash_remittances).where(eq(cash_remittances.id, id));
    const [remittance] = await toRemittances([row]);

    await logAction(
      req.user.userId,
      "reconcile_cash",
      "cash_remittance",
      id,
      undefined,
      { remitted_by, business_date, expected_amount: row.expected_amount, counted_amount: row.counted_amount },
    );

    res.status(201).json(remittance);
  } catch (error) {
    console.error("Error recording cash remittance:", error);
    res.status(500).json({ error: "Internal server error" });
  }
};
