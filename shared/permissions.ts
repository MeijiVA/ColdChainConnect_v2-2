import type { ModulePermission } from "./api";

export type Role = "admin" | "agent" | "driver" | "staff";

export type Action =
  | "booking:approve"
  | "booking:editItems"
  | "payment:verify"
  | "cash:reconcile"
  | "expense:submit"
  | "expense:approve"
  | "expense:pay"
  | "delivery:confirm"
  | "maintenance:request"
  | "maintenance:decide"
  // Pallets: mirror the server rules on /api/pallets (create is open to order-fulfillment staff; status and approve to admin and agent; delete to admin).
  | "pallet:create"
  | "pallet:updateStatus"
  | "pallet:delete"
  // Mutations the server currently restricts to admin (requireRole("admin")); the client mirrors them.
  | "invoice:update"
  | "receivable:update"
  | "delivery:update"
  | "agentReturn:decide"
  | "customer:manage"
  | "product:manage"
  | "batch:manage"
  | "driver:manage"
  | "agent:manage"
  | "truck:manage"
  | "user:archive";

export interface PermissionSubject {
  role: Role;
  module_permissions?: readonly string[];
}

interface Rule {
  roles: readonly Role[];
  /** Staff only: any one of these modules is enough. Omitted means staff can never do it. */
  staffModules?: readonly ModulePermission[];
}

/** Single table of who may do what. Admin is always allowed. */
const ACTION_RULES: Record<Action, Rule> = {
  "booking:approve": { roles: ["admin"] },
  "booking:editItems": { roles: ["admin"] },
  "payment:verify": { roles: ["admin", "staff"], staffModules: ["accounting"] },
  "cash:reconcile": { roles: ["admin", "staff"], staffModules: ["accounting"] },
  "expense:submit": { roles: ["admin", "staff"], staffModules: ["accounting"] },
  "expense:approve": { roles: ["admin"] },
  "expense:pay": { roles: ["admin", "staff"], staffModules: ["accounting"] },
  "delivery:confirm": { roles: ["admin", "agent", "driver"] },
  "maintenance:request": { roles: ["admin", "agent", "driver"] },
  "maintenance:decide": { roles: ["admin"] },
  "pallet:create": { roles: ["admin", "agent", "staff"], staffModules: ["order-fulfillment"] },
  "pallet:updateStatus": { roles: ["admin", "agent"] },
  "pallet:delete": { roles: ["admin"] },
  "invoice:update": { roles: ["admin"] },
  "receivable:update": { roles: ["admin"] },
  "delivery:update": { roles: ["admin"] },
  "agentReturn:decide": { roles: ["admin"] },
  "customer:manage": { roles: ["admin"] },
  "product:manage": { roles: ["admin"] },
  "batch:manage": { roles: ["admin"] },
  "driver:manage": { roles: ["admin"] },
  "agent:manage": { roles: ["admin"] },
  "truck:manage": { roles: ["admin"] },
  "user:archive": { roles: ["admin"] },
};

export function can(user: PermissionSubject, action: Action): boolean {
  if (user.role === "admin") return true;
  const rule = ACTION_RULES[action];
  if (!rule.roles.includes(user.role)) return false;
  if (user.role !== "staff") return true;
  return Boolean(rule.staffModules?.some((module) => user.module_permissions?.includes(module)));
}

/** API path prefixes (relative to /api) a staff account may reach, with the modules that unlock each. */
export const STAFF_API_MODULES: Record<string, ModulePermission[]> = {
  "/customers": ["product-customer"],
  "/products": ["product-customer"],
  "/batches": ["product-customer"],
  "/pallets": ["order-fulfillment"],
  "/orders": ["order-fulfillment"],
  "/bookings": ["order-fulfillment"],
  "/invoices": ["order-fulfillment"],
  "/inventory-batches": ["order-fulfillment"],
  "/drivers": ["manage-accounts", "delivery-operations"],
  "/trucks": ["delivery-operations"],
  "/deliveries": ["delivery-operations"],
  "/receipts": ["delivery-operations", "accounting"],
  "/payments": ["accounting"],
  "/expenses": ["accounting"],
  "/cash-remittances": ["accounting"],
  "/accounts-receivable": ["delivery-operations"],
  "/agent-returns": ["delivery-operations"],
  "/agents": ["manage-accounts"],
  "/dashboard": ["dashboard"],
  "/reports": ["reports"],
  "/sales/forecast": ["reports"],
  "/audit-logs": ["administration"],
  "/backup": ["administration"],
};

/**
 * Extra modules that unlock a prefix for read-only requests (GET/HEAD) on top of STAFF_API_MODULES.
 * The order and pallet screens look up customers, products, stock, trucks and deliveries; staff with
 * only order-fulfillment may read those lists but never change them (writes stay on STAFF_API_MODULES
 * and the admin-only routes behind it).
 */
export const STAFF_READ_API_MODULES: Record<string, ModulePermission[]> = {
  "/customers": ["order-fulfillment"],
  "/products": ["order-fulfillment"],
  "/trucks": ["order-fulfillment"],
  "/deliveries": ["order-fulfillment"],
};
