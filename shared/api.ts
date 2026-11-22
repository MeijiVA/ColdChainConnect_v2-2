/** Minimum length for any password an admin sets or changes. */
export const MIN_PASSWORD_LENGTH = 8;

/**
 * Shared code between client and server
 */

import { z } from "zod";

export const modulePermissionKeys = [
  "dashboard",
  "product-customer",
  "order-fulfillment",
  "delivery-operations",
  "manage-accounts",
  "reports",
  "administration",
  "accounting",
] as const;
export type ModulePermission = (typeof modulePermissionKeys)[number];
export const modulePermissionLabels: Record<ModulePermission, string> = {
  dashboard: "Dashboard",
  "product-customer": "Product & Customer Management",
  "order-fulfillment": "Order Fulfillment",
  "delivery-operations": "Delivery & Customer Operations",
  "manage-accounts": "Manage Accounts",
  reports: "Reports",
  administration: "Administration",
  accounting: "Accounting",
};

// Auth types
export interface LoginRequest {
  username: string;
  password: string;
}

export const LoginRequestSchema = z.object({
  username: z.string().min(1, "Username is required"),
  password: z.string().min(1, "Password is required"),
});

export interface LoginResponse {
  token: string;
  user: {
    id: string;
    username: string;
    role: "admin" | "agent" | "driver" | "staff";
    module_permissions?: string[];
  };
}

export interface MfaChallengeResponse {
  mfa: "setup" | "verify";
  challenge_token: string;
}

export interface MfaSetupResponse {
  secret: string;
  otpauth_url: string;
  qr_data_url: string;
}

export interface MfaVerifyRequest {
  challenge_token: string;
  code: string;
}

export interface LogoutResponse {
  message: string;
}

export interface CreateAccountRequest {
  username: string;
  password: string;
  role: "admin" | "agent" | "staff";
  module_permissions?: ModulePermission[];
}

export interface CreateAccountResponse {
  id: string;
  username: string;
  role: "admin" | "agent" | "staff";
}

// User types
export interface User {
  id: string;
  username: string;
  role: "admin" | "agent" | "driver" | "staff";
  mfa_enabled: boolean;
  mfa_required: boolean;
  created_at: string;
  updated_at: string;
  agent?: Pick<Agent, "full_name"> | null;
}

// Customer types
export interface CustomerDiscount {
  id?: string;
  label: string;
  rate: number | string;
}

export interface Customer {
  id: string;
  store_name: string;
  location: string;
  district?: string | null;
  street_number?: string | null;
  street_address?: string | null;
  state?: string | null;
  postal_code?: string | null;
  latitude?: number | null;
  longitude?: number | null;
  contact_person?: string;
  contact_info?: string;
  agent_id?: string;
  payment_type?: "cash" | "check" | "bank_transfer" | "cod" | "credit";
  credit_limit?: string | null;
  credit_terms_days?: number;
  discounts?: CustomerDiscount[];
  created_at: string;
  updated_at: string;
}

export interface CreditViolation {
  code: "OVERDUE_BEYOND_TERMS" | "CREDIT_LIMIT_EXCEEDED";
  message: string;
}

export interface CreditBlockResponse {
  error: string;
  code: "AR_CREDIT_BLOCKED";
  violations: CreditViolation[];
  canOverride: boolean;
}

export function totalDiscountRate(discounts: CustomerDiscount[] | undefined): number {
  return (discounts ?? []).reduce((sum, discount) => sum + Number(discount.rate), 0);
}

export function formatCustomerAddress(
  customer: Pick<Customer, "location" | "street_number" | "street_address" | "state" | "postal_code">
): string {
  const streetLine = [customer.street_number, customer.street_address].filter(Boolean).join(" ");
  const parts = [streetLine, customer.location, customer.state, customer.postal_code].filter(Boolean);
  return parts.join(", ");
}

