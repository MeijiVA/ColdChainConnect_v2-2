import { randomUUID } from "crypto";
import { Pool } from "pg";

// Adds new restock batches so SOME products rise above their reorder point (the rest stay low on purpose,
// so the dashboard / reorder alerts still have something to show).
//
// Batch names, pallet ids, supplier, zone and placement are copied from the most recent REAL batch in the
// database (anything not named "HISTORICAL OPENING STOCK ..."): a date in the name is replaced with the new
// batch's date, otherwise a trailing number is incremented. Override the sample with BATCH_NAME_SAMPLE.
//
// Safe by default: runs in a transaction and ROLLS BACK, printing the plan. Add APPLY=1 to commit.
//
//   pnpm tsx server/seed-restock-batches.ts                 # preview only
//   APPLY=1 pnpm tsx server/seed-restock-batches.ts         # write it
//   APPLY=1 FIX_HISTORICAL_STOCK=1 pnpm tsx server/seed-restock-batches.ts
//
// FIX_HISTORICAL_STOCK=1 (opt-in, runs once): seed-historical-data.ts marks its pallets as shipped but never
// lowers pallet_items.qty_units, which is what the app does on shipping. That overstates stock by every unit
// sold. This subtracts the shipped quantities from the historical opening-stock rows only.
//
// "Available" below mirrors server/services/inventory-reservations.ts:
//   non-expired stock in non-archived batches - active reservations - units on non-shipped order pallets.

const MARKER = "seed_restock_batches_v1";
const FIX_MARKER = "seed_historical_stock_fix_v1";
const APPLY = process.env.APPLY === "1";
const FIX_HISTORICAL_STOCK = process.env.FIX_HISTORICAL_STOCK === "1";
const HISTORICAL_LIKE = "HISTORICAL OPENING STOCK%";
const MANILA_OFFSET_MS = 8 * 60 * 60 * 1000;
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const TARGET_MULTIPLIERS = [1.5, 1.8, 2.2];
const BATCH_DAYS_AGO = [5, 2];

const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 1, connectionTimeoutMillis: 10000 });

