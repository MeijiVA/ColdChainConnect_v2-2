import type { RequestHandler } from "express";
import { randomUUID } from "crypto";
import { and, eq } from "drizzle-orm";
import { db } from "../db";
import { users } from "../db/schema";
import { hashPassword, signToken } from "../auth";
import { modulePermissionKeys } from "../../shared/api";
import type { DemoLoginRequest, LoginResponse } from "@shared/api";

/**
 * Passwordless sign-in for the public demo deployment.
 *
 * Off unless DEMO_ROLE_PICKER=true is set on that deployment, so the real app (which never sets it)
 * answers 404 here. Only staff and agent accounts can be picked: admin and driver never can.
 * Point a deployment that turns this on at a demo database, never at real customer data.
 */
export const demoRolePickerEnabled = () => process.env.DEMO_ROLE_PICKER === "true";

const demoStaffUsername = () => process.env.DEMO_STAFF_USERNAME || "demo-staff";
const demoAgentUsername = () => process.env.DEMO_AGENT_USERNAME || "agent1";

type UserRow = typeof users.$inferSelect;

async function findAccount(username: string, role: "staff" | "agent"): Promise<UserRow | undefined> {
  return db.query.users.findFirst({
    where: and(eq(users.username, username), eq(users.role, role), eq(users.is_archived, false)),
  });
}

/** The demo staff account sees every module. It is created on first use, with a password nobody knows. */
async function findOrCreateDemoStaff(): Promise<UserRow | undefined> {
  const username = demoStaffUsername();
  const existing = await findAccount(username, "staff");
  if (existing) return existing;

  await db
    .insert(users)
    .values({
      id: randomUUID(),
      username,
      password_hash: await hashPassword(randomUUID()),
      role: "staff",
      mfa_required: false,
      module_permissions: [...modulePermissionKeys],
    })
    .onConflictDoNothing();

  // If the username is taken by a non-staff or archived account, this finds nothing and the caller reports it.
  return findAccount(username, "staff");
}

export const handleDemoLogin: RequestHandler = async (req, res) => {
  if (!demoRolePickerEnabled()) {
    return res.status(404).json({ error: "Not found" });
  }

  const role = (req.body as Partial<DemoLoginRequest> | undefined)?.role;
  if (role !== "staff" && role !== "agent") {
    return res.status(400).json({ error: "Choose a staff or agent account" });
  }

  if (!process.env.DATABASE_URL) {
    return res.status(503).json({ error: "The demo has no database configured." });
  }

  try {
    const user = role === "staff" ? await findOrCreateDemoStaff() : await findAccount(demoAgentUsername(), "agent");
    if (!user) {
      return res.status(503).json({
        error:
          role === "staff"
            ? `The demo staff account "${demoStaffUsername()}" could not be created.`
            : `The demo agent account "${demoAgentUsername()}" was not found. Seed the demo database first.`,
      });
    }

    const token = signToken({ userId: user.id, username: user.username, role: user.role });
    res.json({
      token,
      user: { id: user.id, username: user.username, role: user.role, module_permissions: user.module_permissions },
    } as LoginResponse);
  } catch (error) {
    console.error("Demo login error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
};
