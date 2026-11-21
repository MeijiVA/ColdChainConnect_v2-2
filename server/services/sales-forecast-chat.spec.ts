import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  Request,
  Response as ExpressResponse,
  NextFunction,
} from "express";
import type { SalesForecastChatRequest } from "@shared/api";
import { postSalesForecastChat } from "../routes/sales-forecast-chat";
import {
  generateSalesForecastAnswer,
  GeminiRequestError,
} from "./sales-forecast-chat";

const input: SalesForecastChatRequest = {
  question: "What should we restock?",
  messages: [{ role: "assistant", content: "Previous answer" }],
  forecast: {
    history: [],
    forecast: [],
    projected_7_day_total: 0,
    trend: "flat",
    trend_percent: 0,
    has_enough_data: false,
    history_days_with_sales: 0,
    note: "Not enough data",
    product_insights: [],
    ai_summary: null,
  },
};

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
const answerResponse = () =>
  jsonResponse({
    candidates: [
      {
        content: { parts: [{ text: "  Restock " }, { text: "carefully.  " }] },
      },
    ],
  });

async function callRoute(body: unknown) {
  const res = {
    statusCode: 200,
    payload: undefined as unknown,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(payload: unknown) {
      this.payload = payload;
      return this;
    },
  };
  await postSalesForecastChat(
    { body } as Request,
    res as unknown as ExpressResponse,
    vi.fn() as NextFunction,
  );
  return res;
}