export const CreateCustomerSchema = z.object({
  store_name: z.string().min(1, "Store name is required"),
  location: z.string().min(1, "Location is required"),
  district: z.string().optional(),
  street_number: z.string().optional(),
  street_address: z.string().optional(),
  state: z.string().optional(),
  postal_code: z.string().optional(),
  latitude: z.number().finite().nullable().optional(),
  longitude: z.number().finite().nullable().optional(),
  contact_person: z.string().optional(),
  contact_info: z.string().optional(),
  agent_id: z.string().optional(),
  payment_type: z.enum(["cash", "check", "bank_transfer", "cod", "credit"]).optional(),
  credit_limit: z.number().nonnegative().nullable().optional(),
  credit_terms_days: z.number().int().min(1).max(365).optional(),
  discounts: z
    .array(z.object({ label: z.string().min(1), rate: z.number().gt(0).max(1) }))
    .refine((list) => list.reduce((sum, d) => sum + d.rate, 0) <= 1 + 1e-9, {
      message: "Combined discounts cannot exceed 100%",
    })
    .optional(),
});

export const UpdateCustomerSchema = CreateCustomerSchema.partial();

// Product types
export interface Product {
  id: string;
  name: string;
  sku?: string;
  price: string;
  image_filename?: string;
  batch_tracking_enabled: boolean;
  reorder_point?: number;
  weight?: string | null;
  /** Unit type printed on receipts. */
  unit?: ProductUnit;
  /** Suggested retail price: what the customer is expected to sell it for. */
  srp?: string | null;
  manufacturer?: string;
  is_discontinued?: boolean;
  is_archived?: boolean;
  created_at: string;
  updated_at: string;
}

export interface BatchReservation {
  productId: string;
  productName: string;
  sku: string | null;
  orderId: string;
  customerName: string;
  qty: number;
}

export const PRODUCT_UNITS = ["PK", "EA"] as const;
export type ProductUnit = (typeof PRODUCT_UNITS)[number];

const toAmount = (value: string | number | null | undefined): number | null => {
  if (value === null || value === undefined || value === "") return null;
  const amount = typeof value === "number" ? value : parseFloat(value);
  return Number.isFinite(amount) ? amount : null;
};

/** Customer's markup over our price, as a percent of our price. Null without an SRP or a positive price. */
export function markupPercent(price: string | number | null | undefined, srp: string | number | null | undefined): number | null {
  const sell = toAmount(price);
  const retail = toAmount(srp);
  if (sell === null || retail === null || sell <= 0) return null;
  return Math.round(((retail - sell) / sell) * 1000) / 10;
}

/** Our profit margin, as a percent of our price. Null without a cost or a positive price. */
export function marginPercent(price: string | number | null | undefined, cost: string | number | null | undefined): number | null {
  const sell = toAmount(price);
  const spent = toAmount(cost);
  if (sell === null || spent === null || sell <= 0) return null;
  return Math.round(((sell - spent) / sell) * 1000) / 10;
}

export const CreateProductSchema = z.object({
  name: z.string().min(1, "Product name is required"),
  sku: z.string().optional(),
  price: z.string().or(z.number()).refine((val) => {
    const num = typeof val === "string" ? parseFloat(val) : val;
    return !isNaN(num) && num > 0;
  }, "Price must be a positive number"),
  image_filename: z.string().optional(),
  batch_tracking_enabled: z.boolean().default(true),
  reorder_point: z.number().int().nonnegative().optional(),
  weight: z.number().nonnegative().optional(),
  unit: z.enum(PRODUCT_UNITS).optional(),
  srp: z.number().nonnegative().nullable().optional(),
  cost_price: z.number().nonnegative().nullable().optional(),
  manufacturer: z.string().optional(),
  is_discontinued: z.boolean().optional(),
});

export const UpdateProductSchema = CreateProductSchema.partial();

// Batch types
export interface Batch {
  id: string;
  product_id: string;
  pallet_id: string;
  qty_units: number;
  expiration_date?: string;
  placement_location?: string;
  created_at: string;
  updated_at: string;
}

