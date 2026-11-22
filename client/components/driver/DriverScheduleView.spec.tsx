// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { DriverSchedule } from "@shared/api";
import { useAuth } from "@/hooks/useAuth";
import { DriverScheduleView } from "./DriverScheduleView";

const schedule = (status: "pending" | "completed"): DriverSchedule => ({
  date: "2026-11-19",
  driver: { id: "drv-1", full_name: "Dan Driver" },
  deliveries: [
    {
      id: "del-1",
      scheduled_date: "2026-11-19",
      status: "pending",
      truck: { id: "t1", license_plate: "AAA-111", district: "d" },
      delivery_items: [
        {
          id: "item-1",
          delivery_id: "del-1",
          status,
          is_paid: status === "completed",
          outstanding_amount: 0,
          destination_customer: {
            id: "c1", store_name: "Corner Store", location: "Manila", street_address: null,
            latitude: null, longitude: null, contact_person: null, contact_info: null,
          },
          invoice: { id: "inv-1", receipt_number: "INV-1", total_amount: "250.00", payment_status: "unpaid", invoice_items: [] },
        },
      ],
    },
  ],
});

const json = (body: unknown, ok = true) => ({ ok, status: ok ? 200 : 400, json: async () => body });
const fetchMock = vi.fn();

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
  useAuth.setState({ user: { id: "u1", username: "driver", role: "driver" }, token: "driver-token" });
});

afterEach(() => {
  cleanup();
  useAuth.setState({ user: null, token: null });
  vi.unstubAllGlobals();
});

describe("DriverScheduleView", () => {
  it("reloads the schedule after a stop is confirmed", async () => {
    let scheduleCalls = 0;
    fetchMock.mockImplementation(async (url: string) => {
      if (url.startsWith("/api/driver-schedule")) return json(schedule(++scheduleCalls === 1 ? "pending" : "completed"));
      return json({}); // the confirm POST
    });
    render(<DriverScheduleView />);

    fireEvent.click(await screen.findByRole("button", { name: "Confirm delivery" }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "Confirm delivery" }));

    await waitFor(() => expect(scheduleCalls).toBe(2));
    expect(await screen.findByText("Paid")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Confirm delivery" })).toBeNull();
  });
});