const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const manilaToday = () => new Date(Date.now() + MANILA_OFFSET_MS).toISOString().slice(0, 10);
function shiftDays(iso: string, days: number) {
  const date = new Date(`${iso}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

// Name like the sample: new date if the sample has one, else the next number after the highest used.
function nameLike(sample: string, iso: string, existing: string[]): string {
  if (/\d{4}-\d{2}-\d{2}/.test(sample)) return sample.replace(/\d{4}-\d{2}-\d{2}/, iso);
  if (/20\d{6}/.test(sample)) return sample.replace(/20\d{6}/, iso.replace(/-/g, ""));
  const long = /([A-Z][a-z]{2,8})\.? (\d{1,2}), (\d{4})/.exec(sample);
  if (long) {
    const [year, month, day] = iso.split("-").map(Number);
    const full = MONTHS[month - 1];
    return sample.replace(long[0], `${long[1].length <= 3 ? full.slice(0, 3) : full} ${day}, ${year}`);
  }
  const next = nextNumbered(sample, existing);
  return next ?? `${sample} ${iso}`;
}

function nextNumbered(sample: string, existing: string[]): string | null {
  const match = /^(.*?)(\d+)(\D*)$/.exec(sample);
  if (!match) return null;
  const [, prefix, digits, suffix] = match;
  const pattern = new RegExp(`^${escapeRegExp(prefix)}(\\d+)${escapeRegExp(suffix)}$`);
  const used = existing.map((name) => Number(pattern.exec(name)?.[1] ?? 0));
  const next = Math.max(Number(digits), ...used) + 1;
  return `${prefix}${String(next).padStart(digits.length, "0")}${suffix}`;
}

type Product = { id: string; name: string; sku: string | null; reorder_point: number };

async function availableByProduct(client: import("pg").PoolClient, today: string) {
  const [stock, reserved, onPallets] = await Promise.all([
    client.query(
      `SELECT pi.product_id, SUM(pi.qty_units)::int AS qty
         FROM pallet_items pi
         JOIN batch_pallets bp ON bp.id = pi.pallet_id
         JOIN inventory_batches b ON b.id = bp.batch_id
        WHERE b.is_archived = false AND (pi.expiration_date IS NULL OR pi.expiration_date >= $1::date)
        GROUP BY pi.product_id`,
      [today],
    ),
    client.query("SELECT product_id, SUM(qty_reserved)::int AS qty FROM order_item_reservations WHERE status = 'reserved' GROUP BY product_id"),
    client.query(
      `SELECT opi.product_id, SUM(opi.qty_units)::int AS qty
         FROM order_pallet_items opi JOIN order_pallets op ON op.id = opi.pallet_id
        WHERE op.status <> 'shipped' GROUP BY opi.product_id`,
    ),
  ]);
  const toMap = (rows: { product_id: string; qty: number }[]) => new Map(rows.map((row) => [row.product_id, row.qty]));
  const stockMap = toMap(stock.rows);
  const reservedMap = toMap(reserved.rows);
  const palletMap = toMap(onPallets.rows);
  return (productId: string) => Math.max(0, (stockMap.get(productId) ?? 0) - (reservedMap.get(productId) ?? 0) - (palletMap.get(productId) ?? 0));
}

async function run() {
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required");
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [MARKER]);
    const prior = await client.query("SELECT id FROM audit_logs WHERE action = $1 AND resource_type = 'seed' LIMIT 1", [MARKER]);
    if (prior.rowCount) {
      await client.query("ROLLBACK");
      console.log("Restock batches were already added by this script; no changes made.");
      return;
    }

    const adminRows = await client.query("SELECT id FROM users WHERE role = 'admin' ORDER BY created_at LIMIT 1");
    const adminId = adminRows.rows[0]?.id as string | undefined;
    if (!adminId) throw new Error("The database needs an existing admin user.");
    const today = manilaToday();

    // Optional: undo the historical seed's overstated stock (once).
    if (FIX_HISTORICAL_STOCK) {
      const fixed = await client.query("SELECT id FROM audit_logs WHERE action = $1 AND resource_type = 'seed' LIMIT 1", [FIX_MARKER]);
      if (fixed.rowCount) {
        console.log("Historical stock correction was already applied earlier; skipping it.");
      } else {
        const result = await client.query(
          `UPDATE pallet_items pi
              SET qty_units = GREATEST(0, pi.qty_units - s.qty), updated_at = now()
             FROM (SELECT opi.batch_item_id, SUM(opi.qty_units)::int AS qty
                     FROM order_pallet_items opi JOIN order_pallets op ON op.id = opi.pallet_id
                    WHERE op.status = 'shipped' GROUP BY opi.batch_item_id) s
            WHERE s.batch_item_id = pi.id
              AND pi.pallet_id IN (SELECT bp.id FROM batch_pallets bp JOIN inventory_batches b ON b.id = bp.batch_id WHERE b.batch_name LIKE $1)`,
          [HISTORICAL_LIKE],
        );
        await client.query(
          `INSERT INTO audit_logs (id, user_id, action, resource_type, resource_id, before_state, after_state, created_at)
           VALUES ($1, $2, $3, 'seed', NULL, NULL, $4, now())`,
          [randomUUID(), adminId, FIX_MARKER, JSON.stringify({ rows_corrected: result.rowCount })],
        );
        console.log(`Corrected ${result.rowCount} historical opening-stock rows (shipped units subtracted).`);
      }
    }

    // Copy the format of the most recent real batch.
    const realBatches = await client.query(
      "SELECT id, batch_name FROM inventory_batches WHERE is_archived = false AND batch_name NOT LIKE $1 ORDER BY created_at DESC",
      [HISTORICAL_LIKE],
    );
    const sample = process.env.BATCH_NAME_SAMPLE ?? (realBatches.rows[0]?.batch_name as string | undefined);
    if (!sample) throw new Error("No existing (non-historical) batch to copy the name format from. Set BATCH_NAME_SAMPLE.");
    console.log(`Copying batch name format from: "${sample}"`);
    if (realBatches.rows.length) console.log(`Recent batch names: ${realBatches.rows.slice(0, 5).map((row) => `"${row.batch_name}"`).join(", ")}`);

    const allNames = (await client.query("SELECT batch_name FROM inventory_batches")).rows.map((row) => row.batch_name as string);
    const palletTemplate = (await client.query(
      `SELECT bp.pallet_id, bp.supplier_name, bp.storage_zone, bp.placement_location
         FROM batch_pallets bp JOIN inventory_batches b ON b.id = bp.batch_id
        WHERE b.batch_name NOT LIKE $1 ORDER BY bp.created_at DESC LIMIT 1`,
      [HISTORICAL_LIKE],
    )).rows[0] as { pallet_id: string; supplier_name: string | null; storage_zone: string | null; placement_location: string | null } | undefined;
    const supplier = palletTemplate?.supplier_name ?? "Pampanga Cold Storage Supply";
    const zone = palletTemplate?.storage_zone ?? "Cold Storage A";
    const placement = palletTemplate?.placement_location ?? "Receiving Bay 1";
    const allPalletIds = (await client.query("SELECT pallet_id FROM batch_pallets")).rows.map((row) => row.pallet_id as string);

    const productRows = await client.query(
      `SELECT id, name, sku, reorder_point FROM products
        WHERE is_archived = false AND COALESCE(is_discontinued, false) = false AND reorder_point IS NOT NULL
        ORDER BY name`,
    );
    const products = productRows.rows as Product[];
    if (!products.length) throw new Error("No active products with a reorder point.");

    const availableBefore = await availableByProduct(client, today);

    // Every other product (by name) gets topped up to 1.5x / 1.8x / 2.2x its reorder point; the rest stay as-is.
    const plan: Array<{ product: Product; before: number; add: number }> = [];
    products.forEach((product, index) => {
      if (index % 2 !== 0) return;
      const multiplier = TARGET_MULTIPLIERS[(index / 2) % TARGET_MULTIPLIERS.length];
      const target = Math.ceil((product.reorder_point * multiplier) / 10) * 10;
      const before = availableBefore(product.id);
      if (before > product.reorder_point) return;
      plan.push({ product, before, add: Math.ceil((target - before) / 10) * 10 });
    });
    if (!plan.length) {
      await client.query("ROLLBACK");
      console.log("Nothing to do: the products picked for restocking are already above their reorder point.");
      return;
    }

    const batches = BATCH_DAYS_AGO.map((daysAgo) => ({ date: shiftDays(today, -daysAgo), lines: [] as typeof plan }));
    plan.forEach((line, index) => batches[index % batches.length].lines.push(line));

    let palletSeq = allPalletIds.slice();
    let nameSeq = allNames.slice();
    let batchCount = 0;
    for (const batch of batches.filter((entry) => entry.lines.length)) {
      const batchId = randomUUID();
      const name = nameLike(sample, batch.date, nameSeq);
      nameSeq.push(name);
      const createdAt = `${batch.date}T01:00:00.000Z`;
      await client.query(
        "INSERT INTO inventory_batches (id, batch_name, is_archived, created_at, updated_at) VALUES ($1, $2, false, $3::timestamp, $3::timestamp)",
        [batchId, name, createdAt],
      );
      console.log(`\nBatch "${name}" (${batch.date})`);
      for (const [lineIndex, line] of batch.lines.entries()) {
        const palletRowId = randomUUID();
        const palletSample = palletTemplate?.pallet_id ?? `PLT-${String(1).padStart(3, "0")}`;
        const palletId = nextNumbered(palletSample, palletSeq) ?? `${palletSample}-${line.product.sku ?? line.product.id.slice(0, 8)}`;
        palletSeq.push(palletId);
        await client.query(
          `INSERT INTO batch_pallets (id, batch_id, pallet_id, supplier_name, received_date, storage_zone, placement_location, created_at, updated_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8::timestamp, $8::timestamp)`,
          [palletRowId, batchId, palletId, supplier, batch.date, zone, placement, createdAt],
        );
        await client.query(
          `INSERT INTO pallet_items (id, pallet_id, product_id, qty_units, expiration_date, created_at, updated_at)
           VALUES ($1, $2, $3, $4, $5::date, $6::timestamp, $6::timestamp)`,
          [randomUUID(), palletRowId, line.product.id, line.add, shiftDays(today, 300 + lineIndex * 15), createdAt],
        );
        console.log(`  ${palletId}  ${line.product.name}: ${line.before} -> ${line.before + line.add} (reorder point ${line.product.reorder_point}, +${line.add})`);
      }
      batchCount++;
    }

    await client.query(
      `INSERT INTO audit_logs (id, user_id, action, resource_type, resource_id, before_state, after_state, created_at)
       VALUES ($1, $2, $3, 'seed', NULL, NULL, $4, now())`,
      [randomUUID(), adminId, MARKER, JSON.stringify({ batches: batchCount, products_restocked: plan.length })],
    );

    const availableAfter = await availableByProduct(client, today);
    const stillLow = products.filter((product) => availableAfter(product.id) <= product.reorder_point);
    console.log(`\nAfter restock: ${products.length - stillLow.length} of ${products.length} products are above their reorder point; ${stillLow.length} remain low.`);

    if (APPLY) {
      await client.query("COMMIT");
      console.log("Committed.");
    } else {
      await client.query("ROLLBACK");
      console.log("PREVIEW ONLY: nothing was written. Re-run with APPLY=1 to save these batches.");
    }
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

run().catch((error) => {
  console.error("Restock batch seed failed:", error);
  process.exitCode = 1;
}).finally(() => pool.end());