export function isValidIsoDate(value: string) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return false;
  const [year, month, day] = match.slice(1).map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

export const CreateBatchSchema = z.object({
  product_id: z.string().min(1, "Product ID is required"),
  pallet_id: z.string().min(1, "Pallet ID is required"),
  qty_units: z.number().int().positive("Quantity must be positive"),
  expiration_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Expiry must be a YYYY-MM-DD date").optional(),
  placement_location: z.string().optional(),
});

export const UpdateBatchSchema = CreateBatchSchema.partial();

// Inventory Batch types (restock batches, separate from physical Batch/pallet)
export interface InventoryBatch {
  id: string;
  name: string;
  status: "open" | "closed";
  created_at: string;
  closed_at?: string;
  updated_at: string;
  items?: InventoryBatchItem[];
}

export interface InventoryBatchItem {
  id: string;
  batch_id: string;
  product_id: string;
  qty_units: number;
  available_units?: number;
  unit_cost: string;
  created_at: string;
  updated_at: string;
}

export const CreateInventoryBatchSchema = z.object({
  name: z.string().min(1, "Batch name is required"),
  items: z.array(z.object({
    product_id: z.string().min(1, "Product ID is required"),
    qty_units: z.number().int().positive("Quantity must be positive"),
  })).min(1, "At least one item is required"),
});

export const UpdateInventoryBatchSchema = z.object({
  status: z.enum(["open", "closed"]).optional(),
  name: z.string().optional(),
});

// Pallet types (for order preparation)
export interface Pallet {
  id: string;
  order_id: string;
  truck_id?: string;
  status: "draft" | "prepared" | "approved" | "shipped";
  created_at: string;
  updated_at: string;
  items?: PalletItem[];
}

export interface PalletItem {
  id: string;
  pallet_id: string;
  product_id: string;
  qty_units: number;
  unit_cost: string;
  batch_item_id: string;
  created_at: string;
  updated_at: string;
}

export const CreatePalletSchema = z.object({
  order_id: z.string().min(1, "Order ID is required"),
  pallets: z.array(z.object({
    items: z.array(z.object({
      product_id: z.string().min(1, "Product ID is required"),
      qty_units: z.number().int().positive("Quantity must be positive"),
      batch_item_id: z.string().min(1, "Batch item ID is required"),
    })).min(1, "Each pallet needs at least one item"),
  })).min(1, "At least one pallet is required"),
});

export const UpdatePalletStatusSchema = z.object({
  status: z.enum(["draft", "prepared", "approved", "shipped"]),
});

// Agent types — account-linked staff with login credentials
export interface Agent {
  id: string;
  user_id: string;
  full_name?: string;
  email?: string;
  contact_info?: string;
  emergency_contact?: string;
  hire_date?: string;
  address?: string;
  is_active: boolean;
  is_archived: boolean;
  created_at: string;
  updated_at: string;
  user?: User;
}

export const CreateAgentSchema = z.object({
  username: z.string().min(1, "Username is required"),
  password: z.string().min(MIN_PASSWORD_LENGTH, `Password must be at least ${MIN_PASSWORD_LENGTH} characters`),
  full_name: z.string().optional(),
  email: z.string().email("Valid email is required").optional(),
  contact_info: z.string().optional(),
  emergency_contact: z.string().optional(),
  hire_date: z.string().optional(),
  address: z.string().optional(),
  is_active: z.boolean().default(true),
});

export const UpdateAgentSchema = CreateAgentSchema.omit({ username: true, password: true }).partial();

// Driver types — standalone field staff (no login account)
export interface Driver {
  id: string;
  full_name?: string;
  contact_info?: string;
  license?: string;
  hire_date?: string;
  employment_type?: "full_time" | "part_time";
  is_active: boolean;
  is_archived: boolean;
  user_id?: string | null;
  user?: { id: string; username: string; mfa_enabled: boolean; mfa_required: boolean } | null;
  created_at: string;
  updated_at: string;
}

