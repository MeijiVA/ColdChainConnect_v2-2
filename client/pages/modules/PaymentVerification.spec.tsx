// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import type { UnverifiedPayment } from "@shared/api";
import { TooltipProvider } from "@/components/ui/tooltip";
import { useAuth, type AuthUser } from "@/hooks/useAuth";
import { PaymentVerification } from "./PaymentVerification";
import { PaymentReceipt } from "./PaymentReceipt";

const toast = vi.hoisted(() => ({ error: vi.fn(), success: vi.fn() }));
vi.mock("sonner", () => ({ toast }));

const payment: UnverifiedPayment = {
  id: "pay-1",
  receipt_id: "rec-1",
  receipt_number: "OR-0001",
  delivery_item_id: "di-1",
  customer_id: "cust-1",
  invoice_id: "inv-1",
  confirmed_at: "2026-01-02T08:00:00.000Z",
  customer_name: "Corner Store",
  invoice_receipt_number: "INV-0001",
  payment_method: "cash",
  amount: "250.00",
  recorded_by: "u-driver",
  recorded_by_username: "dave_driver",
  recorded_by_name: "Dave Driver",
  recorded_by_role: "driver",
};

const accounting: AuthUser = { id: "u-acct", username: "bob", role: "staff", module_permissions: ["accounting"] };
const fetchMock = vi.fn();
const json = (body: unknown, status = 200) => ({ ok: status < 400, status, json: async () => body });

function renderScreen() {
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <TooltipProvider>
        <MemoryRouter initialEntries={["/accounting/payments"]}>
          <Routes>
            <Route path="/accounting/payments" element={<PaymentVerification />} />
            <Route path="/accounting/payments/:id/receipt" element={<PaymentReceipt />} />
          </Routes>
        </MemoryRouter>
      </TooltipProvider>
    </QueryClientProvider>,
  );
}

const agentsList = [{ id: "u-alice", name: "Alice Agent" }, { id: "u-bea", name: "Bea Agent" }];
const listFor = (url: string) => json(url === "/api/payments/agents" ? agentsList : [payment]);
const verifyCalls = () => fetchMock.mock.calls.filter(([url]) => String(url).endsWith("/verify"));

beforeEach(() => {
  fetchMock.mockReset();
  toast.error.mockReset();
  toast.success.mockReset();
  fetchMock.mockImplementation(async (_url: string, init?: RequestInit) => (init?.method === "POST" ? json(payment) : listFor(_url)));
  vi.stubGlobal("fetch", fetchMock);
  localStorage.clear();
  useAuth.setState({ user: accounting, token: "tok" });
});

afterEach(() => {
  cleanup();
  useAuth.setState({ user: null, token: null });
  vi.unstubAllGlobals();
});

