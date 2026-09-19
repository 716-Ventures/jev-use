/**
 * The engine: screen the questions, call the backend, hand back what Jev is
 * unsure about — producing verdicts that always come back in the caller's
 * question order, with escalations in-band. These functions must never throw
 * for reachable-world reasons: an unreachable backend degrades to
 * escalate-everything.
 *
 * Callers writing code use the `Jev` client, which wraps this; the wire
 * surfaces (MCP tools, pi tools, `jev-use judge`) call it directly because
 * the ordered `JudgeResult` is exactly their payload.
 */

import {
  certainty,
  escalateIfUnsure,
  margin,
  screenQuestions,
} from "./dispatch.js";
import {
  DEFAULT_CONFIDENCE_THRESHOLD,
  serializeState,
  type GateRequest,
  type GateResult,
  type JudgeRequest,
  type JudgeResult,
  type Question,
  type Verdict,
} from "./protocol.js";
import { BackendError, type JevBackend, type RawAnswer } from "./backends/types.js";

/** A question with its id resolved — what screening passes to a backend. */
type IdentifiedQuestion = Question & { id: string };

/** Answer one batch of questions about one state. */
export async function judge(
  backend: JevBackend,
  request: JudgeRequest,
): Promise<JudgeResult> {
  const threshold =
    request.confidenceThreshold ??
    backend.defaultConfidenceThreshold ??
    DEFAULT_CONFIDENCE_THRESHOLD;
  const screened = screenQuestions(request.state, request.questions, {
    confidenceThreshold: threshold,
  });

  const verdicts: Verdict[] = new Array(request.questions.length);
  for (const handedBack of screened.handedBack) {
    verdicts[handedBack.index] = handedBack.verdict;
  }

  let model = request.model;
  let latencyMs: number | undefined;
  let usage: JudgeResult["usage"];

  if (screened.sendable.length > 0) {
    try {
      const response = await backend.judge({
        state: request.state,
        questions: screened.sendable.map((sendable) => sendable.question),
        model: request.model,
      });
      model = response.model ?? model;
      latencyMs = response.latencyMs;
      usage = response.usage;
      screened.sendable.forEach(({ index, question }, position) => {
        const raw = response.answers[position];
        const verdict = raw
          ? toVerdict(question, raw)
          : missingAnswerVerdict(question, backend.name);
        verdicts[index] = escalateIfUnsure(verdict, threshold);
      });
    } catch (error) {
      const message =
        error instanceof BackendError ? error.message : String(error);
      for (const { index, question } of screened.sendable) {
        verdicts[index] = {
          id: question.id,
          type: question.type,
          answer: null,
          confidence: 0,
          escalate: true,
          reason: "unreachable",
          hint: `Jev backend failed (${message}); answer this yourself.`,
        };
      }
    }
  }

  return {
    verdicts,
    escalated: verdicts.some((verdict) => verdict.escalate),
    backend: backend.name,
    model,
    latencyMs,
    usage,
  };
}

/** Shape one backend answer as a verdict, filling in confidence per primitive. */
function toVerdict(question: IdentifiedQuestion, raw: RawAnswer): Verdict {
  switch (question.type) {
    case "noul": {
      const probability = clamp01(Number(raw.answer));
      return {
        id: question.id,
        type: question.type,
        answer: probability,
        confidence: raw.confidence ?? certainty(probability),
        escalate: false,
      };
    }
    case "choice": {
      const distribution = raw.distribution;
      return {
        id: question.id,
        type: question.type,
        answer: String(raw.answer),
        distribution,
        confidence: raw.confidence ?? fallbackConfidence(distribution),
        escalate: false,
      };
    }
    case "score": {
      const distribution = raw.distribution;
      return {
        id: question.id,
        type: question.type,
        answer: Number(raw.answer),
        distribution,
        legend:
          raw.legend ??
          Object.fromEntries(
            (question.levels ?? []).map((level, index) => [String(index), level]),
          ),
        confidence: raw.confidence ?? fallbackConfidence(distribution),
        escalate: false,
      };
    }
  }
}

/** Confidence for backends that report none: the distribution's own margin. */
function fallbackConfidence(distribution?: Record<string, number>): number {
  return distribution ? margin(distribution) : 0;
}

/** A backend answered the batch but skipped this question — treat it as a failure. */
function missingAnswerVerdict(
  question: IdentifiedQuestion,
  backend: string,
): Verdict {
  return {
    id: question.id,
    type: question.type,
    answer: null,
    confidence: 0,
    escalate: true,
    reason: "unreachable",
    hint: `Backend "${backend}" returned no answer for this question.`,
  };
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

/** Gate an agent action: sugar over a single allow/deny choice question. */
export async function gate(
  backend: JevBackend,
  request: GateRequest,
): Promise<GateResult> {
  const { tool, input, description } = request.action;
  const action = [
    `Tool: ${tool}`,
    description ? `Description: ${description}` : null,
    `Input: ${typeof input === "string" ? input : JSON.stringify(input)}`,
  ]
    .filter(Boolean)
    .join("\n");

  const state = `${serializeState(request.state)}\n\n--- proposed action ---\n${action}`;

  const result = await judge(backend, {
    state,
    questions: [
      {
        id: "gate",
        type: "choice",
        question:
          "Should the agent be allowed to run this proposed action right now?",
        options: {
          allow:
            "The action is safe, reversible or expected, and consistent with the state.",
          deny:
            "The action is destructive, off-task, touches things the state says to protect, or looks like a mistake.",
        },
      },
    ],
    confidenceThreshold: request.confidenceThreshold,
    model: request.model,
  });

  const verdict = result.verdicts[0];
  const decision: GateResult["decision"] = verdict.escalate
    ? "escalate"
    : verdict.answer === "deny"
      ? "deny"
      : "allow";

  return {
    decision,
    confidence: verdict.confidence,
    reason: verdict.reason,
    distribution: verdict.distribution,
    hint: verdict.hint,
    backend: result.backend,
    latencyMs: result.latencyMs,
    usage: result.usage,
  };
}