export interface DriverSchedule {
  date: string;
  driver: { id: string; full_name: string | null };
  deliveries: DriverScheduleRun[];
}

export interface DriverScheduleRun {
  id: string;
  status: "pending" | "in_transit" | "completed";
  truck: { id: string; license_plate: string; district: string };
  delivery_items: DriverScheduleStop[];
}

export interface DriverScheduleStop {
  id: string;
  delivery_id: string;
  status: "pending" | "in_transit" | "completed";
  is_paid: boolean | null;
  /** Balance still owed on this stop after any payment taken at confirmation. */
  outstanding_amount: number;
  destination_customer: {
    id: string;
    store_name: string;
    location: string;
    street_address: string | null;
    latitude: number | null;
    longitude: number | null;
    contact_person: string | null;
    contact_info: string | null;
  };
  invoice: {
    id: string;
    receipt_number: string | null;
    total_amount: string | null;
    credit_applied_amount?: string | null;
    payment_status: string;
    invoice_items: { id: string; product_name: string; qty_ordered: number }[];
  };
}

export const CreateDriverSchema = z.object({
  full_name: z.string().min(1, "Full name is required"),
  contact_info: z.string().optional(),
  license: z.string().optional(),
  hire_date: z.string().optional(),
  employment_type: z.enum(["full_time", "part_time"]).optional(),
  is_active: z.boolean().default(true),
});

export const UpdateDriverSchema = CreateDriverSchema.partial();

// Truck types
export interface Truck {
  id: string;
  license_plate: string;
  district: string;
  driver_id?: string;
  agent_id?: string | null;
  status: "available" | "in_transit" | "maintenance";
  created_at: string;
  updated_at: string;
}

export const CreateTruckSchema = z.object({
  license_plate: z
    .string()
    .regex(/^[A-Z]{3} \d{3,4}$/, "License plate must look like ABC 1234"),
  district: z.string().min(1, "District is required"),
  driver_id: z.string().optional(),
  agent_id: z.string().nullable().optional(),
  status: z.enum(["available", "in_transit", "maintenance"]).default("available"),
});

export const UpdateTruckSchema = CreateTruckSchema.partial();

// Booking types
export interface Booking {
  id: string;
  customer_id: string;
  created_by: string;
  status: "pending" | "approved" | "rejected" | "prep" | "ready";
  prepared_delivery_date?: string | null;
  /** User id of whoever approved the booking, with the ISO timestamp. */
  approved_by?: string | null;
  /** Username of the approver, resolved by GET /api/bookings. */
  approved_by_name?: string | null;
  approved_at?: string | null;
  created_at: string;
  customer?: Customer;
  creator?: User;
  booking_items?: BookingItem[];
}

export interface BookingItem {
  id: string;
  booking_id: string;
  product_id: string;
  qty_ordered: number;
  created_at: string;
  product?: Product;
}

export const CreateBookingItemSchema = z.object({
  product_id: z.string().min(1, "Product ID is required"),
  qty_ordered: z.number().int().positive("Quantity must be positive"),
});

export const CreateBookingSchema = z.object({
  customer_id: z.string().min(1, "Customer ID is required"),
  prepared_delivery_date: z.string().optional(),
  items: z.array(CreateBookingItemSchema).min(1, "At least one item is required"),
});

export const UpdateBookingStatusSchema = z.object({
  status: z.enum(["pending", "approved", "rejected", "prep", "ready"]),
});

// Invoice types
export interface InvoiceItem {
  id: string;
  invoice_id: string;
  product_id: string;
  product_name: string;
  product_sku?: string | null;
  qty_ordered: number;
  unit_price: string;
  amount: string;
  /** kg per unit, frozen from the product when the invoice was made. Null on older receipts. */
  unit_weight_kg?: string | null;
  unit_label?: string | null;
  created_at: string;
}