describe("PaymentVerification", () => {
  it("lists the payments waiting to be verified", async () => {
    renderScreen();
    const row = await screen.findByRole("row", { name: /Corner Store/ });
    expect(row.textContent).toContain("OR-0001");
    expect(row.textContent).toContain("INV-0001");
    expect(row.textContent).toContain("₱250.00");
    expect(row.textContent).toContain("Dave Driver");
    expect(within(row).getByRole("link", { name: /OR-0001 · INV-0001/ }).getAttribute("href")).toBe("/accounting/payments/pay-1/receipt");
    expect(fetchMock.mock.calls[0][0]).toBe("/api/payments/unverified?status=all");
    expect(fetchMock.mock.calls[0][1].headers.Authorization).toBe("Bearer tok");
  });

  it("opens the matching receipt and returns to payments", async () => {
    fetchMock.mockImplementation(async (url: string) => url === "/api/payments/pay-1/receipt"
      ? json({ id: "rec-1", receipt_number: "OR-0001", customer_id: "cust-1", truck_id: "truck-1", invoice_id: "inv-1", confirmed_at: payment.confirmed_at, customer: { store_name: "Corner Store" }, truck: { license_plate: "AAA-111" }, invoice: { payment_status: "partial" } })
      : listFor(url));
    renderScreen();
    fireEvent.click(await screen.findByRole("link", { name: /OR-0001 · INV-0001/ }));
    expect(await screen.findByRole("heading", { name: "Original Receipt" })).toBeTruthy();
    expect(screen.getByText("PARTIAL")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /Back/ }));
    expect(await screen.findByRole("row", { name: /Corner Store/ })).toBeTruthy();
  });

  it("shows an error when the receipt is unavailable", async () => {
    fetchMock.mockImplementation(async (url: string) => url === "/api/payments/pay-1/receipt" ? json({ error: "Receipt not found" }, 404) : listFor(url));
    renderScreen();
    fireEvent.click(await screen.findByRole("link", { name: /OR-0001 · INV-0001/ }));
    expect((await screen.findByRole("alert")).textContent).toContain("Receipt not found");
    expect(screen.getByRole("link", { name: /Back to payments/ })).toBeTruthy();
  });

  it("finds payments by the recorder's name", async () => {
    renderScreen();
    fireEvent.change(await screen.findByPlaceholderText(/Search by customer/), { target: { value: "Dave Driver" } });
    expect(screen.getByRole("row", { name: /Corner Store/ })).toBeTruthy();
  });

  it("offers bulk actions after selecting a payment", async () => {
    renderScreen();
    fireEvent.click(await screen.findByRole("checkbox", { name: "Select payment OR-0001" }));
    fireEvent.pointerDown(await screen.findByRole("button", { name: /Actions \(1\)/ }), { button: 0 });
    const verifySelected = await screen.findByRole("menuitem", { name: "Verify selected" });
    expect(screen.getByRole("menuitem", { name: "Print selected" })).toBeTruthy();
    fireEvent.click(verifySelected);
    expect(await screen.findByRole("dialog")).toBeTruthy();
  });

  it("lists every agent in the filter, even those without payments, and filters by the picked date", async () => {
    renderScreen();
    await screen.findByRole("row", { name: /Corner Store/ });
    const agentFilter = screen.getByLabelText("Filter by agent");
    expect(within(agentFilter).getByRole("option", { name: "Alice Agent" })).toBeTruthy();
    expect(within(agentFilter).getByRole("option", { name: "Bea Agent" })).toBeTruthy();

    fireEvent.change(screen.getByLabelText("Filter by date"), { target: { value: "2026-01-03" } });
    expect(await screen.findByText(/no payments match/i)).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Filter by date"), { target: { value: "2026-01-02" } });
    expect(await screen.findByRole("row", { name: /Corner Store/ })).toBeTruthy();
  });

  it("filters by the Today, Yesterday and Last 7 days presets on the Manila calendar", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-01-03T02:00:00+08:00"));
    try {
      renderScreen();
      await screen.findByRole("row", { name: /Corner Store/ });
      const range = screen.getByLabelText("Date range");

      fireEvent.change(range, { target: { value: "today" } });
      expect(await screen.findByText(/no payments match/i)).toBeTruthy();

      fireEvent.change(range, { target: { value: "yesterday" } });
      expect(await screen.findByRole("row", { name: /Corner Store/ })).toBeTruthy();

      fireEvent.change(range, { target: { value: "last7" } });
      expect(await screen.findByRole("row", { name: /Corner Store/ })).toBeTruthy();
    } finally {
      vi.useRealTimers();
    }
  });

  it("shows an empty state", async () => {
    fetchMock.mockImplementation(async () => json([]));
    renderScreen();
    expect(await screen.findByText(/no payments are waiting/i)).toBeTruthy();
  });

  it("confirms in a modal, then verifies and refreshes", async () => {
    renderScreen();
    fireEvent.click(await screen.findByRole("button", { name: /Verify/ }));
    const dialog = await screen.findByRole("dialog");
    expect(verifyCalls()).toHaveLength(0);
    fireEvent.click(within(dialog).getByRole("button", { name: /Confirm payment received/ }));

    await waitFor(() => expect(verifyCalls()).toHaveLength(1));
    expect(verifyCalls()[0][0]).toBe("/api/payments/pay-1/verify");
    expect(verifyCalls()[0][1].headers.Authorization).toBe("Bearer tok");
    await waitFor(() => expect(fetchMock.mock.calls.filter(([url]) => url === "/api/payments/unverified?status=all").length).toBeGreaterThan(1));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(toast.success).toHaveBeenCalled();
  });

  it("shows the server's 409 message as a toast", async () => {
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) =>
      init?.method === "POST" ? json({ error: "This payment is already verified" }, 409) : listFor(url),
    );
    renderScreen();
    fireEvent.click(await screen.findByRole("button", { name: /Verify/ }));
    fireEvent.click(within(await screen.findByRole("dialog")).getByRole("button", { name: /Confirm payment received/ }));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("This payment is already verified"));
  });

  it("offers no Verify action to a user without payment:verify", async () => {
    useAuth.setState({ user: { id: "u-x", username: "x", role: "staff", module_permissions: ["reports"] } });
    renderScreen();
    await screen.findByRole("row", { name: /Corner Store/ });
    expect(screen.queryByRole("button", { name: /Verify/ })).toBeNull();
  });
});
