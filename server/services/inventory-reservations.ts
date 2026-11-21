import { randomUUID } from "node:crypto";
import { and, eq, gte, inArray, isNull, ne, or, sql } from "drizzle-orm";
import { applyReservationsToSourceItems } from "./reservation-allocation";
import { todayInManila } from "../../shared/api";
import {
  batch_pallets,
  booking_items,
  bookings,
  inventory_batches,
  order_item_reservations,
  order_pallet_items,
  order_pallets,
  pallet_items,
} from "../db/schema";

export async function getReservedUnitsByProduct(executor: any, productIds?: string[], excludeBookingId?: string): Promise<Map<string, number>> {
  if (productIds?.length === 0) return new Map<string, number>();

  const rows = await executor
    .select({
      productId: order_item_reservations.product_id,
      quantity: sql<number>`sum(${order_item_reservations.qty_reserved})::int`,
    })
    .from(order_item_reservations)
    .where(and(
      eq(order_item_reservations.status, "reserved"),
      productIds ? inArray(order_item_reservations.product_id, productIds) : undefined,
      excludeBookingId ? ne(order_item_reservations.booking_id, excludeBookingId) : undefined,
    ))
    .groupBy(order_item_reservations.product_id);

  return new Map(rows.map((row: { productId: string; quantity: number }) => [row.productId, row.quantity]));
}

function notExpiredPalletItem() {
  return or(isNull(pallet_items.expiration_date), gte(pallet_items.expiration_date, todayInManila()));
}

export async function getStockUnitsByProduct(executor: any, productIds?: string[]): Promise<Map<string, number>> {
  if (productIds?.length === 0) return new Map<string, number>();

  const rows = await executor
    .select({
      productId: pallet_items.product_id,
      quantity: sql<number>`sum(${pallet_items.qty_units})::int`,
    })
    .from(pallet_items)
    .innerJoin(batch_pallets, eq(pallet_items.pallet_id, batch_pallets.id))
    .innerJoin(inventory_batches, eq(batch_pallets.batch_id, inventory_batches.id))
    .where(and(
      eq(inventory_batches.is_archived, false),
      notExpiredPalletItem(),
      productIds ? inArray(pallet_items.product_id, productIds) : undefined,
    ))
    .groupBy(pallet_items.product_id);

  return new Map(rows.map((row: { productId: string; quantity: number }) => [row.productId, row.quantity]));
}

export async function getAvailableUnitsByProduct(executor: any, productIds?: string[], excludeBookingId?: string): Promise<Map<string, number>> {
  if (productIds?.length === 0) return new Map<string, number>();

  const [stockByProduct, reservedByProduct, palletRows] = await Promise.all([
    getStockUnitsByProduct(executor, productIds),
    getReservedUnitsByProduct(executor, productIds, excludeBookingId),
    executor
      .select({
        productId: order_pallet_items.product_id,
        quantity: sql<number>`sum(${order_pallet_items.qty_units})::int`,
      })
      .from(order_pallet_items)
      .innerJoin(order_pallets, eq(order_pallet_items.pallet_id, order_pallets.id))
      .where(and(
        ne(order_pallets.status, "shipped"),
        productIds ? inArray(order_pallet_items.product_id, productIds) : undefined,
      ))
      .groupBy(order_pallet_items.product_id),
  ]);
  const palletReservedByProduct = new Map<string, number>(palletRows.map((row: { productId: string; quantity: number }) => [row.productId, row.quantity]));
  const available = new Map<string, number>();

  for (const productId of productIds ?? stockByProduct.keys()) {
    available.set(productId, Math.max(0,
      (stockByProduct.get(productId) ?? 0) -
      (reservedByProduct.get(productId) ?? 0) -
      (palletReservedByProduct.get(productId) ?? 0),
    ));
  }

  return available;
}

export async function lockStockForProducts(executor: any, productIds: string[]) {
  if (productIds.length === 0) return;
  await executor
    .select({ id: pallet_items.id })
    .from(pallet_items)
    .innerJoin(batch_pallets, eq(pallet_items.pallet_id, batch_pallets.id))
    .innerJoin(inventory_batches, eq(batch_pallets.batch_id, inventory_batches.id))
    .where(and(
      eq(inventory_batches.is_archived, false),
      inArray(pallet_items.product_id, productIds),
    ))
    .orderBy(pallet_items.id)
    .for("update");
}

