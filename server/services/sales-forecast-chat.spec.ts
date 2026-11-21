import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  Request,
  Response as ExpressResponse,
  NextFunction,
} from "express";
import type { SalesForecastChatRequest } from "@shared/api";
import { postSalesForecastChat } from "../routes/sales-forecast-chat";
import * as geminiService from "./sales-forecast-chat";
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
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
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
      status: undefined,
      publicMessage: expect.stringContaining("GEMINI_API_KEY"),
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    [400, { error: { details: [{ reason: "API_KEY_INVALID" }] } }, "key"],
    [
      400,
      {
        error: {
          message:
            "API key not valid. secret-test-key private-model attacker text",
        },
      },
      "key",
    ],
    [400, { error: { message: "API_KEY_INVALID secret-test-key" } }, "key"],
    [401, {}, "key"],
    [403, {}, "key"],
    [404, {}, "model"],
    [429, {}, "quota"],
    [400, {}, "request"],
    [500, {}, "request"],
  ])("classifies HTTP %s safely", async (upstreamStatus, body, code) => {
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
    vi.stubEnv("GEMINI_MODEL", "private-model");
    const result = await callRoute(input);
    expect(result.statusCode).toBe(502);
    expect(result.payload).toEqual({ error: expect.any(String) });
    expect(JSON.stringify(result.payload)).not.toMatch(
      /secret-test-key|private-model|attacker text/,
    );
    expect(JSON.stringify(vi.mocked(console.error).mock.calls)).not.toMatch(
      /secret-test-key|private-model|attacker text/,
    );
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(jsonResponse(body, upstreamStatus)),
    );
    await expect(generateSalesForecastAnswer(input)).rejects.toMatchObject({
      code,
      status: upstreamStatus,
      publicMessage: expect.any(String),
    });
  });

  it.each([
    [new TypeError("secret-test-key network failure"), "network"],
    [
      Object.assign(new Error("secret-test-key timeout"), {
        name: "TimeoutError",
      }),
      "timeout",
    ],
    [Object.assign(new Error("abort"), { name: "AbortError" }), "timeout"],
  ])(
    "classifies transport failures without exposing their messages",
    async (error, code) => {
      vi.stubGlobal("fetch", vi.fn().mockRejectedValue(error));
      const result = await callRoute(input);
      expect(result.statusCode).toBe(502);
      expect(JSON.stringify(result.payload)).not.toContain("secret-test-key");
      expect(JSON.stringify(vi.mocked(console.error).mock.calls)).not.toContain(
        "secret-test-key",
      );
      await expect(generateSalesForecastAnswer(input)).rejects.toMatchObject({
        code,
        status: undefined,
        publicMessage: expect.any(String),
      });
    },
  );

  it.each([
    [{ promptFeedback: { blockReason: "secret-test-key" } }, "blocked"],
    [{ candidates: [{ finishReason: "SAFETY" }] }, "blocked"],
    [{ candidates: [{ finishReason: "MAX_TOKENS" }] }, "output_limit"],
    [
      {
        candidates: [
          { content: { parts: [{ text: "private thought", thought: true }] } },
        ],
      },
      "no_text",
    ],
    [{ candidates: [] }, "no_text"],
  ])("gives safe diagnostics for an empty answer", async (body, reason) => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation(async () => jsonResponse(body)),
    );
    expect(await generateSalesForecastAnswer(input)).toBeNull();
    const result = await callRoute(input);
    expect(result.statusCode).toBe(502);
    expect(result.payload).toEqual({
      error: expect.stringMatching(/empty answer/i),
    });
    expect(console.warn).toHaveBeenCalledWith(
      "Gemini forecast chat returned no answer",
      { reason },
    );
    expect(JSON.stringify(vi.mocked(console.warn).mock.calls)).not.toMatch(
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
      status: 200,
    });
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(new Response("secret-test-key", { status: 404 })),
    );
    await expect(generateSalesForecastAnswer(input)).rejects.toMatchObject({
      code: "model",
      status: 404,
    });
  });

  it("classifies response body network and timeout failures", async () => {
    for (const [error, code, status] of [
      [new TypeError("connection failed"), "network", 200],
      [
        Object.assign(new Error("timeout"), { name: "TimeoutError" }),
        "timeout",
        200,
      ],
    ] as const) {
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue({
          ok: true,
          status: 200,
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

  it("only exposes the public message for a typed error and masks unexpected errors", async () => {
    const error = new GeminiRequestError("quota", "Safe quota message", 429);
    error.message = "secret-test-key private upstream text";
    const generate = vi
      .spyOn(geminiService, "generateSalesForecastAnswer")
      .mockRejectedValue(error);
    const typed = await callRoute(input);
    expect(typed.statusCode).toBe(502);
    expect(typed.payload).toEqual({ error: "Safe quota message" });
    generate.mockRejectedValue(new Error("secret-test-key unexpected error"));
    const unexpected = await callRoute(input);
    expect(unexpected.statusCode).toBe(502);
    expect(JSON.stringify(unexpected.payload)).not.toContain("secret-test-key");
  });

  it("exports a distinguishable error type", () => {
    const error = new GeminiRequestError("quota", "safe", 429);
    expect(error).toBeInstanceOf(Error);
    expect(error.publicMessage).toBe("safe");
    expect(error.status).toBe(429);
  });
});
