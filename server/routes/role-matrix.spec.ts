// Role-by-endpoint matrix. Builds the real express app from server/index.ts, lists every route it
// registers, and checks each persona against ONE policy table. A route that is added without a table
// entry (or a table entry for a route that no longer exists) fails the first test.
//
// "allowed" means the request got past authentication and the role/module guards and reached the
// handler: any status except 401/403 (a 400/404/409/500 from an empty body or a missing row is fine).
// "denied" means 401 or 403. Runs on the in-memory Postgres harness; the shared database is never touched.
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { Server } from "http";
import type { AddressInfo } from "net";
import { eq } from "drizzle-orm";
import type { ModulePermission } from "@shared/api";
import { db } from "../db";
import { users } from "../db/schema";
import { signToken } from "../auth";
import { createServer } from "../index";
import { seedUsers } from "../test/test-db";

vi.mock("../db", async () => {
  const { createTestDb: create } = await import("../test/test-db");
  return { db: (await create()).db };
});

type Method = "GET" | "POST" | "PATCH" | "DELETE";

/**
 * Who besides admin may reach a route's handler.
 * - agent / driver: reach it or not.
 * - staff: "any" (no module needed), "none" (never), or the modules of which at least one is needed.
 * - admin: defaults to true; false only for endpoints that are an agent's own (requireRole("agent")).
 * - public: no token needed; every persona gets the same answer as an anonymous caller.
 */
interface Policy {
  agent: boolean;
  driver: boolean;
  staff: "any" | "none" | readonly ModulePermission[];
  admin?: boolean;
  public?: boolean;
}

const PUBLIC: Policy = { agent: true, driver: true, staff: "any", public: true };
const ADMIN_ONLY: Policy = { agent: false, driver: false, staff: "none" };
/** Any signed-in agent; staff need one of the modules; drivers are cut off by the driver path allowlist. */
const agentAnd = (...modules: ModulePermission[]): Policy => ({ agent: true, driver: false, staff: modules });
/** Admin plus staff holding a module; agents and drivers never. */
const staffOnly = (...modules: ModulePermission[]): Policy => ({ agent: false, driver: false, staff: modules });

