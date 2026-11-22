import type { RequestHandler } from "express";
import { randomUUID } from "crypto";
import { and, desc, eq } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { CreateMaintenanceRequestSchema } from "../../shared/api";
import { db } from "../db";
import { maintenance_requests, users } from "../db/schema";
import type { AuthRequest } from "../middleware/auth";
import { logAction } from "../middleware/audit-logger";

// Agents and drivers request maintenance; admins review it, including their own requests.
// Permission checks (`maintenance:request|decide`) are applied by the routes in server/index.ts.

const requester = alias(users, "requester");
const reviewer = alias(users, "reviewer");

function requestSummary(row: typeof maintenance_requests.$inferSelect) {
  return { status: row.status, reviewed_by: row.reviewed_by, reviewed_at: row.reviewed_at, reject_reason: row.reject_reason };
}

// ─── GET /api/maintenance-requests ────────────────────────────────────────────

export const listMaintenanceRequests: RequestHandler = async (req: AuthRequest, res) => {
  if (!req.user) return res.status(401).json({ error: "Authentication required" });
  if (!process.env.DATABASE_URL) return res.json({ requests: [] });

  try {
    const isAdmin = req.user.role === "admin";
    const rows = await db
      .select({
        request: maintenance_requests,
        requested_by_name: requester.username,
        reviewed_by_name: reviewer.username,
      })
      .from(maintenance_requests)
      .leftJoin(requester, eq(requester.id, maintenance_requests.requested_by))
      .leftJoin(reviewer, eq(reviewer.id, maintenance_requests.reviewed_by))
      .where(isAdmin ? undefined : eq(maintenance_requests.requested_by, req.user.userId))
      .orderBy(desc(maintenance_requests.created_at), desc(maintenance_requests.id));

    res.json({
      requests: rows.map((row) => ({
        ...row.request,
        requested_by_name: row.requested_by_name,
        reviewed_by_name: row.reviewed_by_name,
      })),
    });
  } catch (error) {
    console.error("Error fetching maintenance requests:", error);
    res.status(500).json({ error: "Internal server error" });
  }
};

// ─── POST /api/maintenance-requests ───────────────────────────────────────────

export const createMaintenanceRequest: RequestHandler = async (req: AuthRequest, res) => {
  if (!req.user) return res.status(401).json({ error: "Authentication required" });
  if (!process.env.DATABASE_URL) return res.status(503).json({ error: "Database not configured" });

  const parsed = CreateMaintenanceRequestSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.issues[0]?.message ?? "Invalid maintenance request" });
  }

  try {
    const [request] = await db
      .insert(maintenance_requests)
      .values({
        id: randomUUID(),
        asset: parsed.data.asset,
        description: parsed.data.description,
        estimated_cost: parsed.data.estimated_cost == null ? null : parsed.data.estimated_cost.toFixed(2),
        status: "submitted",
        requested_by: req.user.userId,
      })
      .returning();

    await logAction(req.user.userId, "submit", "maintenance_request", request.id, undefined, requestSummary(request));

    res.status(201).json({ request });
  } catch (error) {
    console.error("Error creating maintenance request:", error);
    res.status(500).json({ error: "Internal server error" });
  }
};

// ─── POST /api/maintenance-requests/:id/approve and /reject ───────────────────

type ReviewDecision = "approve" | "reject";

function reviewMaintenanceRequest(decision: ReviewDecision): RequestHandler {
  return async (req: AuthRequest, res) => {
    const { id } = req.params;
    if (!req.user) return res.status(401).json({ error: "Authentication required" });
    if (!process.env.DATABASE_URL) return res.status(503).json({ error: "Database not configured" });

    const rawReason = ((req.body ?? {}) as Record<string, unknown>).reject_reason;
    const reason = typeof rawReason === "string" && rawReason.trim() ? rawReason.trim() : null;
    if (decision === "reject" && !reason) {
      return res.status(400).json({ error: "A reason is required to reject a maintenance request" });
    }

    const userId = req.user.userId;
    const verb = decision === "approve" ? "approved" : "rejected";
    try {
      const [existing] = await db.select().from(maintenance_requests).where(eq(maintenance_requests.id, id));
      if (!existing) return res.status(404).json({ error: "Maintenance request not found" });
      if (existing.status !== "submitted") {
        return res.status(409).json({ error: `Only a submitted request can be ${verb}` });
      }

      const now = new Date();
      const updated = await db
        .update(maintenance_requests)
        .set({
          status: decision === "approve" ? "approved" : "rejected",
          reviewed_by: userId,
          reviewed_at: now,
          reject_reason: decision === "reject" ? reason : null,
          updated_at: now,
        })
        .where(and(eq(maintenance_requests.id, id), eq(maintenance_requests.status, "submitted")))
        .returning();

      if (updated.length === 0) {
        return res.status(409).json({ error: `This request can no longer be ${verb}` });
      }
      const [request] = updated;

      await logAction(userId, decision, "maintenance_request", id, requestSummary(existing), requestSummary(request));

      res.json({ request });
    } catch (error) {
      console.error(`Error trying to ${decision} maintenance request:`, error);
      res.status(500).json({ error: "Internal server error" });
    }
  };
}

export const approveMaintenanceRequest = reviewMaintenanceRequest("approve");
export const rejectMaintenanceRequest = reviewMaintenanceRequest("reject");
