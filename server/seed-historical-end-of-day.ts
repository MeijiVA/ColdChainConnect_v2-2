import { randomUUID } from "crypto";
import { Pool } from "pg";

// Backfills End-of-Day cash reconciliation for the historical operational data created by
// seed-historical-data.ts.
//
// The End-of-Day screen rebuilds "expected cash" from audit_logs (resource_type = 'delivery_item',
// action 'confirm' / 'record_payment', after_state.payment_method = 'cash'), and a day is "done" when a
// cash_remittances row exists for that collector and business date. The historical seed writes neither,
// so every past day shows nothing collected and nothing handed over.
//
// This script, for every seeded cash payment on a PAST Manila business day:
//   1. adds the missing delivery_item 'confirm' audit entry (so expected cash is correct), and
//   2. adds one accepted cash_remittances row per collector per day, counted by denomination and
//      received by Accounting (or an admin when no accounting user exists).
//
// Today's business day is left open on purpose. Safe to re-run: guarded by a marker audit entry, and by
// the (collector, day) unique index plus an explicit existing-row check.

const marker = "seed_historical_end_of_day_v1";
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 1, connectionTimeoutMillis: 10000 });

const MANILA_OFFSET_MS = 8 * 60 * 60 * 1000;
const CASH_ACTIONS = ["confirm", "record_payment"];

// Same face values as CASH_DENOMINATIONS in shared/api.ts, in centavos, largest first.
const DENOMINATIONS: ReadonlyArray<readonly [string, number]> = [
  ["1000", 100000],
  ["500", 50000],
  ["200", 20000],
  ["100", 10000],
  ["50", 5000],
  ["20", 2000],
  ["10", 1000],
  ["5", 500],
  ["1", 100],
  ["0.25", 25],
];

type CashPayment = { entry_id: string; amount: string; recorded_by: string; created_at: string; delivery_item_id: string };

// created_at is a timestamp without time zone holding UTC (the app writes ISO/UTC). Read it as text and
// parse it as UTC so the result does not depend on the timezone of the machine running this script.
const parseUtc = (value: string) => new Date(`${value.replace(" ", "T")}Z`);
const manilaDate = (date: Date) => new Date(date.getTime() + MANILA_OFFSET_MS).toISOString().slice(0, 10);
const money = (cents: number) => (cents / 100).toFixed(2);

function breakDown(cents: number) {
  let left = cents;
  const counts: Record<string, number> = {};
  for (const [label, value] of DENOMINATIONS) {
    const count = Math.floor(left / value);
    if (count > 0) {
      counts[label] = count;
      left -= count * value;
    }
  }
  return { counts, remainderCents: left };
}