/** The expected policy for every route in server/index.ts, written once. */
const POLICY: Record<string, Policy> = {
  // Open endpoints
  "GET /api/health": PUBLIC,
  "GET /api/ping": PUBLIC,
  "GET /api/demo": PUBLIC,
  "POST /api/auth/login": PUBLIC,
  "POST /api/auth/mfa/setup": PUBLIC,
  "POST /api/auth/mfa/verify": PUBLIC,
  "POST /api/auth/logout": PUBLIC,

  // Any signed-in role, including drivers (token refresh is on the driver allowlist)
  "POST /api/auth/refresh": { agent: true, driver: true, staff: "any" },

  // Uploads and account administration
  "POST /api/upload": ADMIN_ONLY,
  // Staff see only their own account here (the handler filters), so no module is needed.
  "GET /api/users": { agent: false, driver: false, staff: "any" },
  "PATCH /api/users/:userId/module-permissions": ADMIN_ONLY,
  "PATCH /api/users/:userId/mfa-required": ADMIN_ONLY,
  "PATCH /api/users/:userId/archive": ADMIN_ONLY,
  "POST /api/users": ADMIN_ONLY,
  "PATCH /api/users/:userId/password": ADMIN_ONLY,
  "POST /api/users/:userId/mfa/reset": ADMIN_ONLY,
  // Registered ahead of the module guard because the handler filters counts per module itself.
  "GET /api/unseen": { agent: false, driver: false, staff: "any" },

  // Customers, products, batches: read for agents and staff with the module, write for admin only
  // GET only: order-fulfillment staff read these lookups for the order and pallet screens (STAFF_READ_API_MODULES).
  "GET /api/customers": agentAnd("product-customer", "order-fulfillment"),
  "POST /api/customers": ADMIN_ONLY,
  "PATCH /api/customers/:id": ADMIN_ONLY,
  "DELETE /api/customers/:id": ADMIN_ONLY,
  "POST /api/customers/import": ADMIN_ONLY,
  "GET /api/products": agentAnd("product-customer", "order-fulfillment"),
  "POST /api/products": ADMIN_ONLY,
  "PATCH /api/products/:id": ADMIN_ONLY,
  "PATCH /api/products/:id/archive": ADMIN_ONLY,
  "POST /api/products/import": ADMIN_ONLY,
  "GET /api/batches": agentAnd("product-customer"),
  "GET /api/batches/reservations": ADMIN_ONLY,
  "POST /api/batches/import": ADMIN_ONLY,
  "POST /api/batches": ADMIN_ONLY,
  "PATCH /api/batches/:id": ADMIN_ONLY,
  "PATCH /api/batches/:id/archive": ADMIN_ONLY,
  "DELETE /api/batches/:id": ADMIN_ONLY,
  "DELETE /api/batches/pallets/:id": ADMIN_ONLY,
  "DELETE /api/batches/pallet-items/:id": ADMIN_ONLY,

  // Drivers, agents, trucks
  "GET /api/drivers": agentAnd("manage-accounts", "delivery-operations"),
  "POST /api/drivers": ADMIN_ONLY,
  "PATCH /api/drivers/:id": ADMIN_ONLY,
  "PATCH /api/drivers/:id/archive": ADMIN_ONLY,
  "GET /api/driver-schedule": { agent: false, driver: true, staff: "none" },
  // An agent's own schedule and districts: requireRole("agent"), so even admin has no business here.
  "GET /api/agent-schedule": { agent: true, driver: false, staff: "none", admin: false },
  "GET /api/agents": agentAnd("manage-accounts"),
  "POST /api/agents": ADMIN_ONLY,
  "PATCH /api/agents/:id": ADMIN_ONLY,
  "PATCH /api/agents/:id/archive": ADMIN_ONLY,
  "GET /api/trucks": agentAnd("delivery-operations", "order-fulfillment"),
  "POST /api/trucks": ADMIN_ONLY,
  "PATCH /api/trucks/:id": ADMIN_ONLY,
  "DELETE /api/trucks/:id": ADMIN_ONLY,

  // Orders (bookings) and invoices
  "GET /api/bookings": agentAnd("order-fulfillment"),
  "GET /api/agent-districts": { agent: true, driver: false, staff: "none", admin: false },
  // The handlers scope agents and staff to what they created; admin may touch anything.
  "POST /api/bookings": agentAnd("order-fulfillment"),
  "PATCH /api/bookings/:id/status": ADMIN_ONLY,
  "PATCH /api/bookings/:id/items": ADMIN_ONLY,
  "PATCH /api/bookings/:id/prepared-delivery-date": ADMIN_ONLY,
  "DELETE /api/bookings/:id": agentAnd("order-fulfillment"),
  "GET /api/invoices": agentAnd("order-fulfillment"),
  "GET /api/invoices/:id": agentAnd("order-fulfillment"),
  "POST /api/invoices": ADMIN_ONLY,
  "PATCH /api/invoices/:id/status": ADMIN_ONLY,
  "PATCH /api/invoices/:id/payment-status": ADMIN_ONLY,

  // Dashboard, forecast, reports
  "GET /api/dashboard/summary": staffOnly("dashboard"),
  "GET /api/sales/forecast": agentAnd("reports"),
  "POST /api/sales/forecast/chat": ADMIN_ONLY,
  "GET /api/product-costs": ADMIN_ONLY,
  "GET /api/reports/profit": staffOnly("reports"),
  "GET /api/reports/sales": staffOnly("reports"),
  "GET /api/reports/stock": staffOnly("reports"),
  "GET /api/reports/customers": staffOnly("reports"),

  // Deliveries
  "GET /api/deliveries": agentAnd("delivery-operations", "order-fulfillment"),
  "POST /api/deliveries": agentAnd("delivery-operations"),
  "PATCH /api/deliveries/:id/status": ADMIN_ONLY,
  "PATCH /api/deliveries/:id/assign": agentAnd("delivery-operations"),
  "PATCH /api/deliveries/:deliveryId/items/:itemId/status": ADMIN_ONLY,
  "DELETE /api/deliveries/:deliveryId/items/:itemId": ADMIN_ONLY,

  // Receipts. Reading is open to delivery-operations and accounting; the only writes are a driver's or
  // agent's confirm/payment on a stop (the handler checks it is their own) and accounting's verify.
  "GET /api/receipts": agentAnd("delivery-operations", "accounting"),
  // requirePermission("delivery:confirm") answers before any validation: admin, agent and driver reach
  // the handler (which then checks the stop is theirs); staff never do, whatever their modules.
  "POST /api/deliveries/:id/items/:itemId/confirm": { agent: true, driver: true, staff: "none" },
  "POST /api/deliveries/:id/items/:itemId/payment": { agent: true, driver: true, staff: "none" },

  // Accounting
  "GET /api/payments/unverified": staffOnly("accounting"),
  "GET /api/payments/agents": staffOnly("accounting"),
  "GET /api/payments/:id/receipt": staffOnly("accounting"),
  "GET /api/cash-remittances/collections": staffOnly("accounting"),
  "GET /api/cash-remittances/mine": { agent: true, driver: false, staff: "none", admin: false },
  "POST /api/cash-remittances": staffOnly("accounting"),
  "POST /api/payments/:id/verify": staffOnly("accounting"),
  "GET /api/expenses": staffOnly("accounting"),
  "POST /api/expenses": staffOnly("accounting"),
  "POST /api/expenses/:id/approve": ADMIN_ONLY,
  "POST /api/expenses/:id/reject": ADMIN_ONLY,
  "POST /api/expenses/:id/pay": staffOnly("accounting"),

  // Audit and backup
  "GET /api/audit-logs": staffOnly("administration"),
  "GET /api/backup": ADMIN_ONLY,

  // Accounts receivable and agent returns
  "GET /api/accounts-receivable": agentAnd("delivery-operations"),
  "GET /api/accounts-receivable/customer/:customerId": agentAnd("delivery-operations"),
  "PATCH /api/accounts-receivable/:id/status": ADMIN_ONLY,
  "PATCH /api/accounts-receivable/:id/notes": ADMIN_ONLY,
  "GET /api/agent-returns": agentAnd("delivery-operations"),
  "POST /api/agent-returns": agentAnd("delivery-operations"),
  "POST /api/agent-returns/:id/accept": ADMIN_ONLY,
  "POST /api/agent-returns/:id/reject": ADMIN_ONLY,

  // Maintenance requests: agents and drivers ask for any equipment and see their own; admin reviews all.
  "GET /api/maintenance-requests": { agent: true, driver: true, staff: "none" },
  "POST /api/maintenance-requests": { agent: true, driver: true, staff: "none" },
  "POST /api/maintenance-requests/:id/approve": ADMIN_ONLY,
  "POST /api/maintenance-requests/:id/reject": ADMIN_ONLY,

  // Inventory batches
  "GET /api/inventory-batches": agentAnd("order-fulfillment"),
  "GET /api/inventory-batches/:id": agentAnd("order-fulfillment"),
  "POST /api/inventory-batches": ADMIN_ONLY,
  "PATCH /api/inventory-batches/:id": ADMIN_ONLY,
  "DELETE /api/inventory-batches/:id": ADMIN_ONLY,
  "POST /api/inventory-batches/:id/items": ADMIN_ONLY,
  "DELETE /api/inventory-batches/:id/items/:itemId": ADMIN_ONLY,

  // Pallets (order preparation): order-fulfillment staff may start a pallet (POST) but only admin and
  // agents change its status or approve it; deleting is admin only.
  "GET /api/pallets": agentAnd("order-fulfillment"),
  "GET /api/pallets/:id": agentAnd("order-fulfillment"),
  "POST /api/pallets": agentAnd("order-fulfillment"),
  "PATCH /api/pallets/:id/status": { agent: true, driver: false, staff: "none" },
  "PATCH /api/pallets/:id/approve": { agent: true, driver: false, staff: "none" },
  "DELETE /api/pallets/:id": ADMIN_ONLY,
  "GET /api/products/inventory": agentAnd("product-customer", "order-fulfillment"),
  "GET /api/products/:productId/stock": agentAnd("product-customer", "order-fulfillment"),
  "GET /api/orders/:orderId/suggested-batches": agentAnd("order-fulfillment"),
};

