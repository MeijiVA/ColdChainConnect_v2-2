import { randomUUID } from "crypto";
import { Pool, type PoolClient } from "pg";

const marker = "seed_historical_operational_data_v1";
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 1, connectionTimeoutMillis: 10000 });

type Row = Record<string, unknown>;
type Product = { id: string; name: string; sku: string | null; price: string; unit: string; weight: string | null };
type Customer = { id: string; store_name: string; location: string; district: string | null; agent_id: string | null; credit_limit: string | null; credit_terms_days: number };
type Truck = { id: string; district: string; driver_id: string | null; agent_profile_id: string | null; agent_user_id: string; driver_user_id: string | null };

async function insert(client: PoolClient, table: string, row: Row) {
  const columns = Object.keys(row);
  const values = Object.values(row);
  const names = columns.map((column) => `"${column}"`).join(", ");
  const params = columns.map((_, index) => `$${index + 1}`).join(", ");
  await client.query(`INSERT INTO "${table}" (${names}) VALUES (${params})`, values);
}

function asDate(daysAgo: number, hour = 9) {
  const date = new Date();
  date.setUTCHours(0, 0, 0, 0);
  date.setUTCDate(date.getUTCDate() - daysAgo);
  date.setUTCHours(hour, 0, 0, 0);
  return date;
}

function isoDate(date: Date) {
  return date.toISOString().slice(0, 10);
}