export interface Invoice {
  id: string;
  booking_id: string;
  agent_id: string;
  status: "draft" | "issued" | "paid";
  payment_status: "unpaid" | "partial" | "paid";
  // Snapshot fields
  receipt_number?: string | null;
  customer_name?: string | null;
  customer_address?: string | null;
  customer_payment_type?: string | null;
  discount_rate?: string | null;
  gross_amount?: string | null;
  discount_amount?: string | null;
  total_amount?: string | null;
  credit_applied_amount?: string | null;
  prepared_by?: string | null;
  invoice_items?: InvoiceItem[];
  booking?: Booking;
  created_at: string;
  updated_at: string;
}

export const CreateInvoiceSchema = z.object({
  booking_id: z.string().min(1, "Booking ID is required"),
  agent_id: z.string().min(1, "Agent ID is required"),
});

export const UpdateInvoiceStatusSchema = z.object({
  status: z.enum(["draft", "issued", "paid"]),
});

export const UpdateInvoicePaymentStatusSchema = z.object({
  payment_status: z.enum(["unpaid", "partial", "paid"]),
});

// Expense types — staff submit, admin approves or rejects, accounting marks paid
export const expenseStatuses = ["submitted", "approved", "rejected", "paid"] as const;
export type ExpenseStatus = (typeof expenseStatuses)[number];

export interface Expense {
  id: string;
  category: string;
  description?: string | null;
  /** Decimal string, e.g. "1250.50" */
  amount: string;
  status: ExpenseStatus;
  submitted_by: string;
  approved_by?: string | null;
  paid_by?: string | null;
  reject_reason?: string | null;
  created_at: string;
  updated_at: string;
  approved_at?: string | null;
  paid_at?: string | null;
  /** Usernames, present on list responses. */
  submitted_by_name?: string | null;
  approved_by_name?: string | null;
  paid_by_name?: string | null;
}

export const CreateExpenseSchema = z.object({
  category: z.string().min(1, "Category is required"),
  description: z.string().min(1, "Description is required"),
  amount: z
    .string()
    .regex(/^\d{1,10}(\.\d{1,2})?$/, "Amount must be a positive decimal with up to 2 places")
    .refine((value) => Number(value) > 0, "Amount must be greater than zero"),
});
export type CreateExpenseRequest = z.infer<typeof CreateExpenseSchema>;

export const RejectExpenseSchema = z.object({
  reject_reason: z.string().min(1, "A reason is required to reject an expense"),
});
export type RejectExpenseRequest = z.infer<typeof RejectExpenseSchema>;

export interface ExpensesResponse {
  expenses: Expense[];
}

export const maintenanceStatuses = ["submitted", "approved", "rejected"] as const;
export type MaintenanceStatus = (typeof maintenanceStatuses)[number];

export interface MaintenanceRequest {
  id: string;
  asset: string;
  description: string;
  status: MaintenanceStatus;
  requested_by: string;
  reviewed_by?: string | null;
  reviewed_at?: string | null;
  reject_reason?: string | null;
  created_at: string;
  updated_at: string;
  /** Username, present on list responses. */
  requested_by_name?: string | null;
  reviewed_by_name?: string | null;
}

export const CreateMaintenanceRequestSchema = z.object({
  asset: z.string().trim().min(1, "Asset is required").max(120, "Asset must be 120 characters or fewer"),
  description: z.string().trim().min(1, "Description is required"),
});
export type CreateMaintenanceRequest = z.infer<typeof CreateMaintenanceRequestSchema>;

export interface MaintenanceRequestsResponse {
  requests: MaintenanceRequest[];
}

export interface ExpenseResponse {
  expense: Expense;
}

