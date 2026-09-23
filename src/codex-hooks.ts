/** Bounded Codex lifecycle judgments. No hook calls the Codex CLI or an LLM. */
import { closeSync, fstatSync, openSync, readSync } from "node:fs";
import type { JevBackend } from "./backends/types.js";
import { gate, judge } from "./judge.js";
import type { GateResult } from "./protocol.js";
import { redactSecrets } from "./redact.js";

export type CodexEvent = Record<string, unknown>;
export type HookOutput = Record<string, unknown> | undefined;
export type SkipReporter = (reason: string) => void;

const MAX_TASK = 4_000;
const MAX_RESULT = 6_000;
const MAX_ANSWER = 4_000;

function text(value: unknown, limit: number): string {
  const serialized = typeof value === "string" ? value : JSON.stringify(value ?? "");
  return redactSecrets(serialized.slice(0, limit));
}

function length(value: unknown): number {
  return (typeof value === "string" ? value : JSON.stringify(value ?? "")).length;
}

/** Find the most recent real user message in a Codex transcript, without sending the transcript. */
export function taskFromTranscript(path: unknown): string | undefined {
  if (typeof path !== "string" || !path) return undefined;
  try {
    const fd = openSync(path, "r");
    let raw: string;
    try {
      const size = fstatSync(fd).size;
      const length = Math.min(size, 1_000_000);
      const bytes = Buffer.alloc(length);
      readSync(fd, bytes, 0, length, size - length);
      raw = bytes.toString("utf8");
    } finally {
      closeSync(fd);
    }
    for (const line of raw.split("\n").reverse()) {
      if (!line || !line.includes('"role":"user"')) continue;
      const item = JSON.parse(line) as { type?: string; payload?: { type?: string; role?: string; content?: { type?: string; text?: string }[] } };
      if (item.type !== "response_item" || item.payload?.type !== "message" || item.payload.role !== "user") continue;
      const message = item.payload.content?.filter((part) => part.type === "input_text").map((part) => part.text ?? "").join("\n").trim();
      const prompt = message?.replace(/<recommended_plugins>[\s\S]*?<\/recommended_plugins>/g, "")
        .replace(/<environment_context>[\s\S]*?<\/environment_context>/g, "").trim();
      if (prompt && prompt.length <= MAX_TASK) return redactSecrets(prompt);
    }
  } catch { /* Missing or changing transcript format: skip this judgment. */ }
  return undefined;
}

function task(event: CodexEvent): string | undefined {
  const fallback = process.env.JEV_TASK_STATE;
  return taskFromTranscript(event.transcript_path) ?? (fallback && fallback.length <= MAX_TASK ? redactSecrets(fallback) : undefined);
}

function context(event: CodexEvent, userTask: string): string {
  return `Working directory: ${text(event.cwd ?? "unknown", 300)}\nUser task: ${userTask}`;
}

/** Jev's pre-tool verdict is advisory; only Codex's own policy may block an action. */
export async function preToolUse(
  event: CodexEvent,
  backend: JevBackend,
  onSkip?: SkipReporter,
  onVerdict?: (decision: GateResult["decision"]) => void,
): Promise<HookOutput> {
  if (!event.tool_name) {
    onSkip?.("missing_tool_name");
    return undefined;
  }
  if (String(event.tool_name).startsWith("mcp__jev__")) {
    onSkip?.("jev_tool");
    return undefined;
  }
  const userTask = task(event);
  if (!userTask || length(event.tool_input) > 6_000) {
    onSkip?.(!userTask ? "missing_task_context" : "oversized_tool_input");
    return {
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        additionalContext: "Jev skipped this tool call because task context was unavailable or the input exceeded its limit. Review the action yourself.",
      },
    };
  }
  const verdict = await gate(backend, {
    state: `${context(event, userTask)}\nJudge only whether the proposed action is safe and consistent with the user task.`,
    action: { tool: String(event.tool_name), input: text(event.tool_input, 6_000) },
  });
  onVerdict?.(verdict.decision);
  if (verdict.decision === "allow") return undefined;
  if (verdict.decision === "deny") return {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      additionalContext: "Jev flagged the proposed action for review. This is advisory, not a permission denial. Follow the user's authorization and Codex's normal permission and sandbox checks.",
    },
  };
  return {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      additionalContext: `Jev could not confidently assess the pending ${String(event.tool_name)} call (${verdict.reason ?? "uncertain"}). Review it yourself before proceeding.`,
    },
  };
}

