import "dotenv/config";
import { randomUUID } from "crypto";
import { Pool, type PoolClient } from "pg";

const DAY_MS = 86_400_000;
const HISTORY_DAYS = 180;
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 1, connectionTimeoutMillis: 10000 });

type Row = Record<string, unknown>;
type Customer = { id: string; store_name: string; location: string; district: string | null; agent_id: string | null; payment_type: string | null };
type Truck = { id: string; district: string; driver_id: string | null; agent_profile_id: string; agent_user_id: string };
type Product = { id: string; name: string; sku: string | null; price: string; unit: string; weight: string | null };
type Outcome = "paid" | "partial" | "unpaid";

let seedState = 20260522;
function random() {
  seedState = (seedState + 0x6d2b79f5) | 0;
  let t = Math.imul(seedState ^ (seedState >>> 15), 1 | seedState);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}
const pick = <T,>(items: T[]): T => items[Math.floor(random() * items.length)];
const between = (min: number, max: number) => min + Math.floor(random() * (max - min + 1));

function dayAt(daysAgo: number, hour: number) {
  const date = new Date();
  date.setUTCHours(hour, 0, 0, 0);
  return new Date(date.getTime() - daysAgo * DAY_MS);
}
const isoDate = (date: Date) => date.toISOString().slice(0, 10);
const money = (cents: number) => (cents / 100).toFixed(2);

async function insert(client: PoolClient, table: string, row: Row) {
  const columns = Object.keys(row);
  const names = columns.map((column) => `"${column}"`).join(", ");
  const params = columns.map((_, index) => `$${index + 1}`).join(", ");
  await client.query(`INSERT INTO "${table}" (${names}) VALUES (${params})`, Object.values(row));
}

