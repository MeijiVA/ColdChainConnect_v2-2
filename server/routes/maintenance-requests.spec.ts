// Maintenance requests: agents and drivers ask for work on any equipment, admins review every request
// (including their own). Runs against the in-memory Postgres harness; the shared database is never touched.
import { beforeAll, afterAll, describe, expect, it, vi } from "vitest";
import type { Request, RequestHandler, Response } from "express";
import { eq } from "drizzle-orm";
import { db } from "../db";
import { audit_logs, maintenance_requests, users } from "../db/schema";
import type { AuthRequest } from "../middleware/auth";
import { requireAnyPermission, requirePermission } from "../middleware/permissions";
import {
  approveMaintenanceRequest,
  createMaintenanceRequest,
  listMaintenanceRequests,
  rejectMaintenanceRequest,
} from "./maintenance-requests";
import { seedUsers } from "../test/test-db";

vi.mock("../db", async () => {
  const { createTestDb: create } = await import("../test/test-db");
  return { db: (await create()).db };
});

type Role = "admin" | "staff" | "agent" | "driver";
let seeded: Awaited<ReturnType<typeof seedUsers>>;

beforeAll(async () => {
  vi.stubEnv("DATABASE_URL", "postgres://unused-the-db-module-is-mocked");
  seeded = await seedUsers(db as never);
  // `staff` holds the accounting module; accounting must not reach maintenance at all.
  await db.update(users).set({ module_permissions: ["accounting"] }).where(eq(users.id, seeded.staff.id));
  await db.insert(users).values({ id: "admin-2", username: "second_admin", password_hash: "x", role: "admin", mfa_required: false });
});

afterAll(() => {
  vi.unstubAllEnvs();
});

function reqFor(role: Role, userId: string, params: Record<string, string> = {}, body: unknown = {}, modulePermissions?: string[]): AuthRequest {
  return { user: { userId, username: userId, role }, modulePermissions, query: {}, params, body } as unknown as AuthRequest;
}

async function run(chain: RequestHandler[], req: AuthRequest) {
  let status = 200;
  let body: unknown;
  let responded = false;
  const res = {
    status(code: number) {
      status = code;
      return res;
    },
    json(payload: unknown) {
      body = payload;
      responded = true;
      return res;
    },
  } as unknown as Response;
  for (const handler of chain) {
    let advanced = false;
    await handler(req as Request, res, () => {
      advanced = true;
    });
    if (responded || !advanced) break;
  }
  return { status, body };
}

const agent = (params: Record<string, string> = {}, body: unknown = {}) => reqFor("agent", seeded.agent.id, params, body);
const driver = (params: Record<string, string> = {}, body: unknown = {}) => reqFor("driver", seeded.driver.id, params, body);
const admin = (params: Record<string, string> = {}, body: unknown = {}) => reqFor("admin", seeded.admin.id, params, body);
const admin2 = (params: Record<string, string> = {}, body: unknown = {}) => reqFor("admin", "admin-2", params, body);
const accounting = (params: Record<string, string> = {}, body: unknown = {}) => reqFor("staff", seeded.staff.id, params, body, ["accounting"]);

const list = [requireAnyPermission("maintenance:request", "maintenance:decide"), listMaintenanceRequests];
const create = [requirePermission("maintenance:request"), createMaintenanceRequest];
const approve = [requirePermission("maintenance:decide"), approveMaintenanceRequest];
const reject = [requirePermission("maintenance:decide"), rejectMaintenanceRequest];

type Row = { id: string } & Record<string, unknown>;
const valid = { asset: "Walk-in freezer compressor", description: "Compressor is making a grinding noise" };

async function submit(by: AuthRequest = agent(), body: unknown = valid): Promise<string> {
  const { status, body: created } = await run(create, Object.assign(by, { body }));
  expect(status).toBe(201);
  return (created as { request: Row }).request.id;
}