interface Persona {
  name: string;
  /** Token user id; null for the anonymous caller. */
  userId: string | null;
  role?: "admin" | "staff" | "agent" | "driver";
  modules?: ModulePermission[];
}

const PERSONAS: Persona[] = [
  { name: "anonymous", userId: null },
  { name: "admin", userId: "test-admin", role: "admin" },
  { name: "staff (accounting only)", userId: "staff-accounting", role: "staff", modules: ["accounting"] },
  { name: "staff (order-fulfillment only)", userId: "staff-orders", role: "staff", modules: ["order-fulfillment"] },
  { name: "staff (delivery-operations only)", userId: "staff-delivery", role: "staff", modules: ["delivery-operations"] },
  { name: "staff (no modules)", userId: "staff-none", role: "staff", modules: [] },
  { name: "agent", userId: "test-agent", role: "agent" },
  { name: "driver", userId: "test-driver", role: "driver" },
];

function expectedAllowed(persona: Persona, policy: Policy): boolean {
  if (policy.public) return true;
  switch (persona.role) {
    case undefined:
      return false;
    case "admin":
      return policy.admin ?? true;
    case "agent":
      return policy.agent;
    case "driver":
      return policy.driver;
    case "staff":
      if (policy.staff === "any") return true;
      if (policy.staff === "none") return false;
      return policy.staff.some((module) => persona.modules?.includes(module));
  }
}

