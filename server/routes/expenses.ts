import type { RequestHandler } from "express";
import { randomUUID } from "crypto";
import { and, desc, eq, ne } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { CreateExpenseSchema, MAINTENANCE_EXPENSE_CATEGORY } from "../../shared/api";
import { db } from "../db";
import { expenses, users } from "../db/schema";
import type { AuthRequest } from "../middleware/auth";
import { logAction } from "../middleware/audit-logger";

// Expense workflow: accounting (or admin) submits, a different admin approves or rejects, and an
// accounting user other than the approver pays. Every actor and timestamp comes from the token user,
// never from the request body, and every transition is a conditional update on the expected current
// status so concurrent calls cannot both succeed.
//
// Permission checks (`expense:submit|approve|pay`) are applied by requirePermission in server/index.ts.

const submitter = alias(users, "submitter");
const approver = alias(users, "approver");
const payer = alias(users, "payer");

function expenseSummary(row: typeof expenses.$inferSelect) {
  return {
    status: row.status,
    approved_by: row.approved_by,
    approved_at: row.approved_at,
    paid_by: row.paid_by,
    paid_at: row.paid_at,
    reject_reason: row.reject_reason,
  };
}

function isMaintenanceOnlyRole(role: string | undefined): boolean {
  return role === "agent" || role === "driver";
}