describe("POST /api/maintenance-requests", () => {
  it("lets an agent submit a request for any equipment, with the requester taken from the token", async () => {
    const req = agent({}, { ...valid, requested_by: seeded.admin.id, status: "approved", reviewed_by: seeded.admin.id });
    const { status, body } = await run(create, req);
    expect(status).toBe(201);
    expect((body as { request: Row }).request).toMatchObject({
      asset: "Walk-in freezer compressor",
      description: valid.description,
      status: "submitted",
      requested_by: seeded.agent.id,
      reviewed_by: null,
      reviewed_at: null,
    });
  });

  it("lets a driver submit a request for a delivery truck", async () => {
    const { status, body } = await run(create, driver({}, { asset: "Truck TRK-07 tail lift", description: "Hydraulic leak" }));
    expect(status).toBe(201);
    expect((body as { request: Row }).request).toMatchObject({ requested_by: seeded.driver.id, status: "submitted" });
  });

  it("lets admin submit a request, which admin can then approve", async () => {
    const id = await submit(admin());
    expect((await run(approve, admin({ id }))).status).toBe(200);
  });

  it("audit-logs the submission", async () => {
    const id = await submit();
    const [entry] = await db.select().from(audit_logs).where(eq(audit_logs.resource_id, id));
    expect(entry).toMatchObject({ user_id: seeded.agent.id, action: "submit", resource_type: "maintenance_request" });
    expect(JSON.parse(entry.after_state!)).toMatchObject({ status: "submitted" });
  });

  it.each([
    ["an empty asset", { ...valid, asset: "   " }],
    ["a missing asset", { description: "x" }],
    ["an asset over 120 characters", { ...valid, asset: "a".repeat(121) }],
    ["an empty description", { ...valid, description: "" }],
    ["a missing description", { asset: "Pallet jack" }],
  ])("rejects %s with 400", async (_label, body) => {
    expect((await run(create, agent({}, body))).status).toBe(400);
  });

  it("denies accounting staff, even with the accounting module", async () => {
    expect((await run(create, accounting({}, valid))).status).toBe(403);
  });
});

describe("GET /api/maintenance-requests", () => {
  it("shows an agent or driver only their own requests", async () => {
    const mine = await submit(agent());
    const theirs = await submit(driver());

    const agentRows = (await run(list, agent())).body as { requests: Row[] };
    const agentIds = agentRows.requests.map((r) => r.id);
    expect(agentIds).toContain(mine);
    expect(agentIds).not.toContain(theirs);
    expect(agentRows.requests.every((r) => r.requested_by === seeded.agent.id)).toBe(true);

    const driverRows = (await run(list, driver())).body as { requests: Row[] };
    expect(driverRows.requests.map((r) => r.id)).toContain(theirs);
    expect(driverRows.requests.map((r) => r.id)).not.toContain(mine);
  });

  it("shows admin every request with requester and reviewer names, newest first", async () => {
    const id = await submit(agent());
    await run(approve, admin({ id }));

    const { status, body } = await run(list, admin());
    expect(status).toBe(200);
    const rows = (body as { requests: Row[] }).requests;
    expect(rows.map((r) => r.id)).toEqual(expect.arrayContaining([id]));
    expect(rows.find((r) => r.id === id)).toMatchObject({
      status: "approved",
      requested_by_name: "test_agent",
      reviewed_by_name: "test_admin",
    });
    const times = rows.map((r) => new Date(r.created_at as string).getTime());
    expect(times).toEqual([...times].sort((a, b) => b - a));
  });

  it("is denied to accounting staff", async () => {
    expect((await run(list, accounting())).status).toBe(403);
  });
});