async function run() {
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required");
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const existing = await client.query("SELECT 1 FROM invoices LIMIT 1");
    if (existing.rowCount) throw new Error("Sales already exist; clear invoices and orders before seeding history.");

    const admin = (await client.query("SELECT id FROM users WHERE role = 'admin' ORDER BY created_at LIMIT 1")).rows[0] as { id: string } | undefined;
    const accountant = (await client.query("SELECT id FROM users WHERE module_permissions::text ILIKE '%accounting%' ORDER BY created_at LIMIT 1")).rows[0] as { id: string } | undefined ?? admin;
    const customers = (await client.query("SELECT id, store_name, location, district, agent_id, payment_type FROM customers")).rows as Customer[];
    const trucks = (await client.query("SELECT t.id, t.district, t.driver_id, t.agent_id AS agent_profile_id, a.user_id AS agent_user_id FROM trucks t JOIN agents a ON a.id = t.agent_id")).rows as Truck[];
    const products = (await client.query("SELECT id, name, sku, price, unit, weight FROM products WHERE is_archived = false AND is_discontinued IS DISTINCT FROM true")).rows as Product[];
    const costRows = (await client.query("SELECT product_id, cost_price FROM product_costs")).rows as { product_id: string; cost_price: string }[];
    const discountRows = (await client.query("SELECT customer_id, SUM(rate)::numeric AS rate FROM customer_discounts GROUP BY customer_id")).rows as { customer_id: string; rate: string }[];
    if (!admin || !accountant || !trucks.length || !products.length) throw new Error("Needs admin, accounting, truck, and product records.");

    const costByProduct = new Map(costRows.map((row) => [row.product_id, Number(row.cost_price)]));
    const discountByCustomer = new Map(discountRows.map((row) => [row.customer_id, Number(row.rate)]));
    const eligibleTrucks = (customer: Customer) => trucks.filter((truck) =>
      truck.district === customer.district && (!customer.agent_id || customer.agent_id === truck.agent_user_id));
    const sellable = customers.filter((customer) => customer.district && eligibleTrucks(customer).length > 0);
    if (!sellable.length) throw new Error("No customer has a matching truck district and agent.");

    const orders: Array<{ daysAgo: number; index: number; customer: Customer; truck: Truck; items: Array<{ product: Product; qty: number }>; outcome: Outcome; method: string }> = [];
    for (let daysAgo = HISTORY_DAYS; daysAgo >= 1; daysAgo--) {
      const day = dayAt(daysAgo, 9).getUTCDay();
      const count = day === 0 || day === 6 ? 1 : between(2, 3);
      for (let n = 0; n < count; n++) {
        const customer = pick(sellable);
        const truck = pick(eligibleTrucks(customer));
        const lineCount = between(1, 3);
        const chosen = new Set<Product>();
        while (chosen.size < Math.min(lineCount, products.length)) chosen.add(pick(products));
        const roll = random();
        const outcome: Outcome = roll < 0.7 ? "paid" : roll < 0.85 ? "partial" : "unpaid";
        const methodRoll = random();
        const method = methodRoll < 0.6 ? "cash" : methodRoll < 0.85 ? "gcash" : "bank_transfer";
        orders.push({
          daysAgo, index: orders.length, customer, truck, outcome, method,
          items: [...chosen].map((product) => ({ product, qty: between(2, 12) })),
        });
      }
    }

    const unitsByProduct = new Map<string, number>();
    for (const order of orders) for (const item of order.items) {
      unitsByProduct.set(item.product.id, (unitsByProduct.get(item.product.id) ?? 0) + item.qty);
    }

    const openingDate = dayAt(HISTORY_DAYS + 5, 6);
    const batchId = randomUUID();
    await insert(client, "inventory_batches", { id: batchId, batch_name: `SALES HISTORY OPENING STOCK ${isoDate(openingDate)}`, is_archived: false, created_at: openingDate, updated_at: openingDate });
    const openingItemByProduct = new Map<string, string>();
    for (const product of products) {
      const palletId = randomUUID();
      const itemId = randomUUID();
      await insert(client, "batch_pallets", {
        id: palletId, batch_id: batchId, pallet_id: `SEED-${(product.sku ?? product.id).slice(0, 12)}`,
        supplier_name: "Pampanga Cold Storage Supply", received_date: isoDate(openingDate),
        storage_zone: "Cold Storage A", placement_location: "Receiving Bay 1", created_at: openingDate, updated_at: openingDate,
      });
      await insert(client, "pallet_items", {
        id: itemId, pallet_id: palletId, product_id: product.id, qty_units: (unitsByProduct.get(product.id) ?? 0) + 40,
        expiration_date: isoDate(dayAt(-365, 0)), created_at: openingDate, updated_at: openingDate,
      });
      openingItemByProduct.set(product.id, itemId);
    }

    const usedReceipts = new Set<string>();
    const invoiceReceipt = () => {
      let receipt: string;
      do {
        const digits = String(between(0, 999_999)).padStart(6, "0");
        receipt = `${digits.slice(0, 3)} ${digits.slice(3)}`;
      } while (usedReceipts.has(receipt));
      usedReceipts.add(receipt);
      return receipt;
    };
    const receiptNumber = (date: Date) => {
      let number: string;
      do {
        number = `OR-${isoDate(date).replace(/-/g, "")}-${randomUUID().slice(0, 4).toUpperCase()}`;
      } while (usedReceipts.has(number));
      usedReceipts.add(number);
      return number;
    };

    const cashByCollectorDay = new Map<string, { userId: string; date: string; daysAgo: number; cents: number }>();
    for (const order of orders) {
      const createdAt = dayAt(order.daysAgo, 9 + (order.index % 5));
      const completedAt = new Date(createdAt.getTime() + 3 * 60 * 60 * 1000);
      const date = isoDate(createdAt);
      const bookingId = randomUUID();
      const orderPalletId = randomUUID();
      const invoiceId = randomUUID();
      const deliveryId = randomUUID();
      const deliveryItemId = randomUUID();
      const agentUserId = order.truck.agent_user_id;

      await insert(client, "bookings", {
        id: bookingId, customer_id: order.customer.id, created_by: agentUserId, status: "ready",
        prepared_delivery_date: date, approved_by: admin.id, approved_at: createdAt, created_at: createdAt,
      });

      const lines: Array<{ product: Product; qty: number; unitCents: number; amountCents: number; bookingItemId: string }> = [];
      for (const item of order.items) {
        const bookingItemId = randomUUID();
        await insert(client, "booking_items", { id: bookingItemId, booking_id: bookingId, product_id: item.product.id, qty_ordered: item.qty, created_at: createdAt });
        const unitCents = Math.round(Number(item.product.price) * 100);
        lines.push({ product: item.product, qty: item.qty, unitCents, amountCents: unitCents * item.qty, bookingItemId });
      }

      await insert(client, "order_pallets", { id: orderPalletId, order_id: bookingId, truck_id: order.truck.id, status: "shipped", created_at: createdAt, updated_at: completedAt });
      for (const line of lines) {
        const reservationId = randomUUID();
        await insert(client, "order_item_reservations", {
          id: reservationId, booking_id: bookingId, booking_item_id: line.bookingItemId, product_id: line.product.id,
          qty_reserved: line.qty, status: "converted", created_by: agentUserId, updated_by: agentUserId, created_at: createdAt, updated_at: completedAt,
        });
        await insert(client, "order_pallet_items", {
          id: randomUUID(), pallet_id: orderPalletId, product_id: line.product.id, qty_units: line.qty,
          unit_cost: money(costByProduct.get(line.product.id) ?? line.unitCents * 0.7), batch_item_id: openingItemByProduct.get(line.product.id)!,
          created_at: createdAt, updated_at: completedAt,
        });
      }

      const grossCents = lines.reduce((sum, line) => sum + line.amountCents, 0);
      const rate = discountByCustomer.get(order.customer.id) ?? 0.02;
      const discountCents = Math.round(grossCents * rate);
      const totalCents = grossCents - discountCents;
      const paidCents = order.outcome === "paid" ? totalCents : order.outcome === "partial" ? Math.round(totalCents / 2) : 0;
      const remainingCents = totalCents - paidCents;
      const isPaid = order.outcome === "paid";

      await insert(client, "invoices", {
        id: invoiceId, booking_id: bookingId, agent_id: agentUserId, status: isPaid ? "paid" : "issued",
        payment_status: order.outcome === "paid" ? "paid" : order.outcome === "partial" ? "partial" : "unpaid",
        receipt_number: invoiceReceipt(), customer_name: order.customer.store_name, customer_address: order.customer.location,
        customer_payment_type: order.customer.payment_type, discount_rate: rate.toFixed(4), gross_amount: money(grossCents),
        discount_amount: money(discountCents), total_amount: money(totalCents), credit_applied_amount: "0.00",
        prepared_by: agentUserId, created_at: createdAt, updated_at: completedAt,
      });
      for (const line of lines) {
        await insert(client, "invoice_items", {
          id: randomUUID(), invoice_id: invoiceId, product_id: line.product.id, product_name: line.product.name,
          product_sku: line.product.sku, qty_ordered: line.qty, unit_price: money(line.unitCents), amount: money(line.amountCents),
          unit_weight_kg: line.product.weight, unit_label: line.product.unit, created_at: createdAt,
        });
      }

      await insert(client, "deliveries", {
        id: deliveryId, truck_id: order.truck.id, driver_id: order.truck.driver_id, agent_id: order.truck.agent_profile_id,
        scheduled_date: date, scheduled_time: "09:00", status: "completed", created_at: createdAt, updated_at: completedAt,
      });
      const receipt = order.outcome === "unpaid" ? null : receiptNumber(completedAt);
      await insert(client, "delivery_items", {
        id: deliveryItemId, delivery_id: deliveryId, invoice_id: invoiceId, destination_customer_id: order.customer.id,
        status: "completed", completed_at: completedAt, receipt_number: receipt, is_paid: isPaid,
        payment_method: order.outcome === "unpaid" ? null : order.method, payment_reference: null,
        paid_at: isPaid ? completedAt : null, created_at: createdAt, updated_at: completedAt,
      });

      if (receipt) {
        const receiptId = randomUUID();
        const cashCollected = order.method === "cash" ? paidCents : 0;
        await insert(client, "receipts", {
          id: receiptId, receipt_number: receipt, delivery_item_id: deliveryItemId, customer_id: order.customer.id,
          truck_id: order.truck.id, invoice_id: invoiceId, confirmed_by: agentUserId, notes: null, payment_reference: null,
          cash_collected_amount: money(cashCollected), payment_verified_by: accountant.id, payment_verified_at: completedAt,
          payment_verification_remarks: null, confirmed_at: completedAt,
        });
        await insert(client, "receipt_payment_entries", {
          id: randomUUID(), receipt_id: receiptId, idempotency_key: randomUUID(), amount: money(paidCents),
          payment_method: order.method, payment_reference: order.method === "cash" ? null : `REF-${between(100000, 999999)}`,
          notes: null, recorded_by: agentUserId, verified_by: accountant.id, verified_at: completedAt,
          verification_remarks: order.method === "cash" ? null : "Cleared", created_at: completedAt,
        });
      }

      if (remainingCents > 0) {
        await insert(client, "accounts_receivable", {
          id: randomUUID(), customer_id: order.customer.id, delivery_item_id: deliveryItemId, invoice_id: invoiceId,
          amount_due: money(remainingCents), credit_type: null, status: "outstanding",
          notes: isPaid ? null : "Delivered without payment", created_at: completedAt, updated_at: completedAt,
        });
      }

      await insert(client, "audit_logs", {
        id: randomUUID(), user_id: agentUserId, action: "confirm", resource_type: "delivery_item", resource_id: deliveryItemId,
        before_state: null,
        after_state: JSON.stringify({
          is_paid: isPaid,
          payment_amount: money(paidCents),
          remaining_amount: money(remainingCents),
          payment_method: paidCents > 0 ? order.method : "none",
        }),
        created_at: completedAt,
      });

      if (paidCents > 0 && order.method === "cash") {
        const key = `${agentUserId}|${date}`;
        const current = cashByCollectorDay.get(key) ?? { userId: agentUserId, date, daysAgo: order.daysAgo, cents: 0 };
        current.cents += paidCents;
        cashByCollectorDay.set(key, current);
      }
    }

    for (const day of cashByCollectorDay.values()) {
      const createdAt = dayAt(day.daysAgo, 18);
      await insert(client, "cash_remittances", {
        id: randomUUID(), remitted_by: day.userId, received_by: accountant.id, business_date: day.date,
        expected_amount: money(day.cents), counted_amount: money(day.cents), denominations: {}, notes: null, created_at: createdAt,
      });
    }

    const categories = ["Fuel", "Supplies", "Utilities", "Maintenance"];
    for (let daysAgo = HISTORY_DAYS; daysAgo >= 7; daysAgo -= 14) {
      const createdAt = dayAt(daysAgo, 10);
      const category = categories[(HISTORY_DAYS - daysAgo) / 14 % categories.length];
      await insert(client, "expenses", {
        id: randomUUID(), category, description: `${category} for the week`, amount: money(between(50_000, 800_000)),
        status: "paid", submitted_by: admin.id, approved_by: admin.id, paid_by: accountant.id, reject_reason: null,
        created_at: createdAt, updated_at: createdAt, approved_at: createdAt, paid_at: createdAt,
      });
    }

    await client.query("COMMIT");
    const totals = await client.query(`
      SELECT
        (SELECT COUNT(*)::int FROM bookings) AS orders,
        (SELECT COUNT(*)::int FROM invoices) AS invoices,
        (SELECT COUNT(*)::int FROM receipts) AS receipts,
        (SELECT COUNT(*)::int FROM accounts_receivable) AS ar_rows,
        (SELECT COUNT(*)::int FROM cash_remittances) AS remittances
    `);
    console.log("Sales history seeded:", totals.rows[0]);
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
