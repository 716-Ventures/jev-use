/**
 * Backend abstraction. A backend answers a batch of already-screened
 * questions against one state. Adapters (typesafe / openrouter / vercel)
 * translate to each provider's wire format; the rest of jev-use only
 * ever sees these canonical shapes.
 */

import type { Question, State, Usage } from "../protocol.js";

/** One raw answer, before the confidence check that may escalate it. */
export interface RawAnswer {
  /** noul → probability; choice → winning option; score → fractional level index. */
  answer: number | string;
  /** choice/score: distribution, if the provider returns one. */
  distribution?: Record<string, number>;
  /** score: index → level description, if the provider echoes it. */
  legend?: Record<string, string>;
  /** Provider-reported confidence in [0,1], if any. */
  confidence?: number;
}

/** One batch as an adapter receives it. */
export interface BackendRequest {
  state: State;
  /** Already screened; ids resolved and unique. */
  questions: (Question & { id: string })[];
  model?: string;
}

/** One batch as an adapter answers it. */
export interface BackendResponse {
  /** Same order as the request's questions. */
  answers: RawAnswer[];
  model?: string;
  latencyMs?: number;
  usage?: Usage;
}

/** What every backend — remote adapter or local mock — must provide. */
export interface JevBackend {
  /** Short id, surfaced in results: "typesafe" | "openrouter" | ... */
  readonly name: string;
  /**
   * Escalation threshold matched to this backend's confidence semantics.
   * Margin-fallback confidence (top minus runner-up) is a systematically
   * smaller quantity than a vendor confidence head, so backends that
   * reconstruct confidence run a lower default. Unset = protocol default.
   */
  readonly defaultConfidenceThreshold?: number;
  judge(request: BackendRequest): Promise<BackendResponse>;
}

/** Thrown by adapters on transport/provider failures. */
export class BackendError extends Error {
  /** Provider-requested retry delay, when the response carried one. */
  retryAfterMs?: number;

  constructor(
    public readonly backend: string,
    message: string,
    public readonly status?: number,
    public readonly cause?: unknown,
  ) {
    super(`[${backend}] ${message}`);
    this.name = "BackendError";
  }
}