/** One row of GET /api/payments/unverified: a collected payment, awaiting or already past Accounting. */
export interface UnverifiedPayment {
  id: string;
  receipt_id: string;
  receipt_number: string;
  delivery_item_id: string;
  customer_id: string;
  invoice_id: string;
  confirmed_at: string;
  /** Set once Accounting has verified the payment. */
  verified_at?: string | null;
  customer_name: string;
  invoice_receipt_number: string;
  payment_method: string | null;
  /** Decimal string: what was collected so far on the stop. */
  amount: string;
  recorded_by: string | null;
  recorded_by_username: string | null;
  recorded_by_name: string | null;
  recorded_by_role: "admin" | "agent" | "driver" | "staff" | null;
  /** User id and name of the agent who owns the delivery run this payment was collected on. */
  agent_user_id?: string | null;
  agent_name?: string | null;
  /** Bank transfer or check reference typed when the payment was recorded. */
  payment_reference?: string | null;
}

/** One row of GET /api/payments/agents: an agent account (user id) Accounting can filter payments by. */
export interface PaymentAgentOption {
  id: string;
  name: string;
}

/** Payment methods that need a clearance remark before Accounting can verify them. */
export const PAYMENT_METHODS_NEEDING_CLEARANCE = ["bank_transfer", "check"] as const;

export function paymentNeedsClearance(method: string | null | undefined): boolean {
  return PAYMENT_METHODS_NEEDING_CLEARANCE.some((value) => value === method);
}

// Delivery types
export interface Delivery {
  id: string;
  truck_id: string;
  driver_id?: string | null;
  agent_id?: string | null;
  driver?: Driver | null;
  agent?: Agent | null;
  status: "pending" | "in_transit" | "completed";
  scheduled_date?: string | null;
  scheduled_time?: string | null;
  created_at: string;
  updated_at: string;
}

export interface DeliveryItem {
  id: string;
  delivery_id: string;
  invoice_id: string;
  destination_customer_id: string;
  status: "pending" | "in_transit" | "completed";
  is_paid?: boolean;
  payment_method?: string;
  payment_reference?: string | null;
  paid_at?: string;
  completed_at?: string;
  receipt_number?: string;
  created_at: string;
  updated_at: string;
}

export interface AgentSchedulePallet extends Pick<Pallet, "id" | "order_id" | "status"> {
  items: {
    id: string;
    qty_units: number;
    product: Pick<Product, "id" | "name" | "sku"> | null;
  }[];
}

export interface AgentScheduleStop extends DeliveryItem {
  destination_customer: Customer;
  invoice: Pick<Invoice, "id" | "booking_id" | "receipt_number" | "total_amount" | "credit_applied_amount"> | null;
  sale_agent: Pick<User, "id" | "username"> | null;
  pallets: AgentSchedulePallet[];
  outstanding_amount?: number;
  /** Collected on this stop but not yet verified by Accounting at End-of-Day. */
  unverified_amount?: number;
}

export type AgentScheduleDelivery = Omit<Delivery, "agent" | "driver"> & {
  truck: Pick<Truck, "id" | "license_plate" | "district">;
  agent: Pick<Agent, "id" | "full_name"> | null;
  driver: Pick<Driver, "id" | "full_name" | "contact_info" | "license"> | null;
  delivery_items: AgentScheduleStop[];
};

export interface AgentScheduleResponse {
  deliveries: AgentScheduleDelivery[];
  assigned_trucks: { id: string; license_plate: string; district: string }[];
}

export const CreateDeliveryItemSchema = z.object({
  invoice_id: z.string().min(1, "Invoice ID is required"),
  destination_customer_id: z.string().min(1, "Destination customer ID is required"),
});

export const CreateDeliverySchema = z.object({
  truck_id: z.string().min(1, "Truck ID is required"),
  items: z.array(CreateDeliveryItemSchema).min(1, "At least one delivery item is required"),
  driver_id: z.string().optional().nullable(),
  scheduled_date: z.string().optional(),
  scheduled_time: z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/).optional(),
});

