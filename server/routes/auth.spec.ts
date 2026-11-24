import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { Server } from "http";
import type { AddressInfo } from "net";
import { createServer } from "../index";
import { signMfaChallenge, signToken, verifyToken } from "../auth";
import { loginLimiter, mfaLimiter } from "../middleware/rate-limit";
import { tokenForRole } from "../test-utils";

let server: Server;
let baseUrl: string;

const post = (path: string, body: unknown, token?: string) =>
  fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  });

beforeAll(async () => {
  server = createServer().listen(0);
  await new Promise((resolve) => server.once("listening", resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterEach(() => {
  loginLimiter.clear();
  mfaLimiter.clear();
});

afterAll(() => server.close());

describe("demo login", () => {
  it("does not hand out admin tokens just because DATABASE_URL is missing", async () => {
    const saved = { url: process.env.DATABASE_URL, demo: process.env.DEMO_MODE };
    delete process.env.DATABASE_URL;
    delete process.env.DEMO_MODE;
    try {
      const res = await post("/api/auth/login", { username: "anyone", password: "anything" });
      expect(res.status).toBe(503);
      expect(await res.json()).not.toHaveProperty("token");
    } finally {
      process.env.DATABASE_URL = saved.url;
      if (saved.demo !== undefined) process.env.DEMO_MODE = saved.demo;
    }
  });
});

describe("demo role picker", () => {
  const withPicker = async (value: string | undefined, run: () => Promise<void>) => {
    const saved = process.env.DEMO_ROLE_PICKER;
    if (value === undefined) delete process.env.DEMO_ROLE_PICKER;
    else process.env.DEMO_ROLE_PICKER = value;
    try {
      await run();
    } finally {
      if (saved === undefined) delete process.env.DEMO_ROLE_PICKER;
      else process.env.DEMO_ROLE_PICKER = saved;
    }
  };

  it("does not exist unless the deployment switches it on", async () => {
    await withPicker(undefined, async () => {
      const res = await post("/api/auth/demo-login", { role: "agent" });
      expect(res.status).toBe(404);
      expect(await res.json()).not.toHaveProperty("token");
    });
  });

  it("only ever offers staff and agent accounts", async () => {
    await withPicker("true", async () => {
      for (const role of ["admin", "driver", "", undefined]) {
        const res = await post("/api/auth/demo-login", { role });
        expect(res.status).toBe(400);
        expect(await res.json()).not.toHaveProperty("token");
      }
    });
  });
});

describe("brute-force protection", () => {
  it("blocks a username after repeated wrong passwords", async () => {
    const username = `nobody-${Date.now()}`;
    for (let i = 0; i < 5; i++) {
      const res = await post("/api/auth/login", { username, password: "wrong" });
      expect(res.status).toBe(401);
    }
    const blocked = await post("/api/auth/login", { username, password: "wrong" });
    expect(blocked.status).toBe(429);
    expect(blocked.headers.get("retry-after")).toBeTruthy();
  });

  it("blocks MFA codes for an account after repeated wrong guesses", async () => {
    // Unknown user id: each attempt fails, and the limiter must still count it.
    const challenge = signMfaChallenge("00000000-0000-0000-0000-000000000000");
    for (let i = 0; i < 5; i++) {
      const res = await post("/api/auth/mfa/verify", { challenge_token: challenge, code: "123456" });
      expect(res.status).toBe(401);
    }
    const blocked = await post("/api/auth/mfa/verify", { challenge_token: challenge, code: "123456" });
    expect(blocked.status).toBe(429);
  });
});

describe("token refresh", () => {
  it("issues a new valid token instead of crashing", async () => {
    const token = await tokenForRole("agent");
    if (!token) return;
    const res = await post("/api/auth/refresh", {}, token);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { token: string };
    expect(verifyToken(body.token)).toMatchObject({ role: "agent", userId: verifyToken(token)!.userId });
  });
});

describe("password and CORS policy", () => {
  it("rejects admin-set passwords shorter than 8 characters before touching the database", async () => {
    const token = await tokenForRole("admin");
    if (!token) return;
    const res = await fetch(`${baseUrl}/api/users/00000000-0000-0000-0000-000000000000/password`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ password: "short1" }),
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/at least 8/);
  });

  it("does not grant cross-origin access to other websites", async () => {
    const res = await fetch(`${baseUrl}/api/health`, { headers: { Origin: "https://evil.example" } });
    expect(res.headers.get("access-control-allow-origin")).toBeNull();
  });
});