/** Every `METHOD /path` the express app registers, read from its router stack. */
function registeredRoutes(app: ReturnType<typeof createServer>): string[] {
  type Layer = { route?: { path: string; methods: Record<string, boolean> } };
  const stack = (app as unknown as { router: { stack: Layer[] } }).router.stack;
  const keys: string[] = [];
  for (const layer of stack) {
    if (!layer.route) continue;
    for (const method of Object.keys(layer.route.methods).filter((m) => layer.route!.methods[m])) {
      keys.push(`${method.toUpperCase()} ${layer.route.path}`);
    }
  }
  return keys;
}

const app = createServer();
const routes = registeredRoutes(app);

let server: Server;
let baseUrl: string;
const tokens = new Map<string, string>();
const quiet = vi.spyOn(console, "error").mockImplementation(() => undefined);

beforeAll(async () => {
  vi.stubEnv("DATABASE_URL", "postgres://unused-the-db-module-is-mocked");
  await seedUsers(db as never);
  const extra = PERSONAS.filter((p) => p.userId && !p.userId.startsWith("test-"));
  await db.insert(users).values(
    extra.map((p) => ({ id: p.userId!, username: p.userId!, password_hash: "x", role: p.role!, mfa_required: false })),
  );
  for (const persona of PERSONAS.filter((p) => p.modules)) {
    await db.update(users).set({ module_permissions: persona.modules }).where(eq(users.id, persona.userId!));
  }
  for (const persona of PERSONAS.filter((p) => p.userId)) {
    tokens.set(persona.name, signToken({ userId: persona.userId!, username: persona.userId!, role: persona.role! }));
  }

  server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  server?.closeAllConnections();
  await new Promise((resolve) => server?.close(resolve));
  quiet.mockRestore();
  vi.unstubAllEnvs();
});

async function call(persona: Persona, key: string): Promise<number> {
  const [method, path] = key.split(" ") as [Method, string];
  const url = baseUrl + path.replace(/:\w+/g, "dummy-id");
  const headers: Record<string, string> = {};
  const token = tokens.get(persona.name);
  if (token) headers.Authorization = `Bearer ${token}`;
  const init: RequestInit = { method, headers };
  if (method !== "GET") {
    headers["Content-Type"] = "application/json";
    init.body = "{}";
  }
  return (await fetch(url, init)).status;
}

describe("role by endpoint matrix", () => {
  it("has a policy entry for every registered route and no stale ones", () => {
    expect(routes.length).toBeGreaterThan(80);
    expect([...routes].sort()).toEqual(Object.keys(POLICY).sort());
  });

  const keys = Object.keys(POLICY);
  for (const persona of PERSONAS) {
    describe(persona.name, () => {
      it.each(keys)("%s", async (key) => {
        const policy = POLICY[key];
        const status = await call(persona, key);
        if (policy.public) {
          // Token or not, the handler answers the same way; none of these routes check a role.
          expect(status, `${key} as ${persona.name}`).toBe(await call(PERSONAS[0], key));
          expect(status).not.toBe(403);
          return;
        }
        const denied = status === 401 || status === 403;
        expect(denied, `${key} as ${persona.name} answered ${status}`).toBe(!expectedAllowed(persona, policy));
      });
    });
  }

  // The module guard compares prefixes literally while express matches paths loosely; odd spellings
  // of a guarded path must never let a staff account without the module through.
  it.each(["/api/Customers", "/api/CUSTOMERS/", "/api/customers/?x=1", "/api/Expenses", "/api//expenses"])(
    "keeps staff without the module out of %s",
    async (path) => {
      const res = await fetch(baseUrl + path, { headers: { Authorization: `Bearer ${tokens.get("staff (no modules)")}` } });
      expect([401, 403, 404]).toContain(res.status);
    },
  );
});
