import type { Request, Response, NextFunction } from "express";
import { verifyToken, type TokenPayload } from "../auth";
import { db } from "../db";
import { users } from "../db/schema";
import { eq } from "drizzle-orm";
import type { ModulePermission } from "@shared/api";

export interface AuthRequest extends Request {
  user?: TokenPayload;
  modulePermissions?: string[];
}

const DRIVER_ALLOWED_PATHS = new Set([
  "/api/driver-schedule",
  "/api/maintenance-requests",
  "/api/auth/refresh",
]);

// The only writes a driver makes: confirming a stop and recording payment on it. The handlers
// themselves check that the stop belongs to the driver's own run.
const DRIVER_STOP_ACTION = /^\/api\/deliveries\/[^/]+\/items\/[^/]+\/(confirm|payment)$/;

function driverMayReach(req: Request) {
  const path = `${req.baseUrl}${req.path}`;
  return DRIVER_ALLOWED_PATHS.has(path) || (req.method === "POST" && DRIVER_STOP_ACTION.test(path));
}

export async function authMiddleware(
  req: AuthRequest,
  res: Response,
  next: NextFunction
) {
  // Routes run this after the global /api guard already did; don't verify twice.
  if (req.user) return next();

  const token = req.headers.authorization?.split(" ")[1];

  if (!token) {
    return res.status(401).json({ error: "No token provided" });
  }

  const payload = verifyToken(token);
  if (!payload) {
    return res.status(401).json({ error: "Invalid token" });
  }

  // Compare the full path: under app.use("/api", ...) req.path has the mount stripped.
  if (payload.role === "driver" && !driverMayReach(req)) {
    return res.status(403).json({ error: "Insufficient permissions" });
  }

  // A token lives 24h. Re-check the account on every request so deleting an
  // account or changing its role takes effect immediately (one PK lookup).
  if (process.env.DATABASE_URL) {
    try {
      const [account] = await db
        .select({ role: users.role, module_permissions: users.module_permissions, is_archived: users.is_archived })
        .from(users)
        .where(eq(users.id, payload.userId))
        .limit(1);
      if (!account) return res.status(401).json({ error: "This account no longer exists. Please sign in again." });
      if (account.is_archived) return res.status(401).json({ error: "This account has been archived. Contact an administrator." });
      if (account.role !== payload.role) {
        return res.status(401).json({ error: "Your access has changed. Please sign in again." });
      }
      if (payload.role === "staff") req.modulePermissions = account.module_permissions;
    } catch (error) {
      console.error("Account check failed:", error);
      return res.status(503).json({ error: "Sign-in could not be verified. Try again shortly." });
    }
  }

  req.user = payload;
  next();
}

export function requireModuleAccess(module: ModulePermission) {
  return (req: AuthRequest, res: Response, next: NextFunction) => {
    if (req.user?.role === "staff" && !req.modulePermissions?.includes(module)) {
      return res.status(403).json({ error: "Module access denied" });
    }
    next();
  };
}

export function requireRole(...roles: Array<"admin" | "agent" | "driver" | "staff">) {
  return (req: AuthRequest, res: Response, next: NextFunction) => {
    if (!req.user) {
      return res.status(401).json({ error: "Not authenticated" });
    }

    if (!roles.includes(req.user.role)) {
      return res.status(403).json({ error: "Insufficient permissions" });
    }

    next();
  };
}