export const UpdateDeliveryStatusSchema = z.object({
  status: z.enum(["pending", "in_transit", "completed"]),
});

export const UpdateDeliveryItemStatusSchema = z.object({
  status: z.enum(["pending", "in_transit", "completed"]),
});

export const AssignDeliverySchema = z.object({
  driver_id: z.string().nullable().optional(),
  agent_id:  z.string().nullable().optional(),
});

export const ConfirmDeliveryItemSchema = z.object({
  is_paid: z.boolean().default(false),
  payment_method: z.string().optional(),
});

// Accounts Receivable types
export interface AccountsReceivable {
  id: string;
  customer_id: string;
  delivery_item_id: string | null;
  invoice_id: string;
  amount_due: string;
  credit_type?: string | null;
  status: "outstanding" | "paid" | "partial";
  notes?: string;
  created_at: string;
  updated_at: string;
  invoice?: { agent_id: string; agent: Pick<User, "id" | "username"> | null } | null;
}

export interface AgentReturn {
  id: string;
  invoice_id: string;
  customer_id: string;
  product_id: string;
  product_name: string;
  qty_returned: number;
  return_type: "good" | "damaged";
  reason?: string | null;
  status: "pending" | "accepted" | "rejected";
  restored_to_pallet_id?: string | null;
  ar_credit_id?: string | null;
  created_by?: string | null;
  reviewed_by?: string | null;
  reviewed_at?: string | null;
  created_at: string;
  updated_at: string;
  // eager-loaded
  invoice?: Invoice;
  customer?: Customer;
  product?: Product;
}

// Audit types
export interface AuditLog {
  id: string;
  user_id: string;
  user_name?: string | null;
  action: string;
  resource_type: string;
  resource_id?: string;
  before_state?: Record<string, unknown>;
  after_state?: Record<string, unknown>;
  created_at: string;
}

export interface DemoResponse {
  message: string;
}

export interface SalesForecastPoint {
  date: string;
  total: number;
}

export interface SalesProductInsight {
  product_name: string;
  days_sold: number;
  consistency_percent: number;
  avg_daily_qty: number;
  suggested_restock_qty: number;
}

export interface SalesForecastResponse {
  history: SalesForecastPoint[];
  forecast: SalesForecastPoint[];
  projected_7_day_total: number;
  trend: "up" | "down" | "flat";
  trend_percent: number;
  has_enough_data: boolean;
  history_days_with_sales: number;
  note: string;
  product_insights: SalesProductInsight[];
  ai_summary: string | null;
}

export const SalesForecastChatRequestSchema = z.object({
  question: z.string().trim().min(1).max(1000),
  messages: z.array(z.object({
    role: z.enum(["user", "assistant"]),
    content: z.string().min(1).max(2000),
  })).max(8),
  forecast: z.object({
    history: z.array(z.object({ date: z.string().max(10), total: z.number().finite() })).max(30),
    forecast: z.array(z.object({ date: z.string().max(10), total: z.number().finite() })).max(14),
    projected_7_day_total: z.number().finite(),
    trend: z.enum(["up", "down", "flat"]),
    trend_percent: z.number().finite(),
    has_enough_data: z.boolean(),
    history_days_with_sales: z.number().int().min(0).max(30),
    note: z.string().max(400),
    product_insights: z.array(z.object({
      product_name: z.string().max(120),
      days_sold: z.number().int().min(0).max(30),
      consistency_percent: z.number().finite().min(0).max(100),
      avg_daily_qty: z.number().finite().min(0),
      suggested_restock_qty: z.number().int().min(0),
    })).max(5),
    ai_summary: z.string().max(1000).nullable(),
  }),
});

export type SalesForecastChatRequest = z.infer<typeof SalesForecastChatRequestSchema>;

export interface SalesForecastChatResponse {
  answer: string;
}

export interface ReportSalesPeriod {
  period: string;
  totalRevenue: number;
  totalTransactions: number;
  averageTransaction: number;
  topProduct: string;
  topProductSales: number;
}

