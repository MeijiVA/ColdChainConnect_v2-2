// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { useAuth } from "../hooks/useAuth";
import { DemoRoleSelect } from "./DemoRoleSelect";

const fetchMock = vi.fn();

function showPicker() {
  render(
    <MemoryRouter initialEntries={["/login"]}>
      <Routes>
        <Route path="/login" element={<DemoRoleSelect />} />
        <Route path="/" element={<div>Staff home</div>} />
        <Route path="/booking-dispatch/order-summary" element={<div>Agent home</div>} />
      </Routes>
    </MemoryRouter>,
  );
}

const response = (ok: boolean, body: object) => ({ ok, json: async () => body });

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  cleanup();
  window.localStorage.clear();
  useAuth.setState({ user: null, token: null, isAuthenticated: false, isLoading: false, isPostLoginLoading: false, error: null });
  vi.unstubAllGlobals();
});

describe("demo role selection", () => {
  it("offers a staff and an agent account instead of a login form", () => {
    showPicker();
    expect(screen.getByRole("button", { name: /staff account/i })).toBeTruthy();
    expect(screen.getByRole("button", { name: /agent account/i })).toBeTruthy();
    expect(screen.queryByLabelText("Username")).toBeNull();
    expect(screen.queryByLabelText("Password")).toBeNull();
  });

  it("signs in as an agent and opens the booking screen", async () => {
    fetchMock.mockResolvedValue(
      response(true, { token: "t", user: { id: "1", username: "agent1", role: "agent", module_permissions: [] } }),
    );
    showPicker();
    fireEvent.click(screen.getByRole("button", { name: /agent account/i }));

    expect(await screen.findByText("Agent home")).toBeTruthy();
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("/api/auth/demo-login");
    expect(JSON.parse(init.body)).toEqual({ role: "agent" });
    expect(useAuth.getState().user?.role).toBe("agent");
  });

  it("signs in as staff and opens the home screen", async () => {
    fetchMock.mockResolvedValue(
      response(true, { token: "t", user: { id: "2", username: "demo-staff", role: "staff", module_permissions: ["dashboard"] } }),
    );
    showPicker();
    fireEvent.click(screen.getByRole("button", { name: /staff account/i }));

    expect(await screen.findByText("Staff home")).toBeTruthy();
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ role: "staff" });
  });

  it("shows the server's message and lets the visitor try again when the demo can't start", async () => {
    fetchMock.mockResolvedValue(response(false, { error: "The demo agent account \"agent1\" was not found. Seed the demo database first." }));
    showPicker();
    fireEvent.click(screen.getByRole("button", { name: /agent account/i }));

    expect((await screen.findByRole("alert")).textContent).toContain("was not found");
    await waitFor(() => expect((screen.getByRole("button", { name: /staff account/i }) as HTMLButtonElement).disabled).toBe(false));
  });
});