function nonEmpty(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

// ─── GET /api/expenses ────────────────────────────────────────────────────────

export const listExpenses: RequestHandler = async (req: AuthRequest, res) => {
  try {
    if (!process.env.DATABASE_URL) return res.json({ expenses: [] });

    const maintenanceOnly = isMaintenanceOnlyRole(req.user?.role);
    const rows = await db
      .select({
        expense: expenses,
        submitted_by_name: submitter.username,
        approved_by_name: approver.username,
        paid_by_name: payer.username,
      })
      .from(expenses)
      .leftJoin(submitter, eq(submitter.id, expenses.submitted_by))
      .leftJoin(approver, eq(approver.id, expenses.approved_by))
      .leftJoin(payer, eq(payer.id, expenses.paid_by))
      .where(
        maintenanceOnly
          ? and(eq(expenses.submitted_by, req.user!.userId), eq(expenses.category, MAINTENANCE_EXPENSE_CATEGORY))
          : undefined,
      )
      .orderBy(desc(expenses.created_at), desc(expenses.id));

    res.json({
      expenses: rows.map((row) => ({
        ...row.expense,
        submitted_by_name: row.submitted_by_name,
        approved_by_name: row.approved_by_name,
        paid_by_name: row.paid_by_name,
      })),
    });
  } catch (error) {
    console.error("Error fetching expenses:", error);
    res.status(500).json({ error: "Internal server error" });
  }
};

// ─── POST /api/expenses ───────────────────────────────────────────────────────

export const createExpense: RequestHandler = async (req: AuthRequest, res) => {
  if (!req.user) return res.status(401).json({ error: "Authentication required" });
  if (!process.env.DATABASE_URL) return res.status(503).json({ error: "Database not configured" });

  const body = (req.body ?? {}) as Record<string, unknown>;
  const category = nonEmpty(body.category);
  const description = nonEmpty(body.description);
  if (!category) return res.status(400).json({ error: "Category is required" });
  if (!description) return res.status(400).json({ error: "Description is required" });
  if (isMaintenanceOnlyRole(req.user.role) && category !== MAINTENANCE_EXPENSE_CATEGORY) {
    return res.status(403).json({ error: "You can only submit maintenance expenses" });
  }

  // Amounts arrive as decimal strings; a plain JSON number is accepted too.
  const rawAmount = typeof body.amount === "number" && Number.isFinite(body.amount) ? String(body.amount) : body.amount;
  const parsed = CreateExpenseSchema.shape.amount.safeParse(rawAmount);
  if (!parsed.success) {
    return res.status(400).json({ error: "Amount must be a number greater than zero with at most 2 decimal places" });
  }

  try {
    const [expense] = await db
      .insert(expenses)
      .values({
        id: randomUUID(),
        category,
        description,
        amount: parsed.data,
        status: "submitted",
        submitted_by: req.user.userId,
      })
      .returning();

    await logAction(req.user.userId, "submit", "expense", expense.id, undefined, {
      category: expense.category,
      amount: expense.amount,
      status: expense.status,
      submitted_by: expense.submitted_by,
    });

    res.status(201).json({ expense });
  } catch (error) {
    console.error("Error creating expense:", error);
    res.status(500).json({ error: "Internal server error" });
  }
};

// ─── POST /api/expenses/:id/approve and /reject ───────────────────────────────

type ReviewDecision = "approve" | "reject";

function reviewExpense(decision: ReviewDecision): RequestHandler {
  return async (req: AuthRequest, res) => {
    const { id } = req.params;
    if (!req.user) return res.status(401).json({ error: "Authentication required" });
    if (!process.env.DATABASE_URL) return res.status(503).json({ error: "Database not configured" });

    const reason = nonEmpty(((req.body ?? {}) as Record<string, unknown>).reject_reason);
    if (decision === "reject" && !reason) {
      return res.status(400).json({ error: "A reason is required to reject an expense" });
    }

    const userId = req.user.userId;
    const verb = decision === "approve" ? "approved" : "rejected";
    try {
      const [existing] = await db.select().from(expenses).where(eq(expenses.id, id));
      if (!existing) return res.status(404).json({ error: "Expense not found" });
      if (existing.status !== "submitted") {
        return res.status(409).json({ error: `Only a submitted expense can be ${verb}` });
      }
      const selfReviewAllowed = existing.category === MAINTENANCE_EXPENSE_CATEGORY;
      if (existing.submitted_by === userId && !selfReviewAllowed) {
        return res.status(409).json({ error: `You cannot ${decision} an expense you submitted` });
      }

      const now = new Date();
      // Conditional on still being submitted (and not ours, unless it is maintenance), so simultaneous decisions cannot both win.
      const updated = await db
        .update(expenses)
        .set(
          decision === "approve"
            ? { status: "approved", approved_by: userId, approved_at: now, updated_at: now }
            : { status: "rejected", approved_by: userId, approved_at: now, reject_reason: reason, updated_at: now },
        )
        .where(and(eq(expenses.id, id), eq(expenses.status, "submitted"), selfReviewAllowed ? undefined : ne(expenses.submitted_by, userId)))
        .returning();

      if (updated.length === 0) {
        return res.status(409).json({ error: `This expense can no longer be ${verb}` });
      }
      const [expense] = updated;

      await logAction(userId, decision, "expense", id, expenseSummary(existing), expenseSummary(expense));

      res.json({ expense });
    } catch (error) {
      console.error(`Error trying to ${decision} expense:`, error);
      res.status(500).json({ error: "Internal server error" });
    }
  };
}

export const approveExpense = reviewExpense("approve");
export const rejectExpense = reviewExpense("reject");

// ─── POST /api/expenses/:id/pay ───────────────────────────────────────────────

export const payExpense: RequestHandler = async (req: AuthRequest, res) => {
  const { id } = req.params;
  if (!req.user) return res.status(401).json({ error: "Authentication required" });
  if (!process.env.DATABASE_URL) return res.status(503).json({ error: "Database not configured" });

  const userId = req.user.userId;
  try {
    const [existing] = await db.select().from(expenses).where(eq(expenses.id, id));
    if (!existing) return res.status(404).json({ error: "Expense not found" });
    if (existing.status !== "approved") {
      return res.status(409).json({ error: "Only an approved expense can be paid" });
    }
    if (existing.approved_by === userId) {
      return res.status(409).json({ error: "You cannot pay an expense you approved" });
    }

    const now = new Date();
    // Conditional on still being approved (by someone else), so simultaneous payments cannot both win.
    const updated = await db
      .update(expenses)
      .set({ status: "paid", paid_by: userId, paid_at: now, updated_at: now })
      .where(and(eq(expenses.id, id), eq(expenses.status, "approved"), ne(expenses.approved_by, userId)))
      .returning();

    if (updated.length === 0) return res.status(409).json({ error: "This expense can no longer be paid" });
    const [expense] = updated;

    await logAction(userId, "pay", "expense", id, expenseSummary(existing), expenseSummary(expense));

    res.json({ expense });
  } catch (error) {
    console.error("Error paying expense:", error);
    res.status(500).json({ error: "Internal server error" });
  }
};
