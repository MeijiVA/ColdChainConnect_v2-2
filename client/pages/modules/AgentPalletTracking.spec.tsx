// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { MemoryRouter, useNavigate } from "react-router-dom";
import { useAuth } from "@/hooks/useAuth";
import { AgentPalletTracking } from "./AgentPalletTracking";

const orderA = "aaaaaaaa-1111-4111-8111-111111111111";
const orderB = "bbbbbbbb-2222-4222-8222-222222222222";
const emptyOrder = "cccccccc-3333-4333-8333-333333333333";
const palletA = "12345678-1111-4111-8111-111111111111";
const palletB = "87654321-2222-4222-8222-222222222222";

const booking = (id: string, store: string) => ({
  id,
  customer_id: id,
  customer: { store_name: store, location: `${store} location` },
});
const pallet = (id: string, order_id: string) => ({
  id,
  order_id,
  status: "draft",
  created_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-01-01T00:00:00Z",
  items: [],
});

let bookings: ReturnType<typeof booking>[];
let pallets: ReturnType<typeof pallet>[];

function Navigation() {
  const navigate = useNavigate();
  return (
    <button onClick={() => navigate(`/?order=ORD-${orderB.slice(0, 8)}`)}>
      Scan next
    </button>
  );
}

function renderTracking(code?: string) {
  return render(
    <MemoryRouter
      initialEntries={[code ? `/?order=${encodeURIComponent(code)}` : "/"]}
    >
      <Navigation />
      <AgentPalletTracking />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  bookings = [
    booking(orderA, "Alpha"),
    booking(orderB, "Bravo"),
    booking(emptyOrder, "Empty"),
  ];
  pallets = [pallet(palletA, orderA), pallet(palletB, orderB)];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      const bodies: Record<string, unknown> = {
        "/api/bookings": bookings,
        "/api/pallets": pallets,
        "/api/products": [],
        "/api/inventory-batches": [],
        "/api/agent-schedule": { deliveries: [] },
      };
      return { ok: true, json: async () => bodies[url] };
    }),
  );
  useAuth.setState({ token: "token" });
});

afterEach(() => {
  cleanup();
  useAuth.setState({ user: null, token: null });
  vi.unstubAllGlobals();
});

describe("Agent pallet barcode tracking", () => {
  it("opens the unique short pallet code, ignoring case and whitespace", async () => {
    renderTracking("  plt-12345678  ");
    expect(await screen.findByText("Scanned pallet")).toBeTruthy();
    expect(screen.getByText(/Move PLT-12345678/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Mark prepared" })).toBeTruthy();
  });

  it("advances the full pallet ID resolved from a short scan", async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockImplementation(async (input, init) => {
      if (init?.method === "PATCH") {
        return {
          ok: true,
          json: async () => ({
            ...pallet(palletA, orderA),
            status: "prepared",
          }),
        } as Response;
      }
      const bodies: Record<string, unknown> = {
        "/api/bookings": bookings,
        "/api/pallets": pallets,
        "/api/products": [],
        "/api/inventory-batches": [],
        "/api/agent-schedule": { deliveries: [] },
      };
      return { ok: true, json: async () => bodies[String(input)] } as Response;
    });
    renderTracking("PLT-12345678");
    await screen.findByText("Scanned pallet");
    fireEvent.click(screen.getByRole("button", { name: "Mark prepared" }));
    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        `/api/pallets/${palletA}/status`,
        expect.objectContaining({
          method: "PATCH",
          body: JSON.stringify({ status: "prepared" }),
        }),
      ),
    );
  });

  it("filters the list for a short order code", async () => {
    renderTracking("ord-aaaaaaaa");
    expect(await screen.findByText("Alpha")).toBeTruthy();
    expect(screen.queryByText("Bravo")).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.queryByText("Scanned pallet")).toBeNull();
  });

  it.each([palletA, palletA.toUpperCase()])(
    "opens a legacy full pallet ID %s",
    async (code) => {
      renderTracking(code);
      expect(await screen.findByText("Scanned pallet")).toBeTruthy();
      expect(screen.getByText(/Move PLT-12345678/)).toBeTruthy();
    },
  );

  it("filters for a legacy full order ID", async () => {
    renderTracking(orderA.toUpperCase());
    expect(await screen.findByText("Alpha")).toBeTruthy();
    expect(screen.queryByText("Bravo")).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it.each([`ORD-${emptyOrder.slice(0, 8)}`, emptyOrder])(
    "recognizes an order with no pallets: %s",
    async (code) => {
      renderTracking(code);
      expect(await screen.findByText("No matching pallets")).toBeTruthy();
      expect(screen.queryByRole("alert")).toBeNull();
    },
  );

  it.each([
    "PLT-DEADBEEF",
    "ORD-DEADBEEF",
    "not-a-barcode",
    "dddddddd-1111-4111-8111-111111111111",
  ])("reports an unknown code: %s", async (code) => {
    renderTracking(code);
    expect((await screen.findByRole("alert")).textContent).toContain(
      "No pallet or order matches this barcode",
    );
    expect(screen.queryByText("Scanned pallet")).toBeNull();
  });

  it("does not open a pallet when its short code is ambiguous", async () => {
    pallets.push(pallet("12345678-9999-4999-8999-999999999999", orderB));
    renderTracking("PLT-12345678");
    expect((await screen.findByRole("alert")).textContent).toMatch(
      /multiple.*full ID/i,
    );
    expect(screen.queryByText("Scanned pallet")).toBeNull();
  });

  it("detects ambiguous order codes even when one order has no pallets", async () => {
    bookings.push(booking("aaaaaaaa-9999-4999-8999-999999999999", "Another"));
    renderTracking("ORD-AAAAAAAA");
    expect((await screen.findByRole("alert")).textContent).toMatch(
      /multiple.*full ID/i,
    );
    expect(screen.queryByText("Scanned pallet")).toBeNull();
  });

  it("allows manual searching by short pallet and order codes", async () => {
    renderTracking();
    await screen.findByText("Alpha");
    const input = screen.getByPlaceholderText(
      "Search pallet, order, or customer",
    );
    fireEvent.change(input, { target: { value: "plt-12345678" } });
    expect(screen.getByText("Alpha")).toBeTruthy();
    expect(screen.queryByText("Bravo")).toBeNull();
    fireEvent.change(input, { target: { value: "ORD-BBBBBBBB" } });
    expect(screen.getByText("Bravo")).toBeTruthy();
    expect(screen.queryByText("Alpha")).toBeNull();
  });

  it("preserves the loading error instead of reporting an unknown scan", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: false })),
    );
    renderTracking("PLT-12345678");
    expect((await screen.findByRole("alert")).textContent).toContain(
      "Could not load pallet tracking",
    );
  });

  it("handles a new scan after an earlier scanned pallet", async () => {
    renderTracking("PLT-12345678");
    await screen.findByText("Scanned pallet");
    fireEvent.click(screen.getByText("Scan next"));
    expect(await screen.findByText("Bravo")).toBeTruthy();
    expect(screen.queryByText("Scanned pallet")).toBeNull();
    expect(screen.queryByText("Alpha")).toBeNull();
  });
});