beforeEach(() => {
  vi.stubEnv("GEMINI_API_KEY", "secret-test-key");
  vi.stubEnv("GEMINI_MODEL", "");
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("sales forecast Gemini chat", () => {
  it("uses the default model, output limit, key header, and returns joined answer text", async () => {
    const fetchMock = vi.fn().mockResolvedValue(answerResponse());
    vi.stubGlobal("fetch", fetchMock);
    expect(await generateSalesForecastAnswer(input)).toBe("Restock carefully.");
    const [url, options] = fetchMock.mock.calls[0];
    expect(url).toBe(
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent",
    );
    expect(options.headers["x-goog-api-key"]).toBe("secret-test-key");
    expect(url).not.toContain("secret-test-key");
    expect(JSON.parse(options.body)).toMatchObject({
      generationConfig: { maxOutputTokens: 2048 },
      contents: [
        { role: "model", parts: [{ text: "Previous answer" }] },
        { role: "user", parts: [{ text: input.question }] },
      ],
    });
    expect(options.signal).toBeInstanceOf(AbortSignal);
  });

  it("uses the trimmed and encoded GEMINI_MODEL override", async () => {
    vi.stubEnv("GEMINI_MODEL", " custom/model ");
    const fetchMock = vi.fn().mockResolvedValue(answerResponse());
    vi.stubGlobal("fetch", fetchMock);
    await generateSalesForecastAnswer(input);
    expect(fetchMock.mock.calls[0][0]).toContain(
      "models/custom%2Fmodel:generateContent",
    );
  });

  it("reports a missing key without making a request", async () => {
    vi.stubEnv("GEMINI_API_KEY", "  ");
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await expect(generateSalesForecastAnswer(input)).rejects.toMatchObject({
      code: "key",
      status: 503,
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    [400, { error: { details: [{ reason: "API_KEY_INVALID" }] } }, "key", 503],
    [401, {}, "key", 503],
    [403, {}, "key", 503],
    [404, {}, "model", 503],
    [429, {}, "quota", 429],
    [400, {}, "request", 502],
    [500, {}, "request", 502],
  ])(
    "classifies HTTP %s safely",
    async (upstreamStatus, body, code, status) => {
      vi.stubGlobal(
        "fetch",
        vi
          .fn()
          .mockResolvedValue(
            jsonResponse(
              { ...body, raw: "secret-test-key attacker text" },
              upstreamStatus,
            ),
          ),
      );
      const log = vi.spyOn(console, "error");
      const result = await callRoute(input);
      expect(result.statusCode).toBe(status);
      expect(result.payload).toEqual({ error: expect.any(String) });
      expect(JSON.stringify(result.payload)).not.toMatch(
        /secret-test-key|attacker text/,
      );
      expect(log).not.toHaveBeenCalled();
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue(jsonResponse(body, upstreamStatus)),
      );
      await expect(generateSalesForecastAnswer(input)).rejects.toMatchObject({
        code,
        status,
      });
    },
  );

  it.each([
    [new TypeError("secret-test-key network failure"), "network", 502],
    [
      Object.assign(new Error("secret-test-key timeout"), {
        name: "TimeoutError",
      }),
      "timeout",
      504,
    ],
    [Object.assign(new Error("abort"), { name: "AbortError" }), "timeout", 504],
  ])(
    "classifies transport failures without exposing their messages",
    async (error, code, status) => {
      vi.stubGlobal("fetch", vi.fn().mockRejectedValue(error));
      const result = await callRoute(input);
      expect(result.statusCode).toBe(status);
      expect(JSON.stringify(result.payload)).not.toContain("secret-test-key");
      await expect(generateSalesForecastAnswer(input)).rejects.toMatchObject({
        code,
        status,
      });
    },
  );

  it.each([
    [{ promptFeedback: { blockReason: "secret-test-key" } }, /blocked/i],
    [{ candidates: [{ finishReason: "SAFETY" }] }, /blocked/i],
    [{ candidates: [{ finishReason: "MAX_TOKENS" }] }, /output limit/i],
    [
      {
        candidates: [
          { content: { parts: [{ text: "private thought", thought: true }] } },
        ],
      },
      /empty answer/i,
    ],
    [{ candidates: [] }, /empty answer/i],
  ])("gives safe diagnostics for an empty answer", async (body, message) => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(body)));
    const result = await callRoute(input);
    expect(result.statusCode).toBe(502);
    expect(result.payload).toEqual({ error: expect.stringMatching(message) });
    expect(JSON.stringify(result.payload)).not.toMatch(
      /secret-test-key|private thought/,
    );
  });

  it("handles malformed JSON without exposing its content", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(new Response("secret-test-key", { status: 200 })),
    );
    await expect(generateSalesForecastAnswer(input)).rejects.toMatchObject({
      code: "request",
      status: 502,
    });
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(new Response("secret-test-key", { status: 404 })),
    );
    await expect(generateSalesForecastAnswer(input)).rejects.toMatchObject({
      code: "model",
      status: 503,
    });
  });

  it("classifies response body network and timeout failures", async () => {
    for (const [error, code, status] of [
      [new TypeError("connection failed"), "network", 502],
      [
        Object.assign(new Error("timeout"), { name: "TimeoutError" }),
        "timeout",
        504,
      ],
    ] as const) {
      vi.stubGlobal(
        "fetch",
        vi
          .fn()
          .mockResolvedValue({
            ok: true,
            json: vi.fn().mockRejectedValue(error),
          }),
      );
      await expect(generateSalesForecastAnswer(input)).rejects.toMatchObject({
        code,
        status,
      });
    }
  });

  it("reports missing configuration through the route", async () => {
    vi.stubEnv("GEMINI_API_KEY", "");
    const result = await callRoute(input);
    expect(result.statusCode).toBe(503);
    expect(result.payload).toEqual({
      error: expect.stringContaining("GEMINI_API_KEY"),
    });
  });

  it("returns validated answers and rejects invalid requests before calling Gemini", async () => {
    const fetchMock = vi.fn().mockResolvedValue(answerResponse());
    vi.stubGlobal("fetch", fetchMock);
    const invalid = await callRoute({ ...input, question: " " });
    expect(invalid.statusCode).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
    const success = await callRoute(input);
    expect(success.statusCode).toBe(200);
    expect(success.payload).toEqual({ answer: "Restock carefully." });
  });

  it("exports a distinguishable error type", () => {
    expect(new GeminiRequestError("quota", "safe", 429)).toBeInstanceOf(Error);
  });
});