export function isFetchedResult(event: CodexEvent): boolean {
  const name = String(event.tool_name ?? "");
  if (/^mcp__.*(?:search|fetch|read|query|browse|retrieve|get_page|open_page)/i.test(name)) return true;
  if (name !== "Bash") return false;
  const input = event.tool_input as { command?: unknown } | undefined;
  return typeof input?.command === "string" && /\b(?:curl|wget|gh api)\b/.test(input.command);
}

/** Drop only confidently irrelevant retrievals. Otherwise preserve the original result. */
export async function postToolUse(event: CodexEvent, backend: JevBackend, onSkip?: SkipReporter): Promise<HookOutput> {
  const userTask = task(event);
  const fetched = isFetchedResult(event);
  if (!userTask || !fetched || event.tool_response === undefined || length(event.tool_response) > MAX_RESULT) {
    const reason = !userTask ? "missing_task_context"
      : !fetched ? "not_retrieval"
        : event.tool_response === undefined ? "missing_tool_response" : "oversized_tool_response";
    onSkip?.(reason);
    return undefined;
  }
  const result = await judge(backend, {
    state: `User task: ${userTask}\nFetched result from ${String(event.tool_name)}:\n${text(event.tool_response, MAX_RESULT)}`,
    questions: [{
      id: "relevance", type: "choice",
      question: "Does this fetched result contain evidence relevant to the user's task?",
      options: {
        relevant: "Contains facts, sources, or errors useful for the task.",
        irrelevant: "Contains no useful facts, sources, or errors for the task.",
      },
    }],
  });
  const verdict = result.verdicts[0];
  if (verdict?.escalate || verdict?.answer !== "irrelevant" || verdict.confidence < 0.9) return undefined;
  return { decision: "block", reason: "Jev found this fetched result irrelevant to the user task. Try a more targeted source or query." };
}

/** One completion check per turn. stop_hook_active prevents continuation loops. */
export async function stop(event: CodexEvent, backend: JevBackend, onSkip?: SkipReporter): Promise<HookOutput> {
  if (event.stop_hook_active === true) {
    onSkip?.("stop_hook_active");
    return undefined;
  }
  const userTask = task(event);
  if (!userTask || typeof event.last_assistant_message !== "string" || event.last_assistant_message.length > MAX_ANSWER) {
    const reason = !userTask ? "missing_task_context"
      : typeof event.last_assistant_message !== "string" ? "missing_answer" : "oversized_answer";
    onSkip?.(reason);
    return undefined;
  }
  const result = await judge(backend, {
    state: `User task: ${userTask}\nProposed final answer: ${text(event.last_assistant_message, MAX_ANSWER)}`,
    questions: [{
      id: "completion", type: "choice",
      question: "Does the proposed final answer plainly leave a specific requested part of the user's task unfinished without explaining a real blocker?",
      options: {
        finish: "No clear unmet user requirement remains, or a real blocker is explained.",
        continue: "A specific requested part is missing and can still be completed now.",
      },
    }],
  });
  const verdict = result.verdicts[0];
  if (verdict?.escalate || verdict?.answer !== "continue" || verdict.confidence < 0.9) return undefined;
  return { decision: "block", reason: "Re-check the user's explicit requirements against the work done. Complete any clearly missing part, then respond with verified results." };
}
