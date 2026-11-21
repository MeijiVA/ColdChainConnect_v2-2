// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import type { Pallet } from "@shared/api";
import { PalletDetail } from "./PalletDetail";

const pallet: Pallet = {
  id: "pal-1",
  order_id: "book-1",
  status: "draft",
  created_at: "2026-01-02T08:00:00.000Z",
  updated_at: "2026-01-02T08:00:00.000Z",
  items: [],
};

function renderDetail(canChangeStatus: boolean) {
  render(
    <PalletDetail
      pallet={pallet}
      order={null}
      customer={null}
      delivery={null}
      truck={null}
      batches={[]}
      getProductName={(id) => id}
      canChangeStatus={canChangeStatus}
      onStatusChange={vi.fn()}
      onPrintSheet={vi.fn()}
      isUpdatingStatus={false}
      onBack={vi.fn()}
    />,
  );
}

afterEach(cleanup);

describe("PalletDetail status controls", () => {
  it("shows the status buttons to people who may change a pallet's status", () => {
    renderDetail(true);
    expect(screen.getByRole("button", { name: /Mark as/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: "More status actions" })).toBeTruthy();
  });

  it("hides them from everyone else, leaving the pallet read-only", () => {
    renderDetail(false);
    expect(screen.queryByRole("button", { name: /Mark as/ })).toBeNull();
    expect(screen.queryByRole("button", { name: "More status actions" })).toBeNull();
    expect(screen.getByRole("button", { name: "Shipping label" })).toBeTruthy();
  });
});
