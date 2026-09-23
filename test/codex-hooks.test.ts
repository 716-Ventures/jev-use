import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BackendRequest, BackendResponse, JevBackend } from "../src/backends/types.js";
import { isFetchedResult, postToolUse, preToolUse, stop, taskFromTranscript } from "../src/codex-hooks.js";
import { gate } from "../src/judge.js";

function backend(answer: string, confidence = 0.99): JevBackend {
  return {
    name: "fixture",
    async judge(_request: BackendRequest): Promise<BackendResponse> {
      return { answers: [{ answer, confidence }] };
    },
  };
}

const event = { tool_name: "Bash", tool_input: { command: "rm -rf build" }, cwd: "/project" };

describe("Codex hooks", () => {
  it("extracts the actual task after Codex app metadata", () => {
    const directory = mkdtempSync(join(tmpdir(), "jev-transcript-"));
    const path = join(directory, "rollout.jsonl");
    try {
      writeFileSync(path, JSON.stringify({ type: "response_item", payload: {
        type: "message", role: "user", content: [{ type: "input_text", text:
          "<recommended_plugins>many plugin names</recommended_plugins>\n<environment_context>app metadata</environment_context>\nRun pwd once." }],
      } }) + "\n");
      expect(taskFromTranscript(path)).toBe("Run pwd once.");
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });

  it("never converts an unknown gate answer to allow", async () => {
    const result = await gate(backend("unexpected_label"), {
      state: "test", action: { tool: "Bash", input: "rm -rf build" },
    });
    expect(result.decision).toBe("escalate");
  });

  it("uses only supported Codex pre-tool outputs", async () => {
    process.env.JEV_TASK_STATE = "Clean up the build folder";
    try {
      const unsure = await preToolUse(event, backend("allow", 0.1));
      expect(unsure).toEqual({ hookSpecificOutput: expect.objectContaining({
        hookEventName: "PreToolUse", additionalContext: expect.any(String),
      }) });
      expect(JSON.stringify(unsure)).not.toContain('"ask"');
      const denied = await preToolUse(event, backend("deny"));
      expect(denied).toEqual({ hookSpecificOutput: expect.objectContaining({
        hookEventName: "PreToolUse", additionalContext: expect.stringContaining("advisory"),
      }) });
      expect(JSON.stringify(denied)).not.toContain("permissionDecision");
      expect(await preToolUse(event, backend("allow"))).toBeUndefined();
      const oversized = await preToolUse({ ...event, tool_input: { command: "x".repeat(7_000) } }, backend("allow"));
      expect(oversized).toEqual({ hookSpecificOutput: expect.objectContaining({ additionalContext: expect.stringContaining("exceeded") }) });
    } finally { delete process.env.JEV_TASK_STATE; }
  });

  it("filters fetched results and only blocks confident irrelevant evidence", async () => {
    expect(isFetchedResult({ tool_name: "mcp__docs__fetch_page" })).toBe(true);
    expect(isFetchedResult(event)).toBe(false);
    const fetched = { tool_name: "mcp__docs__fetch_page", tool_response: "unrelated article" };
    process.env.JEV_TASK_STATE = "Find Codex hook docs";
    try {
      expect(await postToolUse(fetched, backend("irrelevant"))).toEqual({
        decision: "block", reason: expect.any(String),
      });
      expect(await postToolUse(fetched, backend("relevant"))).toBeUndefined();
      expect(await postToolUse(fetched, backend("irrelevant", 0.5))).toBeUndefined();
    } finally { delete process.env.JEV_TASK_STATE; }
  });

  it("continues once for a confident missing requirement", async () => {
    process.env.JEV_TASK_STATE = "Build a working integration";
    try {
      const base = { last_assistant_message: "I drafted the plan." };
      expect(await stop(base, backend("continue"))).toEqual({ decision: "block", reason: expect.any(String) });
      expect(await stop({ ...base, stop_hook_active: true }, backend("continue"))).toBeUndefined();
      expect(await stop(base, backend("finish"))).toBeUndefined();
    } finally { delete process.env.JEV_TASK_STATE; }
  });
});
