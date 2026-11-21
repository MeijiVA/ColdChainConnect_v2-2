import {
  pgTable,
  text,
  integer,
  boolean,
  timestamp,
  decimal,
  doublePrecision,
  varchar,
  pgEnum,
  foreignKey,
  primaryKey,
  date,
  jsonb,
  check,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { relations, sql } from "drizzle-orm";

// Enums
export const userRoleEnum = pgEnum("user_role", ["admin", "agent", "driver", "staff"]);
export const bookingStatusEnum = pgEnum("booking_status", [
  "pending",
  "approved",
  "rejected",
  "prep",
  "ready",
]);
export const invoiceStatusEnum = pgEnum("invoice_status", [
  "draft",
  "issued",
  "paid",
]);
export const deliveryStatusEnum = pgEnum("delivery_status", [
  "pending",
  "in_transit",
  "completed",
]);
export const truckStatusEnum = pgEnum("truck_status", [
  "available",
  "in_transit",
  "maintenance",
]);

// Users table
export const users = pgTable("users", {
  id: text("id").primaryKey(),
  username: text("username").notNull().unique(),
  password_hash: text("password_hash").notNull(),
  mfa_secret: text("mfa_secret"),
  mfa_enabled: boolean("mfa_enabled").default(false).notNull(),
  mfa_required: boolean("mfa_required").default(true).notNull(),
  role: userRoleEnum("role").default("agent").notNull(),
  module_permissions: jsonb("module_permissions").$type<string[]>().default([]).notNull(),
  is_archived: boolean("is_archived").default(false).notNull(),
  created_at: timestamp("created_at").defaultNow().notNull(),
  updated_at: timestamp("updated_at").defaultNow().notNull(),
});

// Customers table
export const customers = pgTable("customers", {
  id: text("id").primaryKey(),
  store_name: text("store_name").notNull(),
  location: text("location").notNull(),
  district: text("district"),
  street_number: text("street_number"),
  street_address: text("street_address"),
  state: text("state"),
  postal_code: text("postal_code"),
  latitude: doublePrecision("latitude"),
  longitude: doublePrecision("longitude"),
  contact_person: text("contact_person"),
  contact_info: text("contact_info"),
  agent_id: text("agent_id").references(() => users.id),
  payment_type: text("payment_type"),
  credit_limit: decimal("credit_limit", { precision: 12, scale: 2 }),
  credit_terms_days: integer("credit_terms_days").default(30).notNull(),
  created_at: timestamp("created_at").defaultNow().notNull(),
  updated_at: timestamp("updated_at").defaultNow().notNull(),
}, (table) => [
  index("customers_agent_id_idx").on(table.agent_id),
]);

// Customer discounts table
export const customer_discounts = pgTable("customer_discounts", {
  id: text("id").primaryKey(),
  customer_id: text("customer_id")
    .notNull()
    .references(() => customers.id, { onDelete: "cascade" }),
  label: text("label").notNull(),
  rate: decimal("rate", { precision: 5, scale: 4 }).notNull(),
  created_at: timestamp("created_at").defaultNow().notNull(),
}, (table) => [
  index("customer_discounts_customer_id_idx").on(table.customer_id),
]);

// Products table
export const products = pgTable("products", {
  id: text("id").primaryKey(),
  name: text("name").notNull().unique(),
  sku: text("sku").unique(),
  price: decimal("price", { precision: 10, scale: 2 }).notNull(),
  image_filename: text("image_filename"),
  batch_tracking_enabled: boolean("batch_tracking_enabled").default(true),
  manufacturer: text("manufacturer"),
  reorder_point: integer("reorder_point"),
  weight: decimal("weight", { precision: 10, scale: 2 }),
  unit: varchar("unit", { length: 10 }).default("PK").notNull(),
  srp: decimal("srp", { precision: 10, scale: 2 }),
  is_discontinued: boolean("is_discontinued").default(false),
  is_archived: boolean("is_archived").default(false).notNull(),
  created_at: timestamp("created_at").defaultNow().notNull(),
  updated_at: timestamp("updated_at").defaultNow().notNull(),
});

// What a product costs us. Separate from products on purpose: product rows are embedded in bookings
// and lists that agents can read, and cost must never travel with them.
export const product_costs = pgTable("product_costs", {
  product_id: text("product_id")
    .primaryKey()
    .references(() => products.id, { onDelete: "cascade" }),
  cost_price: decimal("cost_price", { precision: 10, scale: 2 }).notNull(),
  updated_at: timestamp("updated_at").defaultNow().notNull(),
}, (table) => [
  check("product_costs_cost_price_nonnegative", sql`${table.cost_price} >= 0`),
]);

// End-of-day cash hand-over: a collector gives the day's cash to the office, which counts it by
// denomination and confirms. One per collector per day; expected is computed on the server.
export const cash_remittances = pgTable("cash_remittances", {
  id: text("id").primaryKey(),
  remitted_by: text("remitted_by").notNull().references(() => users.id),
  received_by: text("received_by").notNull().references(() => users.id),
  business_date: text("business_date").notNull(),
  expected_amount: decimal("expected_amount", { precision: 12, scale: 2 }).notNull(),
  counted_amount: decimal("counted_amount", { precision: 12, scale: 2 }).notNull(),
  denominations: jsonb("denominations").$type<Record<string, number>>().notNull(),
  notes: text("notes"),
  created_at: timestamp("created_at").defaultNow().notNull(),
}, (table) => [
  uniqueIndex("cash_remittances_remitter_day_idx").on(table.remitted_by, table.business_date),
  index("cash_remittances_business_date_idx").on(table.business_date),
  check("cash_remittances_amounts_nonnegative", sql`${table.expected_amount} >= 0 AND ${table.counted_amount} >= 0`),
]);

// Inventory batches table
export const inventory_batches = pgTable("inventory_batches", {
  id: text("id").primaryKey(),
  batch_name: text("batch_name").notNull(),
  is_archived: boolean("is_archived").default(false).notNull(),
  created_at: timestamp("created_at").defaultNow().notNull(),
  updated_at: timestamp("updated_at").defaultNow().notNull(),
});

// Batch pallets table
export const batch_pallets = pgTable("batch_pallets", {
  id: text("id").primaryKey(),
  batch_id: text("batch_id")
    .notNull()
    .references(() => inventory_batches.id, { onDelete: "cascade" }),
  pallet_id: text("pallet_id").notNull(),
  supplier_name: text("supplier_name"),
  received_date: text("received_date"),
  storage_zone: text("storage_zone"),
  placement_location: text("placement_location"),
  created_at: timestamp("created_at").defaultNow().notNull(),
  updated_at: timestamp("updated_at").defaultNow().notNull(),
}, (table) => [
  index("batch_pallets_batch_id_idx").on(table.batch_id),
]);

// Pallet items table
export const pallet_items = pgTable("pallet_items", {
  id: text("id").primaryKey(),
  pallet_id: text("pallet_id")
    .notNull()
    .references(() => batch_pallets.id, { onDelete: "cascade" }),
  product_id: text("product_id")
    .notNull()
    .references(() => products.id),
  qty_units: integer("qty_units").notNull(),
  expiration_date: date("expiration_date", { mode: "string" }),
  created_at: timestamp("created_at").defaultNow().notNull(),
  updated_at: timestamp("updated_at").defaultNow().notNull(),
}, (table) => [
  index("pallet_items_pallet_id_idx").on(table.pallet_id),
  index("pallet_items_product_id_idx").on(table.product_id),
]);

// Agents table — account-linked staff with login credentials
export const agents = pgTable("agents", {
  id: text("id").primaryKey(),
  user_id: text("user_id")
    .notNull()
    .references(() => users.id),
  full_name: text("full_name"),
  email: text("email"),
  contact_info: text("contact_info"),
  emergency_contact: text("emergency_contact"),
  hire_date: text("hire_date"),
  address: text("address"),
  is_active: boolean("is_active").default(true),
  is_archived: boolean("is_archived").default(false).notNull(),
  created_at: timestamp("created_at").defaultNow().notNull(),
  updated_at: timestamp("updated_at").defaultNow().notNull(),
}, (table) => [
  index("agents_user_id_idx").on(table.user_id),
]);

// Drivers table — field staff; optional login account via user_id
export const drivers = pgTable("drivers", {
  id: text("id").primaryKey(),
  user_id: text("user_id").references(() => users.id),
  full_name: text("full_name"),
  contact_info: text("contact_info"),
  license: text("license"),
  hire_date: text("hire_date"),
  employment_type: text("employment_type"), // "full_time" or "part_time"
  is_active: boolean("is_active").default(true),
  is_archived: boolean("is_archived").default(false).notNull(),
  created_at: timestamp("created_at").defaultNow().notNull(),
  updated_at: timestamp("updated_at").defaultNow().notNull(),
}, (table) => [
  index("drivers_user_id_idx").on(table.user_id),
]);

// Trucks table
export const trucks = pgTable("trucks", {
  id: text("id").primaryKey(),
  license_plate: text("license_plate").notNull().unique(),
  district: text("district").notNull(),
  driver_id: text("driver_id").references(() => drivers.id),
  agent_id: text("agent_id").references(() => agents.id, { onDelete: "set null" }),
  status: truckStatusEnum("status").default("available"),
  created_at: timestamp("created_at").defaultNow().notNull(),
  updated_at: timestamp("updated_at").defaultNow().notNull(),
}, (table) => [
  index("trucks_driver_id_idx").on(table.driver_id),
  index("trucks_agent_id_idx").on(table.agent_id),
]);

// Bookings table
export const bookings = pgTable("bookings", {
  id: text("id").primaryKey(),
  customer_id: text("customer_id")
    .notNull()
    .references(() => customers.id),
  created_by: text("created_by")
    .notNull()
    .references(() => users.id),
  status: bookingStatusEnum("status").default("pending").notNull(),
  prepared_delivery_date: text("prepared_delivery_date"),
  approved_by: text("approved_by").references(() => users.id),
  approved_at: timestamp("approved_at"),
  created_at: timestamp("created_at").defaultNow().notNull(),
}, (table) => [
  index("bookings_created_by_idx").on(table.created_by),
  index("bookings_customer_id_idx").on(table.customer_id),
  index("bookings_status_idx").on(table.status),
  index("bookings_created_at_idx").on(table.created_at),
]);

// Booking items table
export const booking_items = pgTable("booking_items", {
  id: text("id").primaryKey(),
  booking_id: text("booking_id")
    .notNull()
    .references(() => bookings.id, { onDelete: "cascade" }),
  product_id: text("product_id")
    .notNull()
    .references(() => products.id),
  qty_ordered: integer("qty_ordered").notNull(),
  created_at: timestamp("created_at").defaultNow().notNull(),
}, (table) => [
  index("booking_items_booking_id_idx").on(table.booking_id),
  index("booking_items_product_id_idx").on(table.product_id),
]);

export const order_item_reservations = pgTable("order_item_reservations", {
  id: text("id").primaryKey(),
  booking_id: text("booking_id")
    .notNull()
    .references(() => bookings.id, { onDelete: "cascade" }),
  booking_item_id: text("booking_item_id")
    .notNull()
    .references(() => booking_items.id, { onDelete: "cascade" }),
  product_id: text("product_id")
    .notNull()
    .references(() => products.id),
  qty_reserved: integer("qty_reserved").notNull(),
  status: varchar("status", { length: 20 }).default("reserved").notNull(),
  created_by: text("created_by").notNull().references(() => users.id),
  updated_by: text("updated_by").notNull().references(() => users.id),
  created_at: timestamp("created_at").defaultNow().notNull(),
  updated_at: timestamp("updated_at").defaultNow().notNull(),
}, (table) => [
  index("order_item_reservations_booking_id_idx").on(table.booking_id),
  index("order_item_reservations_product_status_idx").on(table.product_id, table.status),
  uniqueIndex("order_item_reservations_active_booking_item_idx").on(table.booking_item_id).where(sql`${table.status} = 'reserved'`),
  check("order_item_reservations_qty_positive", sql`${table.qty_reserved} > 0`),
  check("order_item_reservations_status_check", sql`${table.status} IN ('reserved', 'released', 'converted', 'superseded')`),
]);

// Order pallets table (pallets created for order fulfillment)
export const order_pallets = pgTable("order_pallets", {
  id: text("id").primaryKey(),
  order_id: text("order_id")
    .notNull()
    .references(() => bookings.id, { onDelete: "cascade" }),
  truck_id: text("truck_id").references(() => trucks.id),
  status: varchar("status", { length: 20 }).default("draft").notNull(), // draft, prepared, approved, shipped
  created_at: timestamp("created_at").defaultNow().notNull(),
  updated_at: timestamp("updated_at").defaultNow().notNull(),
}, (table) => [
  index("order_pallets_order_id_idx").on(table.order_id),
  index("order_pallets_truck_id_idx").on(table.truck_id),
]);

// Order pallet items table
export const order_pallet_items = pgTable("order_pallet_items", {
  id: text("id").primaryKey(),
  pallet_id: text("pallet_id")
    .notNull()
    .references(() => order_pallets.id, { onDelete: "cascade" }),
  product_id: text("product_id")
    .notNull()
    .references(() => products.id),
  qty_units: integer("qty_units").notNull(),
  unit_cost: varchar("unit_cost", { length: 20 }).default("0.00"),
  batch_item_id: text("batch_item_id").notNull(),
  created_at: timestamp("created_at").defaultNow().notNull(),
  updated_at: timestamp("updated_at").defaultNow().notNull(),
}, (table) => [
  index("order_pallet_items_pallet_id_idx").on(table.pallet_id),
  index("order_pallet_items_product_id_idx").on(table.product_id),
]);

// Invoices table
export const invoices = pgTable("invoices", {
  id: text("id").primaryKey(),
  booking_id: text("booking_id")
    .notNull()
    .references(() => bookings.id),
  agent_id: text("agent_id")
    .notNull()
    .references(() => users.id),
  status: invoiceStatusEnum("status").default("draft").notNull(),
  payment_status: varchar("payment_status", { length: 20 })
    .default("unpaid")
    .notNull(),
  // Snapshot fields — frozen at invoice creation time
  receipt_number: text("receipt_number"),
  customer_name: text("customer_name"),
  customer_address: text("customer_address"),
  customer_payment_type: text("customer_payment_type"),
  discount_rate: decimal("discount_rate", { precision: 5, scale: 4 }).default("0.02"),
  gross_amount: decimal("gross_amount", { precision: 12, scale: 2 }).default("0.00"),
  discount_amount: decimal("discount_amount", { precision: 12, scale: 2 }).default("0.00"),
  total_amount: decimal("total_amount", { precision: 12, scale: 2 }).default("0.00"),
  credit_applied_amount: decimal("credit_applied_amount", { precision: 12, scale: 2 }).default("0.00").notNull(),
  prepared_by: text("prepared_by"),
  created_at: timestamp("created_at").defaultNow().notNull(),
  updated_at: timestamp("updated_at").defaultNow().notNull(),
}, (table) => [
  index("invoices_agent_id_idx").on(table.agent_id),
  index("invoices_booking_id_idx").on(table.booking_id),
  index("invoices_created_at_idx").on(table.created_at),
]);

// Invoice items table — line-item snapshot frozen at invoice creation
export const invoice_items = pgTable("invoice_items", {
  id: text("id").primaryKey(),
  invoice_id: text("invoice_id")
    .notNull()
    .references(() => invoices.id, { onDelete: "cascade" }),
  product_id: text("product_id").notNull(),
  product_name: text("product_name").notNull(),
  product_sku: text("product_sku"),
  qty_ordered: integer("qty_ordered").notNull(),
  unit_price: decimal("unit_price", { precision: 10, scale: 2 }).notNull(),
  amount: decimal("amount", { precision: 12, scale: 2 }).notNull(),
  unit_weight_kg: decimal("unit_weight_kg", { precision: 10, scale: 2 }),
  unit_label: varchar("unit_label", { length: 10 }),
  created_at: timestamp("created_at").defaultNow().notNull(),
}, (table) => [
  index("invoice_items_invoice_id_idx").on(table.invoice_id),
]);

// Deliveries table
export const deliveries = pgTable("deliveries", {
  id: text("id").primaryKey(),
  truck_id: text("truck_id")
    .notNull()
    .references(() => trucks.id),
  // driver assigned to this delivery run (optional — can differ from the truck's default driver)
  driver_id: text("driver_id").references(() => drivers.id, { onDelete: "set null" }),
  // agent who manages/owns this delivery; auto-locked when an agent creates the delivery
  agent_id: text("agent_id").references(() => agents.id, { onDelete: "set null" }),
  scheduled_date: text("scheduled_date"),
  scheduled_time: text("scheduled_time"),
  status: deliveryStatusEnum("status").default("pending").notNull(),
  created_at: timestamp("created_at").defaultNow().notNull(),
  updated_at: timestamp("updated_at").defaultNow().notNull(),
}, (table) => [
  index("deliveries_agent_id_idx").on(table.agent_id),
  index("deliveries_driver_id_idx").on(table.driver_id),
  index("deliveries_truck_id_idx").on(table.truck_id),
  index("deliveries_status_idx").on(table.status),
]);

// Delivery items table
export const delivery_items = pgTable("delivery_items", {
  id: text("id").primaryKey(),
  delivery_id: text("delivery_id")
    .notNull()
    .references(() => deliveries.id, { onDelete: "cascade" }),
  invoice_id: text("invoice_id")
    .notNull()
    .references(() => invoices.id),
  destination_customer_id: text("destination_customer_id")
    .notNull()
    .references(() => customers.id),
  status: deliveryStatusEnum("status").default("pending").notNull(),
  completed_at: timestamp("completed_at"),
  receipt_number: text("receipt_number"),
  is_paid: boolean("is_paid").default(false),
  payment_method: varchar("payment_method", { length: 50 }),
  payment_reference: text("payment_reference"),
  paid_at: timestamp("paid_at"),
  created_at: timestamp("created_at").defaultNow().notNull(),
  updated_at: timestamp("updated_at").defaultNow().notNull(),
}, (table) => [
  index("delivery_items_delivery_id_idx").on(table.delivery_id),
  index("delivery_items_destination_customer_id_idx").on(table.destination_customer_id),
  index("delivery_items_invoice_id_idx").on(table.invoice_id),
]);

// Receipts table
export const receipts = pgTable("receipts", {
  id: text("id").primaryKey(),
  receipt_number: text("receipt_number").notNull().unique(),
  delivery_item_id: text("delivery_item_id")
    .notNull()
    .references(() => delivery_items.id),
  customer_id: text("customer_id")
    .notNull()
    .references(() => customers.id),
  truck_id: text("truck_id")
    .notNull()
    .references(() => trucks.id),
  invoice_id: text("invoice_id")
    .notNull()
    .references(() => invoices.id),
  confirmed_by: text("confirmed_by"),
  notes: text("notes"),
  payment_reference: text("payment_reference"),
  cash_collected_amount: decimal("cash_collected_amount", { precision: 12, scale: 2 }).default("0.00").notNull(),
  payment_verified_by: text("payment_verified_by").references(() => users.id),
  payment_verified_at: timestamp("payment_verified_at"),
  payment_verification_remarks: text("payment_verification_remarks"),
  confirmed_at: timestamp("confirmed_at").defaultNow().notNull(),
}, (table) => [
  index("receipts_customer_id_idx").on(table.customer_id),
  index("receipts_delivery_item_id_idx").on(table.delivery_item_id),
  index("receipts_invoice_id_idx").on(table.invoice_id),
  index("receipts_truck_id_idx").on(table.truck_id),
  index("receipts_confirmed_at_idx").on(table.confirmed_at),
]);

export const receipt_payment_entries = pgTable("receipt_payment_entries", {
  id: text("id").primaryKey(),
  receipt_id: text("receipt_id")
    .notNull()
    .references(() => receipts.id, { onDelete: "cascade" }),
  idempotency_key: text("idempotency_key").notNull().unique(),
  amount: decimal("amount", { precision: 12, scale: 2 }).notNull(),
  payment_method: varchar("payment_method", { length: 50 }).notNull(),
  payment_reference: text("payment_reference"),
  notes: text("notes"),
  recorded_by: text("recorded_by").references(() => users.id),
  verified_by: text("verified_by").references(() => users.id),
  verified_at: timestamp("verified_at"),
  verification_remarks: text("verification_remarks"),
  created_at: timestamp("created_at").defaultNow().notNull(),
}, (table) => [
  index("receipt_payment_entries_receipt_id_idx").on(table.receipt_id),
  index("receipt_payment_entries_verified_at_idx").on(table.verified_at),
]);

// Accounts Receivable table — tracks unpaid delivery amounts
export const accounts_receivable = pgTable("accounts_receivable", {
  id: text("id").primaryKey(),
  customer_id: text("customer_id")
    .notNull()
    .references(() => customers.id),
  delivery_item_id: text("delivery_item_id")
    .references(() => delivery_items.id),   // nullable — return credits have no delivery item
  invoice_id: text("invoice_id")
    .notNull()
    .references(() => invoices.id),
  amount_due: decimal("amount_due", { precision: 10, scale: 2 }).notNull(),
  credit_type: varchar("credit_type", { length: 20 }),
  status: varchar("status", { length: 20 }).default("outstanding").notNull(),
  notes: text("notes"),
  created_at: timestamp("created_at").defaultNow().notNull(),
  updated_at: timestamp("updated_at").defaultNow().notNull(),
}, (table) => [
  index("accounts_receivable_customer_id_idx").on(table.customer_id),
  index("accounts_receivable_delivery_item_id_idx").on(table.delivery_item_id),
  index("accounts_receivable_invoice_id_idx").on(table.invoice_id),
  index("accounts_receivable_status_idx").on(table.status),
]);

export const invoice_credit_applications = pgTable("invoice_credit_applications", {
  id: text("id").primaryKey(),
  credit_ar_id: text("credit_ar_id")
    .notNull()
    .references(() => accounts_receivable.id),
  invoice_id: text("invoice_id")
    .notNull()
    .references(() => invoices.id),
  amount_applied: decimal("amount_applied", { precision: 12, scale: 2 }).notNull(),
  created_at: timestamp("created_at").defaultNow().notNull(),
}, (table) => [
  index("invoice_credit_applications_credit_ar_id_idx").on(table.credit_ar_id),
  index("invoice_credit_applications_invoice_id_idx").on(table.invoice_id),
]);

// Agent Returns table — tracks returned delivery goods
export const agent_returns = pgTable("agent_returns", {
  id: text("id").primaryKey(),
  invoice_id: text("invoice_id")
    .notNull()
    .references(() => invoices.id),
  customer_id: text("customer_id")
    .notNull()
    .references(() => customers.id),
  product_id: text("product_id")
    .notNull()
    .references(() => products.id),
  product_name: text("product_name").notNull(),
  qty_returned: integer("qty_returned").notNull(),
  return_type: varchar("return_type", { length: 20 }).notNull().default("good"),
  reason: text("reason"),
  status: varchar("status", { length: 20 }).notNull().default("pending"),
  restored_to_pallet_id: text("restored_to_pallet_id"),
  ar_credit_id: text("ar_credit_id"),
  created_by: text("created_by").references(() => users.id),
  reviewed_by: text("reviewed_by"),
  reviewed_at: timestamp("reviewed_at"),
  created_at: timestamp("created_at").defaultNow().notNull(),
  updated_at: timestamp("updated_at").defaultNow().notNull(),
}, (table) => [
  index("agent_returns_created_by_idx").on(table.created_by),
  index("agent_returns_customer_id_idx").on(table.customer_id),
  index("agent_returns_invoice_id_idx").on(table.invoice_id),
  index("agent_returns_product_id_idx").on(table.product_id),
]);

// Audit logs table
export const audit_logs = pgTable("audit_logs", {
  id: text("id").primaryKey(),
  user_id: text("user_id")
    .notNull()
    .references(() => users.id),
  action: text("action").notNull(),
  resource_type: text("resource_type").notNull(),
  resource_id: text("resource_id"),
  before_state: text("before_state"),
  after_state: text("after_state"),
  created_at: timestamp("created_at").defaultNow().notNull(),
}, (table) => [
  index("audit_logs_user_id_idx").on(table.user_id),
  index("audit_logs_created_at_idx").on(table.created_at),
]);

// Expenses table — staff submit, admin approves or rejects, accounting marks paid
export const expenses = pgTable("expenses", {
  id: text("id").primaryKey(),
  category: text("category").notNull(),
  description: text("description"),
  amount: decimal("amount", { precision: 12, scale: 2 }).notNull(),
  // submitted | approved | rejected | paid
  status: varchar("status", { length: 20 }).default("submitted").notNull(),
  submitted_by: text("submitted_by")
    .notNull()
    .references(() => users.id),
  approved_by: text("approved_by").references(() => users.id),
  paid_by: text("paid_by").references(() => users.id),
  reject_reason: text("reject_reason"),
  created_at: timestamp("created_at").defaultNow().notNull(),
  updated_at: timestamp("updated_at").defaultNow().notNull(),
  approved_at: timestamp("approved_at"),
  paid_at: timestamp("paid_at"),
}, (table) => [
  index("expenses_status_idx").on(table.status),
  index("expenses_submitted_by_idx").on(table.submitted_by),
  check("expenses_amount_positive", sql`${table.amount} > 0`),
  check("expenses_status_check", sql`${table.status} IN ('submitted', 'approved', 'rejected', 'paid')`),
]);

// ─── Relations ────────────────────────────────────────────────────────────────

export const usersRelations = relations(users, ({ many }) => ({
  customers: many(customers),
  agents: many(agents),
  created_bookings: many(bookings),
  invoices: many(invoices),
  audit_logs: many(audit_logs),
}));

export const customersRelations = relations(customers, ({ one, many }) => ({
  agent: one(users, { fields: [customers.agent_id], references: [users.id] }),
  bookings: many(bookings),
  discounts: many(customer_discounts),
  delivery_items: many(delivery_items),
  receipts: many(receipts),
}));

export const customerDiscountsRelations = relations(customer_discounts, ({ one }) => ({
  customer: one(customers, { fields: [customer_discounts.customer_id], references: [customers.id] }),
}));

export const productsRelations = relations(products, ({ many }) => ({
  pallet_items: many(pallet_items),
  booking_items: many(booking_items),
  order_pallet_items: many(order_pallet_items),
  order_item_reservations: many(order_item_reservations),
}));

export const inventoryBatchesRelations = relations(inventory_batches, ({ many }) => ({
  pallets: many(batch_pallets),
}));

export const batchPalletsRelations = relations(batch_pallets, ({ one, many }) => ({
  batch: one(inventory_batches, { fields: [batch_pallets.batch_id], references: [inventory_batches.id] }),
  items: many(pallet_items),
}));

export const palletItemsRelations = relations(pallet_items, ({ one }) => ({
  pallet: one(batch_pallets, { fields: [pallet_items.pallet_id], references: [batch_pallets.id] }),
  product: one(products, { fields: [pallet_items.product_id], references: [products.id] }),
}));

export const agentsRelations = relations(agents, ({ one }) => ({
  user: one(users, { fields: [agents.user_id], references: [users.id] }),
}));

export const driversRelations = relations(drivers, ({ one, many }) => ({
  user: one(users, { fields: [drivers.user_id], references: [users.id] }),
  trucks: many(trucks),
}));

export const trucksRelations = relations(trucks, ({ one, many }) => ({
  driver: one(drivers, { fields: [trucks.driver_id], references: [drivers.id] }),
  deliveries: many(deliveries),
  order_pallets: many(order_pallets),
  receipts: many(receipts),
}));

export const bookingsRelations = relations(bookings, ({ one, many }) => ({
  customer: one(customers, { fields: [bookings.customer_id], references: [customers.id] }),
  creator: one(users, { fields: [bookings.created_by], references: [users.id] }),
  booking_items: many(booking_items),
  reservations: many(order_item_reservations),
  order_pallets: many(order_pallets),
  invoices: many(invoices),
}));

export const bookingItemsRelations = relations(booking_items, ({ one, many }) => ({
  booking: one(bookings, { fields: [booking_items.booking_id], references: [bookings.id] }),
  product: one(products, { fields: [booking_items.product_id], references: [products.id] }),
  reservations: many(order_item_reservations),
}));

export const orderItemReservationsRelations = relations(order_item_reservations, ({ one }) => ({
  booking: one(bookings, { fields: [order_item_reservations.booking_id], references: [bookings.id] }),
  bookingItem: one(booking_items, { fields: [order_item_reservations.booking_item_id], references: [booking_items.id] }),
  product: one(products, { fields: [order_item_reservations.product_id], references: [products.id] }),
}));

export const orderPalletsRelations = relations(order_pallets, ({ one, many }) => ({
  order: one(bookings, { fields: [order_pallets.order_id], references: [bookings.id] }),
  truck: one(trucks, { fields: [order_pallets.truck_id], references: [trucks.id] }),
  items: many(order_pallet_items),
}));

export const orderPalletItemsRelations = relations(order_pallet_items, ({ one }) => ({
  pallet: one(order_pallets, { fields: [order_pallet_items.pallet_id], references: [order_pallets.id] }),
  product: one(products, { fields: [order_pallet_items.product_id], references: [products.id] }),
}));

export const invoicesRelations = relations(invoices, ({ one, many }) => ({
  booking: one(bookings, { fields: [invoices.booking_id], references: [bookings.id] }),
  agent: one(users, { fields: [invoices.agent_id], references: [users.id] }),
  invoice_items: many(invoice_items),
  delivery_items: many(delivery_items),
  receipts: many(receipts),
}));

export const invoiceItemsRelations = relations(invoice_items, ({ one }) => ({
  invoice: one(invoices, { fields: [invoice_items.invoice_id], references: [invoices.id] }),
}));

export const deliveriesRelations = relations(deliveries, ({ one, many }) => ({
  truck: one(trucks, { fields: [deliveries.truck_id], references: [trucks.id] }),
  driver: one(drivers, { fields: [deliveries.driver_id], references: [drivers.id] }),
  agent: one(agents, { fields: [deliveries.agent_id], references: [agents.id] }),
  delivery_items: many(delivery_items),
}));

export const deliveryItemsRelations = relations(delivery_items, ({ one, many }) => ({
  delivery: one(deliveries, { fields: [delivery_items.delivery_id], references: [deliveries.id] }),
  invoice: one(invoices, { fields: [delivery_items.invoice_id], references: [invoices.id] }),
  destination_customer: one(customers, { fields: [delivery_items.destination_customer_id], references: [customers.id] }),
  receipt: many(receipts),
  accounts_receivable: many(accounts_receivable),
}));

export const accountsReceivableRelations = relations(accounts_receivable, ({ one }) => ({
  delivery_item: one(delivery_items, { fields: [accounts_receivable.delivery_item_id], references: [delivery_items.id] }),
  invoice: one(invoices, { fields: [accounts_receivable.invoice_id], references: [invoices.id] }),
}));

export const receiptsRelations = relations(receipts, ({ one, many }) => ({
  delivery_item: one(delivery_items, { fields: [receipts.delivery_item_id], references: [delivery_items.id] }),
  customer: one(customers, { fields: [receipts.customer_id], references: [customers.id] }),
  truck: one(trucks, { fields: [receipts.truck_id], references: [trucks.id] }),
  invoice: one(invoices, { fields: [receipts.invoice_id], references: [invoices.id] }),
  payment_entries: many(receipt_payment_entries),
}));

export const receiptPaymentEntriesRelations = relations(receipt_payment_entries, ({ one }) => ({
  receipt: one(receipts, { fields: [receipt_payment_entries.receipt_id], references: [receipts.id] }),
  recorder: one(users, { fields: [receipt_payment_entries.recorded_by], references: [users.id] }),
  verifier: one(users, { fields: [receipt_payment_entries.verified_by], references: [users.id] }),
}));

export const auditLogsRelations = relations(audit_logs, ({ one }) => ({
  user: one(users, { fields: [audit_logs.user_id], references: [users.id] }),
}));

export const agentReturnsRelations = relations(agent_returns, ({ one }) => ({
  invoice: one(invoices, { fields: [agent_returns.invoice_id], references: [invoices.id] }),
  customer: one(customers, { fields: [agent_returns.customer_id], references: [customers.id] }),
  product: one(products, { fields: [agent_returns.product_id], references: [products.id] }),
  creator: one(users, { fields: [agent_returns.created_by], references: [users.id] }),
}));
