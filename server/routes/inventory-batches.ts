import { sendRouteError } from "../utils";
import type { RequestHandler } from "express";
import { desc, eq } from "drizzle-orm";
import { InventoryBatch, InventoryBatchItem, CreateInventoryBatchSchema, UpdateInventoryBatchSchema } from "../../shared/api";
import { db } from "../db";
import { inventory_batches, batch_pallets, pallet_items } from "../db/schema";
import { getSourceAvailability } from "../services/inventory-reservations";
import type { AuthRequest } from "../middleware/auth";
import { getAgentOrderIds } from "../services/agent-bookings";

const inventoryBatches: InventoryBatch[] = [
  {
    id: "inv-batch-001",
    name: "Morning Delivery",
    status: "closed",
    created_at: new Date("2024-01-15").toISOString(),
    closed_at: new Date("2024-01-15").toISOString(),
    updated_at: new Date("2024-01-15").toISOString(),
    items: [
      {
        id: "inv-item-001",
        batch_id: "inv-batch-001",
        product_id: "prod-1",
        qty_units: 100,
        unit_cost: "50.00",
        created_at: new Date("2024-01-15").toISOString(),
        updated_at: new Date("2024-01-15").toISOString(),
      },
      {
        id: "inv-item-002",
        batch_id: "inv-batch-001",
        product_id: "prod-2",
        qty_units: 50,
        unit_cost: "75.00",
        created_at: new Date("2024-01-15").toISOString(),
        updated_at: new Date("2024-01-15").toISOString(),
      },
    ],
  },
  {
    id: "inv-batch-002",
    name: "Weekly Restock",
    status: "open",
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    items: [
      {
        id: "inv-item-003",
        batch_id: "inv-batch-002",
        product_id: "prod-3",
        qty_units: 200,
        unit_cost: "100.00",
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      },
    ],
  },
];

export const listInventoryBatches: RequestHandler = async (req: AuthRequest, res) => {
  try {
    const orderId = typeof req.query.order_id === "string" ? req.query.order_id : undefined;
    if (orderId && req.user?.role === "agent" && !(await getAgentOrderIds(req.user.userId)).includes(orderId)) {
      return res.status(403).json({ error: "You can only view stock availability for your own or assigned orders." });
    }
    const dbBatches = await db.query.inventory_batches.findMany({
      where: eq(inventory_batches.is_archived, false),
      orderBy: [desc(inventory_batches.created_at)],
      with: {
        pallets: {
          orderBy: (table) => [desc(table.created_at)],
          with: {
            items: {
              orderBy: (table) => [desc(table.created_at)],
            },
          },
        },
      },
    });

    const sourceItems = dbBatches.flatMap((batch) => batch.pallets.flatMap((pallet) => pallet.items));
    const { availableBySource, heldBySource } = await getSourceAvailability(db, sourceItems, orderId);
    const result: InventoryBatch[] = dbBatches.map((batch) => ({
      id: batch.id,
      name: batch.batch_name,
      status: "open",
      created_at: batch.created_at.toISOString(),
      updated_at: batch.updated_at.toISOString(),
      items: batch.pallets.flatMap((pallet) =>
        pallet.items.map((item) => ({
          id: item.id,
          batch_id: batch.id,
          product_id: item.product_id,
          qty_units: item.qty_units,
          available_units: availableBySource.get(item.id) ?? 0,
          held_units: heldBySource.get(item.id) ?? 0,
          unit_cost: "0.00",
          created_at: item.created_at.toISOString(),
          updated_at: item.updated_at.toISOString(),
        }))
      ),
    }));

    res.json(result);
  } catch (error) {
    console.error("Error fetching inventory batches:", error);
    res.status(500).json({ error: "Internal server error" });
  }
};

export const getInventoryBatch: RequestHandler = (req, res) => {
  const { id } = req.params;
  const batch = inventoryBatches.find((b) => b.id === id);
  if (!batch) return res.status(404).json({ error: "Batch not found" });
  res.json(batch);
};

export const createInventoryBatch: RequestHandler = (req, res) => {
  try {
    const { name, items } = CreateInventoryBatchSchema.parse(req.body);
    const batchId = `inv-batch-${Date.now()}`;
    const now = new Date().toISOString();

    const batchItems: InventoryBatchItem[] = items.map((item, idx) => ({
      id: `inv-item-${Date.now()}-${idx}`,
      batch_id: batchId,
      product_id: item.product_id,
      qty_units: item.qty_units,
      unit_cost: "0.00",
      created_at: now,
      updated_at: now,
    }));

    const newBatch: InventoryBatch = {
      id: batchId,
      name,
      status: "open",
      created_at: now,
      updated_at: now,
      items: batchItems,
    };

    inventoryBatches.push(newBatch);
    res.status(201).json(newBatch);
  } catch (error) {
    sendRouteError(res, error, "Inventory batch request failed");
  }
};

export const updateInventoryBatch: RequestHandler = (req, res) => {
  try {
    const { id } = req.params;
    const updates = UpdateInventoryBatchSchema.parse(req.body);

    const batch = inventoryBatches.find((b) => b.id === id);
    if (!batch) return res.status(404).json({ error: "Batch not found" });

    if (updates.name) batch.name = updates.name;
    if (updates.status) {
      batch.status = updates.status;
      if (updates.status === "closed") {
        batch.closed_at = new Date().toISOString();
      }
    }
    batch.updated_at = new Date().toISOString();

    res.json(batch);
  } catch (error) {
    sendRouteError(res, error, "Inventory batch request failed");
  }
};

export const deleteInventoryBatch: RequestHandler = (req, res) => {
  const { id } = req.params;
  const idx = inventoryBatches.findIndex((b) => b.id === id);
  if (idx === -1) return res.status(404).json({ error: "Batch not found" });

  const [deleted] = inventoryBatches.splice(idx, 1);
  res.json({ message: "Batch deleted", batch: deleted });
};

export const addInventoryBatchItem: RequestHandler = (req, res) => {
  try {
    const { id } = req.params;
    const { product_id, qty_units } = req.body;

    const batch = inventoryBatches.find((b) => b.id === id);
    if (!batch) return res.status(404).json({ error: "Batch not found" });
    if (batch.status === "closed") return res.status(400).json({ error: "Cannot add items to closed batch" });

    if (!batch.items) batch.items = [];

    const newItem: InventoryBatchItem = {
      id: `inv-item-${Date.now()}`,
      batch_id: id,
      product_id,
      qty_units,
      unit_cost: "0.00",
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };

    batch.items.push(newItem);
    batch.updated_at = new Date().toISOString();

    res.status(201).json(newItem);
  } catch (error) {
    sendRouteError(res, error, "Inventory batch request failed");
  }
};

export const removeInventoryBatchItem: RequestHandler = (req, res) => {
  const { id, itemId } = req.params;
  const batch = inventoryBatches.find((b) => b.id === id);
  if (!batch) return res.status(404).json({ error: "Batch not found" });
  if (batch.status === "closed") return res.status(400).json({ error: "Cannot modify closed batch" });

  const itemIdx = batch.items?.findIndex((i) => i.id === itemId) ?? -1;
  if (itemIdx === -1) return res.status(404).json({ error: "Item not found" });

  const [deleted] = batch.items!.splice(itemIdx, 1);
  batch.updated_at = new Date().toISOString();

  res.json({ message: "Item removed", item: deleted });
};