export async function getAvailableUnitsBySource(
  executor: any,
  stockItems: Array<{ id: string; product_id: string; qty_units: number; created_at: Date | string; expiration_date?: string | null }>,
  excludeBookingId?: string,
) {
  if (stockItems.length === 0) return new Map<string, number>();
  const sourceIds = stockItems.map((item) => item.id);
  const productIds = [...new Set(stockItems.map((item) => item.product_id))];
  const [palletRows, reservedByProduct] = await Promise.all([
    executor
      .select({
        sourceItemId: order_pallet_items.batch_item_id,
        quantity: sql<number>`sum(${order_pallet_items.qty_units})::int`,
      })
      .from(order_pallet_items)
      .innerJoin(order_pallets, eq(order_pallet_items.pallet_id, order_pallets.id))
      .where(and(
        ne(order_pallets.status, "shipped"),
        inArray(order_pallet_items.batch_item_id, sourceIds),
      ))
      .groupBy(order_pallet_items.batch_item_id),
    getReservedUnitsByProduct(executor, productIds, excludeBookingId),
  ]);

  const availableBySource = applyReservationsToSourceItems(
    stockItems,
    new Map<string, number>(palletRows.map((row: { sourceItemId: string; quantity: number }) => [row.sourceItemId, row.quantity])),
    reservedByProduct,
  );
  const today = todayInManila();
  for (const item of stockItems) {
    if (item.expiration_date && item.expiration_date < today) availableBySource.set(item.id, 0);
  }
  return availableBySource;
}

export async function getAvailableUnitsBySourceForProducts(
  executor: any,
  productIds: string[],
  excludeBookingId?: string,
) {
  if (productIds.length === 0) return new Map<string, number>();
  const stockItems = await executor
    .select({ id: pallet_items.id, product_id: pallet_items.product_id, qty_units: pallet_items.qty_units, created_at: pallet_items.created_at, expiration_date: pallet_items.expiration_date })
    .from(pallet_items)
    .innerJoin(batch_pallets, eq(pallet_items.pallet_id, batch_pallets.id))
    .innerJoin(inventory_batches, eq(batch_pallets.batch_id, inventory_batches.id))
    .where(and(eq(inventory_batches.is_archived, false), notExpiredPalletItem(), inArray(pallet_items.product_id, productIds)));
  return getAvailableUnitsBySource(executor, stockItems, excludeBookingId);
}

export async function reserveBookingItemsTx(
  executor: any,
  bookingId: string,
  items: Array<{ id: string; product_id: string; qty_ordered: number }>,
  actorId: string,
  replacedStatus: "released" | "superseded" = "released",
) {
  const quantitiesByProduct = new Map<string, number>();
  for (const item of items) {
    quantitiesByProduct.set(item.product_id, (quantitiesByProduct.get(item.product_id) ?? 0) + item.qty_ordered);
  }
  const productIds = [...quantitiesByProduct.keys()].sort();
  await lockStockForProducts(executor, productIds);
  const availableByProduct = await getAvailableUnitsByProduct(executor, productIds, bookingId);

  for (const [productId, quantity] of quantitiesByProduct) {
    const available = availableByProduct.get(productId) ?? 0;
    if (quantity > available) {
      return { status: "insufficient_stock" as const, productId, available };
    }
  }

  await executor
    .update(order_item_reservations)
    .set({ status: replacedStatus, updated_by: actorId, updated_at: new Date() })
    .where(and(
      eq(order_item_reservations.booking_id, bookingId),
      eq(order_item_reservations.status, "reserved"),
    ));

  if (items.length > 0) {
    await executor.insert(order_item_reservations).values(items.map((item) => ({
      id: randomUUID(),
      booking_id: bookingId,
      booking_item_id: item.id,
      product_id: item.product_id,
      qty_reserved: item.qty_ordered,
      status: "reserved",
      created_by: actorId,
      updated_by: actorId,
    })));
  }

  return { status: "reserved" as const };
}

export async function releaseBookingReservationsTx(executor: any, bookingId: string, actorId: string) {
  await executor
    .update(order_item_reservations)
    .set({ status: "released", updated_by: actorId, updated_at: new Date() })
    .where(and(
      eq(order_item_reservations.booking_id, bookingId),
      eq(order_item_reservations.status, "reserved"),
    ));
}

export async function convertBookingReservationsTx(executor: any, bookingId: string, actorId: string) {
  await executor
    .update(order_item_reservations)
    .set({ status: "converted", updated_by: actorId, updated_at: new Date() })
    .where(and(
      eq(order_item_reservations.booking_id, bookingId),
      eq(order_item_reservations.status, "reserved"),
    ));
}