async function run() {
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required");
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [marker]);
    const priorRun = await client.query("SELECT id FROM audit_logs WHERE action = $1 AND resource_type = 'seed' LIMIT 1", [marker]);
    if (priorRun.rowCount) {
      await client.query("ROLLBACK");
      console.log("Historical end-of-day data is already present; no changes made.");
      return;
    }

    const [adminRows, accountantRows] = await Promise.all([
      client.query("SELECT id FROM users WHERE role = 'admin' ORDER BY created_at LIMIT 1"),
      client.query("SELECT id FROM users WHERE module_permissions::text ILIKE '%accounting%' ORDER BY created_at LIMIT 1"),
    ]);
    const adminId = adminRows.rows[0]?.id as string | undefined;
    const receiverId = (accountantRows.rows[0]?.id as string | undefined) ?? adminId;
    if (!adminId || !receiverId) throw new Error("The database needs an existing admin (and ideally an accounting) user.");

    // Cash payments that came from the historical seed: their booking audit entry is tagged seeded.
    const paymentRows = await client.query(
      `SELECT e.id AS entry_id, e.amount::text AS amount, e.recorded_by, e.created_at::text AS created_at, r.delivery_item_id
         FROM receipt_payment_entries e
         JOIN receipts r ON r.id = e.receipt_id
        WHERE e.payment_method = 'cash'
          AND e.recorded_by IS NOT NULL
          AND EXISTS (
                SELECT 1 FROM audit_logs a
                 WHERE a.resource_type = 'booking' AND a.action = 'create'
                   AND a.after_state LIKE '%"seeded":true%'
                   AND position(r.invoice_id IN a.after_state) > 0
              )
        ORDER BY e.created_at`,
    );
    const today = manilaDate(new Date());
    const payments = (paymentRows.rows as CashPayment[]).filter((row) => manilaDate(parseUtc(row.created_at)) < today);
    if (!payments.length) {
      await client.query("ROLLBACK");
      console.log("No historical cash payments found. Run `pnpm db:seed:history` first; no changes made.");
      return;
    }

    // 1. Missing delivery_item audit entries, so the app can rebuild expected cash for each day.
    const audited = await client.query(
      "SELECT DISTINCT resource_id FROM audit_logs WHERE resource_type = 'delivery_item' AND action = ANY($1) AND resource_id = ANY($2)",
      [CASH_ACTIONS, payments.map((row) => row.delivery_item_id)],
    );
    const alreadyAudited = new Set<string>((audited.rows as { resource_id: string }[]).map((row) => row.resource_id));
    let auditCount = 0;
    for (const payment of payments) {
      if (alreadyAudited.has(payment.delivery_item_id)) continue;
      alreadyAudited.add(payment.delivery_item_id);
      await client.query(
        `INSERT INTO audit_logs (id, user_id, action, resource_type, resource_id, before_state, after_state, created_at)
         VALUES ($1, $2, 'confirm', 'delivery_item', $3, NULL, $4, $5::timestamp)`,
        [
          randomUUID(),
          payment.recorded_by,
          payment.delivery_item_id,
          JSON.stringify({ seeded: true, payment_method: "cash", payment_amount: Number(payment.amount).toFixed(2), is_paid: true }),
          parseUtc(payment.created_at).toISOString(),
        ],
      );
      auditCount++;
    }

    // 2. One accepted remittance per collector per past day.
    const existing = await client.query("SELECT remitted_by, business_date FROM cash_remittances");
    const taken = new Set<string>((existing.rows as { remitted_by: string; business_date: string }[]).map((row) => `${row.remitted_by}|${row.business_date}`));

    const groups = new Map<string, { remittedBy: string; date: string; cents: number; lastAt: Date }>();
    for (const payment of payments) {
      const at = parseUtc(payment.created_at);
      const date = manilaDate(at);
      const key = `${payment.recorded_by}|${date}`;
      const group = groups.get(key) ?? { remittedBy: payment.recorded_by, date, cents: 0, lastAt: at };
      group.cents += Math.round(Number(payment.amount) * 100);
      if (at > group.lastAt) group.lastAt = at;
      groups.set(key, group);
    }

    let remittanceCount = 0;
    let skipped = 0;
    for (const [key, group] of groups) {
      if (taken.has(key) || group.remittedBy === receiverId || group.cents <= 0) {
        skipped++;
        continue;
      }
      const { counts, remainderCents } = breakDown(group.cents);
      const countedCents = group.cents - remainderCents;
      const notes = remainderCents === 0
        ? "Cash counted by denomination and confirmed at end of day."
        : `Short by PHP ${money(remainderCents)}: below the smallest coin, written off at the count.`;
      const createdAt = new Date(group.lastAt.getTime() + 90 * 60 * 1000).toISOString();
      const id = randomUUID();
      const inserted = await client.query(
        `INSERT INTO cash_remittances (id, remitted_by, received_by, business_date, expected_amount, counted_amount, denominations, notes, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9::timestamp)
         ON CONFLICT (remitted_by, business_date) DO NOTHING`,
        [id, group.remittedBy, receiverId, group.date, money(group.cents), money(countedCents), JSON.stringify(counts), notes, createdAt],
      );
      if (!inserted.rowCount) {
        skipped++;
        continue;
      }
      await client.query(
        `INSERT INTO audit_logs (id, user_id, action, resource_type, resource_id, before_state, after_state, created_at)
         VALUES ($1, $2, 'reconcile_cash', 'cash_remittance', $3, NULL, $4, $5::timestamp)`,
        [
          randomUUID(),
          receiverId,
          id,
          JSON.stringify({ remitted_by: group.remittedBy, business_date: group.date, expected_amount: money(group.cents), counted_amount: money(countedCents) }),
          createdAt,
        ],
      );
      remittanceCount++;
    }

    const now = new Date().toISOString();
    await client.query(
      `INSERT INTO audit_logs (id, user_id, action, resource_type, resource_id, before_state, after_state, created_at)
       VALUES ($1, $2, $3, 'seed', NULL, NULL, $4, $5::timestamp)`,
      [randomUUID(), adminId, marker, JSON.stringify({ cash_audit_entries: auditCount, remittances: remittanceCount, skipped, through: today }), now],
    );
    await client.query("COMMIT");
    console.log(`Added ${auditCount} cash audit entries and ${remittanceCount} accepted end-of-day remittances (${skipped} skipped).`);
    console.log(`Covers every collector-day before ${today} (Manila time); today's business day was left open.`);
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

run().catch((error) => {
  console.error("End-of-day seed failed:", error);
  process.exitCode = 1;
}).finally(() => pool.end());
