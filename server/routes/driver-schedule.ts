import type { RequestHandler } from "express";
import { eq, isNotNull, ne } from "drizzle-orm";
import { db } from "../db";
import { accounts_receivable, delivery_items, deliveries, drivers } from "../db/schema";
import type { AuthRequest } from "../middleware/auth";
import { isIsoDate, todayIsoDate } from "../services/schedule-date";

export const getDriverSchedule: RequestHandler = async (req: AuthRequest, res) => {
  const unconfirmedOnly = req.query.scope === "unconfirmed";
  const date = typeof req.query.date === "string" ? req.query.date : todayIsoDate();
  if (!unconfirmedOnly && !isIsoDate(date)) {
    return res.status(400).json({ error: "date must be YYYY-MM-DD" });
  }

  try {
    let driverId: string | undefined;

    if (req.user?.role === "driver") {
      const profile = await db.query.drivers.findFirst({
        where: eq(drivers.user_id, req.user.userId),
      });
      if (!profile) {
        return res.status(404).json({ error: "Driver profile not found" });
      }
      driverId = profile.id;
    } else {
      driverId = typeof req.query.driver_id === "string" ? req.query.driver_id : undefined;
      if (!driverId) {
        return res.status(400).json({ error: "driver_id is required" });
      }
    }

    const driver = await db.query.drivers.findFirst({
      where: eq(drivers.id, driverId),
      columns: { id: true, full_name: true },
    });
    if (!driver) {
      return res.status(404).json({ error: "Driver not found" });
    }

    const scheduledRuns = await db.query.deliveries.findMany({
      where: unconfirmedOnly
        ? isNotNull(deliveries.scheduled_date)
        : eq(deliveries.scheduled_date, date),
      with: {
        truck: true,
        delivery_items: {
          where: unconfirmedOnly ? ne(delivery_items.status, "completed") : undefined,
          with: {
            destination_customer: true,
            invoice: { with: { invoice_items: true } },
            accounts_receivable: { where: eq(accounts_receivable.status, "outstanding") },
          },
        },
      },
    });
    const runs = scheduledRuns
      .filter((run) => (run.driver_id ?? run.truck.driver_id) === driverId)
      .map(({ delivery_items: stops, ...run }) => ({
        ...run,
        delivery_items: stops.map(({ accounts_receivable: receivables, ...stop }) => ({
          ...stop,
          outstanding_amount: receivables.reduce((sum, record) => sum + Number(record.amount_due), 0),
        })),
      }))
      .filter((run) => !unconfirmedOnly || run.delivery_items.length > 0);

    res.json({ date: unconfirmedOnly ? null : date, driver, deliveries: runs });
  } catch (error) {
    console.error("Error fetching driver schedule:", error);
    res.status(500).json({ error: "Internal server error" });
  }
};