function money(cents: number) {
  return (cents / 100).toFixed(2);
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
      console.log("Historical operational data is already present; no changes made.");
      return;
    }

    const [adminRows, accountantRows, customerRows, truckRows, productRows, stockRows, discountRows, bookingPrefixRows, palletPrefixRows, receiptRows, invoiceReceiptRows] = await Promise.all([
      client.query("SELECT id FROM users WHERE role = 'admin' ORDER BY created_at LIMIT 1"),
      client.query("SELECT id FROM users WHERE module_permissions::text ILIKE '%accounting%' ORDER BY created_at LIMIT 1"),
      client.query("SELECT id, store_name, location, district, agent_id, credit_limit, credit_terms_days FROM customers ORDER BY store_name"),
      client.query("SELECT t.id, t.district, t.driver_id, t.agent_id AS agent_profile_id, a.user_id AS agent_user_id, d.user_id AS driver_user_id FROM trucks t JOIN agents a ON a.id = t.agent_id LEFT JOIN drivers d ON d.id = t.driver_id ORDER BY t.license_plate"),
      client.query("SELECT id, name, sku, price, unit, weight FROM products WHERE is_archived = false AND is_discontinued IS DISTINCT FROM true ORDER BY name"),
      client.query("SELECT pi.product_id, COALESCE(SUM(pi.qty_units), 0)::int AS qty FROM pallet_items pi JOIN batch_pallets bp ON bp.id = pi.pallet_id JOIN inventory_batches b ON b.id = bp.batch_id WHERE b.is_archived = false GROUP BY pi.product_id"),
      client.query("SELECT customer_id, COALESCE(SUM(rate), 0)::numeric AS rate FROM customer_discounts GROUP BY customer_id"),
      client.query("SELECT id FROM bookings"),
      client.query("SELECT id FROM order_pallets"),
      client.query("SELECT receipt_number FROM receipts"),
      client.query("SELECT receipt_number FROM invoices WHERE receipt_number IS NOT NULL"),
    ]);

    const adminId = adminRows.rows[0]?.id as string | undefined;
    const accountantId = (accountantRows.rows[0]?.id as string | undefined) ?? adminId;
    const customers = customerRows.rows as Customer[];
    const trucks = truckRows.rows as Truck[];
    const products = productRows.rows as Product[];
    if (!adminId || !accountantId || !trucks.length || !products.length || !customers.length) {
      throw new Error("The database needs existing admin, accounting, truck, product, and customer records.");
    }
    const stockByProduct = new Map<string, number>((stockRows.rows as { product_id: string; qty: number }[]).map((row) => [row.product_id, row.qty]));
    const discountByCustomer = new Map<string, number>((discountRows.rows as { customer_id: string; rate: string }[]).map((row) => [row.customer_id, Number(row.rate)]));
    const customerIndices = new Map<string, number>();
    const usedOrderPrefixes = new Set<string>((bookingPrefixRows.rows as { id: string }[]).map((row) => row.id.slice(0, 8).toUpperCase()));
    const usedPalletPrefixes = new Set<string>((palletPrefixRows.rows as { id: string }[]).map((row) => row.id.slice(0, 8).toUpperCase()));
    const receiptNumbers = new Set<string>([
      ...(receiptRows.rows as { receipt_number: string }[]).map((row) => row.receipt_number),
      ...(invoiceReceiptRows.rows as { receipt_number: string }[]).map((row) => row.receipt_number),
    ]);
    const makeId = (used: Set<string>) => {
      let id = randomUUID();
      while (used.has(id.slice(0, 8).toUpperCase())) id = randomUUID();
      used.add(id.slice(0, 8).toUpperCase());
      return id;
    };
    const invoiceReceipt = () => {
      let receipt = "";
      do {
        const digits = String(Math.floor(Math.random() * 1_000_000)).padStart(6, "0");
        receipt = `${digits.slice(0, 3)} ${digits.slice(3)}`;
      } while (receiptNumbers.has(receipt));
      receiptNumbers.add(receipt);
      return receipt;
    };
    const receiptNumber = (date: Date) => {
      let receipt = "";
      do {
        receipt = `OR-${isoDate(date).replace(/-/g, "")}-${randomUUID().slice(0, 4).toUpperCase()}`;
      } while (receiptNumbers.has(receipt));
      receiptNumbers.add(receipt);
      return receipt;
    };

    const sortedCustomers = customers.filter((customer) => customer.district);
    const sales: Array<{ daysAgo: number; customer: Customer; truck: Truck; items: Array<{ product: Product; qty: number }>; payment: "paid" | "partial" | "overpaid" }> = [];
    const addSale = (daysAgo: number, index: number) => {
      const candidates = sortedCustomers.filter((customer) => trucks.some((truck) =>
        truck.district === customer.district && (!customer.agent_id || customer.agent_id === truck.agent_user_id)
      ));
      if (!candidates.length) throw new Error("No customer has a matching truck district and agent assignment.");
      const customer = candidates[index % candidates.length];
      const eligibleTrucks = trucks.filter((truck) => truck.district === customer.district && (!customer.agent_id || customer.agent_id === truck.agent_user_id));
      const truck = eligibleTrucks[index % eligibleTrucks.length];
      const customerIndex = customerIndices.get(customer.id) ?? 0;
      customerIndices.set(customer.id, customerIndex + 1);
      const coreProduct = products[0];
      const secondProduct = products[(index + Math.floor(daysAgo / 4) + 1) % products.length];
      const thirdProduct = products[(index * 3 + 2) % products.length];
      const items = [{ product: coreProduct, qty: 2 + ((index + daysAgo) % 7) }];
      if (secondProduct.id !== coreProduct.id) items.push({ product: secondProduct, qty: 2 + ((index * 2 + daysAgo) % 6) });
      if (index % 3 === 0 && thirdProduct.id !== coreProduct.id && thirdProduct.id !== secondProduct.id) {
        items.push({ product: thirdProduct, qty: 1 + ((index + 2) % 5) });
      }
      const payment = daysAgo === 9 ? "overpaid" : [3, 12, 21, 27].includes(daysAgo) ? "partial" : "paid";
      sales.push({ daysAgo, customer, truck, items, payment });
      if (customer.credit_limit === null && payment !== "paid") customer.credit_limit = "25000.00";
    };

    for (let daysAgo = 180, index = 0; daysAgo >= 30; daysAgo -= 4, index++) addSale(daysAgo, index);
    for (let daysAgo = 29, index = 0; daysAgo >= 0; daysAgo--, index++) addSale(daysAgo, index + 50);

    const unitsByProduct = new Map<string, number>();
    for (const sale of sales) for (const item of sale.items) {
      unitsByProduct.set(item.product.id, (unitsByProduct.get(item.product.id) ?? 0) + item.qty);
    }
    const openingDate = asDate(181);
    const batchId = randomUUID();
    await insert(client, "inventory_batches", {
      id: batchId,
      batch_name: `HISTORICAL OPENING STOCK ${isoDate(openingDate)}`,
      is_archived: false,
      created_at: openingDate,
      updated_at: openingDate,
    });

    const sourceByProduct = new Map<string, { id: string; remaining: number }>();
    for (const product of products) {
      const palletId = randomUUID();
      const sourceId = randomUUID();
      const salesUnits = unitsByProduct.get(product.id) ?? 0;
      const openingUnits = salesUnits + 12;
      sourceByProduct.set(product.id, { id: sourceId, remaining: openingUnits });
      await insert(client, "batch_pallets", {
        id: palletId, batch_id: batchId, pallet_id: `HIST-${product.sku ?? product.id.slice(0, 8)}`,
        supplier_name: "Pampanga Cold Storage Supply", received_date: isoDate(openingDate),
        storage_zone: "Cold Storage A", placement_location: "Receiving Bay 1", created_at: openingDate, updated_at: openingDate,
      });
      await insert(client, "pallet_items", {
        id: sourceId, pallet_id: palletId, product_id: product.id, qty_units: openingUnits,
        expiration_date: isoDate(asDate(-365)), created_at: openingDate, updated_at: openingDate,
      });
    }

    const now = new Date();
    let orderCount = 0;
    for (const [index, sale] of sales.entries()) {
      const createdAt = asDate(sale.daysAgo, 9 + (index % 7));
      const deliveryDate = isoDate(createdAt);
      const bookingId = makeId(usedOrderPrefixes);
      const bookingItemIds: string[] = [];
      const palletId = makeId(usedPalletPrefixes);
      const invoiceId = randomUUID();
      const deliveryId = randomUUID();
      const deliveryItemId = randomUUID();
      const receiptId = randomUUID();
      const receipt = receiptNumber(createdAt);
      const discountRate = discountByCustomer.get(sale.customer.id) ?? 0;
      const invoiceLines = sale.items.map(({ product, qty }) => {
        const unitCents = Math.round(Number(product.price) * 100);
        return { product, qty, unitCents, amountCents: unitCents * qty };
      });
      const grossCents = invoiceLines.reduce((sum, line) => sum + line.amountCents, 0);
      const discountCents = Math.round(grossCents * discountRate);
      const totalCents = grossCents - discountCents;
      const collectedCents = sale.payment === "partial"
        ? Math.round(totalCents * 0.7)
        : sale.payment === "overpaid" ? totalCents + 25000 : totalCents;
      const dueCents = Math.max(0, totalCents - collectedCents);
      const overpaidCents = Math.max(0, collectedCents - totalCents);
      const paymentMethod = index % 4 === 0 ? "bank_transfer" : index % 4 === 1 ? "gcash" : "cash";

      await insert(client, "bookings", {
        id: bookingId, customer_id: sale.customer.id, created_by: sale.truck.agent_user_id,
        status: "approved", prepared_delivery_date: deliveryDate, approved_by: adminId,
        approved_at: createdAt, created_at: createdAt,
      });
      for (const line of invoiceLines) {
        const bookingItemId = randomUUID();
        bookingItemIds.push(bookingItemId);
        await insert(client, "booking_items", {
          id: bookingItemId, booking_id: bookingId, product_id: line.product.id,
          qty_ordered: line.qty, created_at: createdAt,
        });
        await insert(client, "order_item_reservations", {
          id: randomUUID(), booking_id: bookingId, booking_item_id: bookingItemId,
          product_id: line.product.id, qty_reserved: line.qty, status: "converted",
          created_by: sale.truck.agent_user_id, updated_by: sale.truck.agent_user_id,
          created_at: createdAt, updated_at: createdAt,
        });
      }
      await insert(client, "order_pallets", {
        id: palletId, order_id: bookingId, truck_id: sale.truck.id, status: "shipped",
        created_at: createdAt, updated_at: createdAt,
      });
      for (const line of invoiceLines) {
        const source = sourceByProduct.get(line.product.id)!;
        if (source.remaining < line.qty) throw new Error(`Historical opening stock is insufficient for ${line.product.name}`);
        source.remaining -= line.qty;
        await insert(client, "order_pallet_items", {
          id: randomUUID(), pallet_id: palletId, product_id: line.product.id, qty_units: line.qty,
          unit_cost: Number(line.product.price).toFixed(2), batch_item_id: source.id,
          created_at: createdAt, updated_at: createdAt,
        });
      }
      await insert(client, "invoices", {
        id: invoiceId, booking_id: bookingId, agent_id: sale.truck.agent_user_id,
        status: dueCents ? "issued" : "paid", payment_status: dueCents ? "partial" : "paid",
        receipt_number: invoiceReceipt(), customer_name: sale.customer.store_name,
        customer_address: sale.customer.location,
        customer_payment_type: paymentMethod,
        discount_rate: discountRate.toFixed(4), gross_amount: money(grossCents),
        discount_amount: money(discountCents), total_amount: money(totalCents),
        credit_applied_amount: "0.00", prepared_by: sale.truck.agent_user_id,
        created_at: createdAt, updated_at: createdAt,
      });
      for (const line of invoiceLines) {
        await insert(client, "invoice_items", {
          id: randomUUID(), invoice_id: invoiceId, product_id: line.product.id,
          product_name: line.product.name, product_sku: line.product.sku,
          qty_ordered: line.qty, unit_price: Number(line.product.price).toFixed(2),
          amount: money(line.amountCents), unit_weight_kg: line.product.weight, unit_label: line.product.unit,
          created_at: createdAt,
        });
      }
      await insert(client, "deliveries", {
        id: deliveryId, truck_id: sale.truck.id, driver_id: sale.truck.driver_id,
        agent_id: sale.truck.agent_profile_id, scheduled_date: deliveryDate,
        scheduled_time: "09:00", status: "completed", created_at: createdAt, updated_at: createdAt,
      });
      await insert(client, "delivery_items", {
        id: deliveryItemId, delivery_id: deliveryId, invoice_id: invoiceId,
        destination_customer_id: sale.customer.id, status: "completed", completed_at: createdAt,
        receipt_number: receipt, is_paid: dueCents === 0, payment_method: paymentMethod,
        payment_reference: `PAY-${randomUUID().slice(0, 12).toUpperCase()}`,
        paid_at: dueCents === 0 ? createdAt : null, created_at: createdAt, updated_at: createdAt,
      });
      const paymentReference = `PAY-${randomUUID().slice(0, 12).toUpperCase()}`;
      await insert(client, "receipts", {
        id: receiptId, receipt_number: receipt, delivery_item_id: deliveryItemId,
        customer_id: sale.customer.id, truck_id: sale.truck.id, invoice_id: invoiceId,
        confirmed_by: sale.truck.agent_user_id,
        notes: sale.payment === "partial" ? "Partial payment received at delivery." : "Payment collected at delivery.",
        payment_reference: paymentReference, cash_collected_amount: money(collectedCents),
        payment_verified_by: null, payment_verified_at: null, confirmed_at: createdAt,
      });
      if (collectedCents > 0) {
        await insert(client, "receipt_payment_entries", {
          id: randomUUID(), receipt_id: receiptId, idempotency_key: randomUUID(),
          amount: money(collectedCents), payment_method: paymentMethod,
          payment_reference: paymentReference, notes: null,
          recorded_by: sale.truck.agent_user_id, verified_by: accountantId,
          verified_at: new Date(createdAt.getTime() + 3 * 60 * 60 * 1000),
          verification_remarks: "Payment reconciled with the delivery receipt.", created_at: createdAt,
        });
      }
      if (dueCents > 0 || overpaidCents > 0) {
        await insert(client, "accounts_receivable", {
          id: randomUUID(), customer_id: sale.customer.id,
          delivery_item_id: dueCents > 0 ? deliveryItemId : null, invoice_id: invoiceId,
          amount_due: dueCents > 0 ? money(dueCents) : money(-overpaidCents),
          credit_type: overpaidCents > 0 ? "overpayment" : null,
          status: "outstanding",
          notes: dueCents > 0 ? "Partial payment recorded at delivery; balance within agreed credit terms." : "Delivery overpayment available as a credit on the next order.",
          created_at: createdAt, updated_at: createdAt,
        });
      }
      await insert(client, "audit_logs", {
        id: randomUUID(), user_id: sale.truck.agent_user_id, action: "create",
        resource_type: "booking", resource_id: bookingId,
        before_state: null, after_state: JSON.stringify({ seeded: true, invoice_id: invoiceId, receipt_number: receipt }),
        created_at: createdAt,
      });
      orderCount++;
    }

    for (const customer of customers) {
      if (customer.credit_limit === "25000.00") {
        await client.query("UPDATE customers SET credit_limit = $1, credit_terms_days = GREATEST(credit_terms_days, 30), updated_at = now() WHERE id = $2 AND credit_limit IS NULL", ["25000.00", customer.id]);
      }
    }
    await insert(client, "audit_logs", {
      id: randomUUID(), user_id: adminId, action: marker, resource_type: "seed",
      resource_id: null, before_state: null,
      after_state: JSON.stringify({ orders: orderCount, from: isoDate(asDate(180)), to: isoDate(now), historical_inventory_batch: batchId }),
      created_at: now,
    });
    await client.query("COMMIT");
    console.log(`Added ${orderCount} connected historical orders, invoices, deliveries, receipts, and payment records in one transaction.`);
    console.log(`Sales span ${isoDate(asDate(180))} through ${isoDate(now)}; existing inventory, products, customers, accounts, and trucks were retained.`);
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

run().catch((error) => {
  console.error("Historical data seed failed:", error);
  process.exitCode = 1;
}).finally(() => pool.end());