export interface ReportProductPerformance {
  productName: string;
  unitsSold: number;
  revenue: number;
  growth: number;
  ranking: number;
}

export interface ReportSalesResponse {
  periods: ReportSalesPeriod[];
  products: ReportProductPerformance[];
}

export interface ReportProfitRow {
  productId: string;
  productName: string;
  unitsSold: number;
  /** Net of the invoice discount. */
  revenue: number;
  /** Null when no cost price is recorded for the product. */
  cost: number | null;
  profit: number | null;
  marginPercent: number | null;
}

export interface ReportProfitResponse {
  rows: ReportProfitRow[];
  /** Totals over the products that have a cost only, so margin is not distorted by missing costs. */
  totals: { revenue: number; cost: number; profit: number; marginPercent: number | null };
  productsMissingCost: number;
}

// ─── End-of-day cash reconciliation ───────────────────────────────────────────

/** Philippine peso bills and coins counted at hand-over, largest first. Keys are the face values. */
export const CASH_DENOMINATIONS = ["1000", "500", "200", "100", "50", "20", "10", "5", "1", "0.25"] as const;
export type CashDenomination = (typeof CASH_DENOMINATIONS)[number];
export type DenominationCounts = Partial<Record<CashDenomination, number>>;

/**
 * Exact total of a denomination count, in centavos. Null when a key is not a known
 * denomination or a count is not a non-negative whole number.
 */
export function denominationTotalCents(counts: unknown): number | null {
  if (typeof counts !== "object" || counts === null || Array.isArray(counts)) return null;
  let cents = 0;
  for (const [key, count] of Object.entries(counts)) {
    if (!CASH_DENOMINATIONS.some((value) => value === key)) return null;
    if (typeof count !== "number" || !Number.isInteger(count) || count < 0) return null;
    cents += Math.round(parseFloat(key) * 100) * count;
  }
  return cents;
}

/** Today's date (YYYY-MM-DD) on the Philippine calendar, whatever timezone the caller is in. */
export function todayInManila(now: Date = new Date()): string {
  return new Date(now.getTime() + 8 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

export interface CashRemittance {
  id: string;
  remitted_by: string;
  remitted_by_username: string | null;
  received_by: string;
  received_by_username: string | null;
  /** YYYY-MM-DD, Philippine time: the day the cash was collected. */
  business_date: string;
  /** Decimal strings. */
  expected_amount: string;
  counted_amount: string;
  denominations: DenominationCounts;
  notes: string | null;
  created_at: string;
}

/** One collector's cash for a day, from GET /api/cash-remittances/collections. */
export interface CashCollectionRow {
  user_id: string;
  username: string;
  role: string;
  /** Decimal string: cash recorded on deliveries by this person that day. */
  expected: string;
  payment_count: number;
  remittance: CashRemittance | null;
}

export interface ReportStockRow {
  sku: string;
  productName: string;
  currentStock: number;
  reorderLevel: number;
  expiryDate: string;
  status: "in-stock" | "low-stock" | "expiring";
  value: number;
}

export interface ReportCustomerRow {
  customerId: string;
  customerName: string;
  totalPurchases: number;
  totalSpent: number;
  lastPurchaseDate: string;
  purchasesPerWeek: number;
}

// Dashboard: one small payload of server-side aggregates (replaces five full-list downloads)
export interface DashboardLowStockItem {
  id: string;
  name: string;
  available: number;
  reorderPoint: number;
}

export interface DashboardSummary {
  pendingOrders: number;
  activeDeliveries: number;
  availableUnits: number;
  lowStock: DashboardLowStockItem[];
  receivables: {
    /** Decimal string, e.g. "191520.00" */
    outstandingTotal: string;
    outstandingCount: number;
    /** Age in whole days of the oldest outstanding balance, or null when none. */
    oldestDays: number | null;
  };
  generatedAt: string;
}
