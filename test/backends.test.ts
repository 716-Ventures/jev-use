/**
 * Wire-format tests: each backend must emit the exact request shape its
 * provider documents and parse the documented response. Fixtures follow
 * the official OpenRouter decisions example and the typesafe-sdk-js /
 * @ai-sdk/gateway source (verified 2026-09).
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { OpenRouterBackend } from "../src/backends/openrouter.js";
import { TypeSafeBackend } from "../src/backends/typesafe.js";
import { BackendError } from "../src/backends/types.js";
import { VercelBackend } from "../src/backends/vercel.js";
import type { Question } from "../src/protocol.js";

type Q = Question & { id: string };

const questions: Q[] = [
  {
    id: "is_bug",
    type: "noul",
    question: "Is the customer reporting a software defect?",
    criteria: {
      true: "The customer describes broken behavior.",
      false: "The customer is asking a question.",
    },
  },
  {
    id: "team",
    type: "choice",
    question: "Which team should own this ticket?",
    options: { frontend: "Rendering issues", payments: "Checkout issues" },
  },
  {
    id: "urgency",
    type: "score",
    question: "How urgent is this ticket?",
    levels: ["Can wait", "This week", "Blocking revenue"],
  },
];

const nativeAnswers = {
  is_bug: { type: "noul", noul: 0.96 },
  team: {
    type: "choice",
    choice: "payments",
    confidence: 0.75,
    probabilities: { frontend: 0.16, payments: 0.84 },
  },
  urgency: {
    type: "score",
    score: 1.99,
    confidence: 0.99,
    legend: { "0": "Can wait", "1": "This week", "2": "Blocking revenue" },
    probabilities: { "0": 0, "1": 0.01, "2": 0.99 },
  },
};

function mockFetchOnce(status: number, body: unknown, headers: Record<string, string> = {}) {
  const calls: { url: string; init: RequestInit }[] = [];
  const responses: { status: number; body: unknown; headers: Record<string, string> }[] = [
    { status, body, headers },
  ];
  const fn = vi.fn(async (url: string | URL, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    const r = responses.shift() ?? responses[0] ?? { status, body, headers };
    return new Response(JSON.stringify(r.body), {
      status: r.status,
      headers: { "Content-Type": "application/json", ...r.headers },
    });
  });
  vi.stubGlobal("fetch", fn);
  return { calls, queue: responses };
}

afterEach(() => vi.unstubAllGlobals());

describe("TypeSafeBackend", () => {
  it("posts the native body to /v1/systemone and parses the answer map", async () => {
    const { calls } = mockFetchOnce(200, {
      model: "jev-1.13",
      answers: nativeAnswers,
      usage: { input_tokens: 476, output_tokens: 70 },
    });
    const backend = new TypeSafeBackend({ apiKey: "sk-test" });
    const res = await backend.judge({ state: { ticket: "blank checkout" }, questions });

    expect(calls[0].url).toBe("https://api.typesafe.ai/v1/systemone");
    const headers = calls[0].init.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer sk-test");
    const body = JSON.parse(String(calls[0].init.body));
    expect(body).toEqual({
      model: "jev-latest",
      state: { ticket: "blank checkout" },
      questions: {
        is_bug: {
          type: "noul",
          instructions: "Is the customer reporting a software defect?",
          criteria: {
            true: "The customer describes broken behavior.",
            false: "The customer is asking a question.",
          },
        },
        team: {
          type: "choice",
          instructions: "Which team should own this ticket?",
          criteria: { frontend: "Rendering issues", payments: "Checkout issues" },
        },
        urgency: {
          type: "score",
          instructions: "How urgent is this ticket?",
          criteria: ["Can wait", "This week", "Blocking revenue"],
        },
      },
    });

    expect(res.answers).toEqual([
      { answer: 0.96 },
      {
        answer: "payments",
        confidence: 0.75,
        distribution: { frontend: 0.16, payments: 0.84 },
      },
      {
        answer: 1.99,
        confidence: 0.99,
        distribution: { "0": 0, "1": 0.01, "2": 0.99 },
        legend: { "0": "Can wait", "1": "This week", "2": "Blocking revenue" },
      },
    ]);
    expect(res.usage).toEqual({ inputTokens: 476, outputTokens: 70 });
  });

  it("turns label-only options into label->label criteria", async () => {
    const { calls } = mockFetchOnce(200, {
      answers: { q0: { type: "choice", choice: "a", confidence: 0.9, probabilities: { a: 0.9, b: 0.1 } } },
    });
    const backend = new TypeSafeBackend({ apiKey: "sk-test" });
    await backend.judge({
      state: "s",
      questions: [{ id: "q0", type: "choice", question: "pick", options: ["a", "b"] }],
    });
    const body = JSON.parse(String(calls[0].init.body));
    expect(body.questions.q0.criteria).toEqual({ a: "a", b: "b" });
  });

  it("throws a named BackendError on a 4xx without retrying", async () => {
    const { calls } = mockFetchOnce(401, { error: { message: "invalid api key" } });
    const backend = new TypeSafeBackend({ apiKey: "bad" });
    await expect(
      backend.judge({ state: "s", questions: [questions[0]] }),
    ).rejects.toThrow(/401.*invalid api key/);
    expect(calls).toHaveLength(1);
  });

  it("retries a 429 honoring retry-after-ms", async () => {
    const { calls, queue } = mockFetchOnce(429, { error: "slow down" }, { "retry-after-ms": "1" });
    queue.push({ status: 200, body: { answers: { is_bug: { type: "noul", noul: 0.9 } } }, headers: {} });
    const backend = new TypeSafeBackend({ apiKey: "sk-test" });
    const res = await backend.judge({ state: "s", questions: [questions[0]] });
    expect(calls).toHaveLength(2);
    expect(res.answers[0].answer).toBe(0.9);
  });

  it("errors when the response is missing an answer", async () => {
    mockFetchOnce(200, { answers: {} });
    const backend = new TypeSafeBackend({ apiKey: "sk-test" });
    await expect(
      backend.judge({ state: "s", questions: [questions[0]] }),
    ).rejects.toThrow(BackendError);
  });
});

describe("OpenRouterBackend", () => {
  it("posts the native body to /api/alpha/decisions with the OpenRouter slug", async () => {
    const { calls } = mockFetchOnce(200, {
      model: "typesafe/jev-1.13-20260917",
      answers: nativeAnswers,
      usage: { input_tokens: 476, output_tokens: 70, cost: 0.00002 },
    });
    const backend = new OpenRouterBackend({ apiKey: "or-test" });
    const res = await backend.judge({ state: "ticket text", questions });

    expect(calls[0].url).toBe("https://openrouter.ai/api/alpha/decisions");
    const body = JSON.parse(String(calls[0].init.body));
    expect(body.model).toBe("typesafe/jev-latest");
    // instructions must be present on every question (OpenRouter requires it)
    for (const q of Object.values(body.questions) as { instructions?: string }[]) {
      expect(q.instructions).toBeTruthy();
    }
    expect(res.model).toBe("typesafe/jev-1.13-20260917");
  });
});

describe("VercelBackend", () => {
  it("speaks the gateway dialect: model header, boolean type, probability field", async () => {
    const { calls } = mockFetchOnce(200, {
      answers: {
        is_bug: { type: "boolean", probability: 0.96 },
        team: { type: "choice", choice: "payments", probabilities: { frontend: 0.16, payments: 0.84 } },
        urgency: { type: "score", score: 1.99, probabilities: { "0": 0, "1": 0.01, "2": 0.99 } },
      },
      usage: { inputTokens: 476, outputTokens: 0 },
    });
    const backend = new VercelBackend({ apiKey: "vc-test" });
    const res = await backend.judge({ state: "ticket text", questions });

    expect(calls[0].url).toBe("https://ai-gateway.vercel.sh/v4/ai/evaluation-model");
    const headers = calls[0].init.headers as Record<string, string>;
    expect(headers["ai-model-id"]).toBe("typesafe-ai/jev");
    expect(headers["ai-evaluation-model-specification-version"]).toBe("4");
    expect(headers["ai-gateway-protocol-version"]).toBe("0.0.1");

    const body = JSON.parse(String(calls[0].init.body));
    expect(body.model).toBeUndefined(); // model travels in the header
    expect(body.questions.is_bug.type).toBe("boolean");
    expect(body.questions.urgency.criteria).toEqual(["Can wait", "This week", "Blocking revenue"]);

    // noul comes back as probability; confidence is absent by design here
    expect(res.answers[0]).toEqual({ answer: 0.96 });
    expect(res.answers[1]).toEqual({
      answer: "payments",
      distribution: { frontend: 0.16, payments: 0.84 },
    });
    expect(res.usage).toEqual({ inputTokens: 476, outputTokens: 0 });
  });
});