describe("POST /api/maintenance-requests/:id/approve", () => {
  it("lets admin approve a request from another user, recording the reviewer and time", async () => {
    const id = await submit(agent());
    const { status, body } = await run(approve, admin({ id }));
    expect(status).toBe(200);
    expect((body as { request: Row }).request).toMatchObject({ id, status: "approved", reviewed_by: seeded.admin.id });
    expect((body as { request: Row }).request.reviewed_at).toBeTruthy();
  });

  it("lets admin approve their own request", async () => {
    const id = await submit(admin());
    const { status, body } = await run(approve, admin({ id }));
    expect(status).toBe(200);
    expect((body as { request: Row }).request).toMatchObject({ status: "approved", requested_by: seeded.admin.id, reviewed_by: seeded.admin.id });
  });

  it("audit-logs the approval with the before and after state", async () => {
    const id = await submit();
    await run(approve, admin({ id }));
    const entries = await db.select().from(audit_logs).where(eq(audit_logs.resource_id, id));
    const entry = entries.find((e) => e.action === "approve");
    expect(entry).toMatchObject({ user_id: seeded.admin.id, resource_type: "maintenance_request" });
    expect(JSON.parse(entry!.before_state!)).toMatchObject({ status: "submitted" });
    expect(JSON.parse(entry!.after_state!)).toMatchObject({ status: "approved", reviewed_by: seeded.admin.id });
  });

  it("answers 409 unless the request is still submitted", async () => {
    const id = await submit();
    expect((await run(approve, admin({ id }))).status).toBe(200);
    expect((await run(approve, admin2({ id }))).status).toBe(409);
    const rejected = await submit();
    await run(reject, admin({ id: rejected }, { reject_reason: "Not needed" }));
    expect((await run(approve, admin({ id: rejected }))).status).toBe(409);
  });

  it("answers 404 for an unknown request", async () => {
    expect((await run(approve, admin({ id: "nope" }))).status).toBe(404);
  });

  it("denies agents, drivers and accounting staff", async () => {
    const id = await submit();
    for (const req of [agent({ id }), driver({ id }), accounting({ id })]) {
      expect((await run(approve, req)).status).toBe(403);
    }
    const [row] = await db.select().from(maintenance_requests).where(eq(maintenance_requests.id, id));
    expect(row.status).toBe("submitted");
  });

  it("does not let two simultaneous approvals both succeed", async () => {
    const id = await submit();
    const results = await Promise.all([run(approve, admin({ id })), run(approve, admin2({ id }))]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
    const entries = await db.select().from(audit_logs).where(eq(audit_logs.resource_id, id));
    expect(entries.filter((e) => e.action === "approve")).toHaveLength(1);
  });
});

describe("POST /api/maintenance-requests/:id/reject", () => {
  it("rejects with the reason, recording the reviewer", async () => {
    const id = await submit();
    const { status, body } = await run(reject, admin({ id }, { reject_reason: "Covered by warranty, contact vendor" }));
    expect(status).toBe(200);
    expect((body as { request: Row }).request).toMatchObject({
      id,
      status: "rejected",
      reject_reason: "Covered by warranty, contact vendor",
      reviewed_by: seeded.admin.id,
    });
  });

  it("lets admin reject their own request", async () => {
    const id = await submit(admin());
    expect((await run(reject, admin({ id }, { reject_reason: "Duplicate" }))).status).toBe(200);
  });

  it("requires a non-empty reason (400)", async () => {
    const id = await submit();
    expect((await run(reject, admin({ id }, {}))).status).toBe(400);
    expect((await run(reject, admin({ id }, { reject_reason: "   " }))).status).toBe(400);
    const [row] = await db.select().from(maintenance_requests).where(eq(maintenance_requests.id, id));
    expect(row.status).toBe("submitted");
  });

  it("answers 409 once the request has been decided", async () => {
    const id = await submit();
    await run(approve, admin({ id }));
    expect((await run(reject, admin2({ id }, { reject_reason: "x" }))).status).toBe(409);
  });

  it("denies agents, drivers and accounting staff", async () => {
    const id = await submit();
    for (const req of [agent({ id }, { reject_reason: "x" }), driver({ id }, { reject_reason: "x" }), accounting({ id }, { reject_reason: "x" })]) {
      expect((await run(reject, req)).status).toBe(403);
    }
  });
});
