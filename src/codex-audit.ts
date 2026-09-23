/** Content-free, local audit trail for automatic Codex hook judgments. */
import { appendFileSync, chmodSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { JevBackend } from "./backends/types.js";
import { postToolUse, preToolUse, stop, type CodexEvent, type HookOutput } from "./codex-hooks.js";

export type CodexHookKind = "pre" | "post" | "stop";
const handlers = { pre: preToolUse, post: postToolUse, stop };

function safeId(value: unknown): string | undefined {
  return typeof value === "string" && /^[A-Za-z0-9_.-]{1,120}$/.test(value) ? value : undefined;
}

function auditPath(): string {
  return process.env.JEV_AUDIT_LOG ?? join(process.env.CODEX_HOME ?? join(homedir(), ".codex"), "jev-use-audit.jsonl");
}

function appendAudit(record: Record<string, unknown>): void {
  try {
    const path = auditPath();
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    appendFileSync(path, JSON.stringify(record) + "\n", { encoding: "utf8", mode: 0o600 });
    chmodSync(path, 0o600);
  } catch {
    // The audit must never change the hook's judgment or fail a tool call.
    process.stderr.write("jev-use audit: unable to write audit record\n");
  }
}

function effect(kind: CodexHookKind, output: HookOutput): string {
  if (!output) return "none";
  if (kind === "pre") {
    const specific = output.hookSpecificOutput as Record<string, unknown> | undefined;
    return specific?.permissionDecision === "deny" ? "deny" : "context";
  }
  return output.decision === "block" ? "block" : "none";
}

/** Logs a hook that started but could not construct its backend. */
export function recordCodexHookSetupFailure(kind: CodexHookKind, event: CodexEvent, reason: string): void {
  appendAudit({
    time: new Date().toISOString(), event: kind,
    sessionId: safeId(event.session_id), turnId: safeId(event.turn_id), toolName: safeId(event.tool_name),
    status: "setup_error", skipReason: reason,
    backendCalls: 0, backendSuccesses: 0, backendErrors: 0, effect: "none", durationMs: 0,
  });
}

/** Records hook invocation separately from an actual backend request. */
export async function runCodexHook(kind: CodexHookKind, event: CodexEvent, backend: JevBackend): Promise<HookOutput> {
  const started = Date.now();
  let backendCalls = 0;
  let backendSuccesses = 0;
  let backendErrors = 0;
  let skipReason: string | undefined;
  let jevDecision: string | undefined;
  let output: HookOutput;
  let failed = false;
  const observedBackend: JevBackend = {
    name: backend.name,
    async judge(request) {
      backendCalls++;
      try {
        const response = await backend.judge(request);
        backendSuccesses++;
        return response;
      } catch (error) {
        backendErrors++;
        throw error;
      }
    },
  };
  try {
    const onSkip = (reason: string) => { skipReason = reason; };
    output = kind === "pre"
      ? await preToolUse(event, observedBackend, onSkip, (decision) => { jevDecision = decision; })
      : await handlers[kind](event, observedBackend, onSkip);
    return output;
  } catch (error) {
    failed = true;
    throw error;
  } finally {
    appendAudit({
      time: new Date().toISOString(),
      event: kind,
      sessionId: safeId(event.session_id),
      turnId: safeId(event.turn_id),
      toolName: safeId(event.tool_name),
      backend: backend.name,
      status: failed ? "hook_error" : backendSuccesses > 0 ? "judged" : backendErrors > 0 ? "backend_error" : "skipped",
      ...(skipReason ? { skipReason } : {}),
      ...(jevDecision ? { jevDecision } : {}),
      backendCalls,
      backendSuccesses,
      backendErrors,
      effect: effect(kind, output),
      durationMs: Date.now() - started,
    });
  }
}
