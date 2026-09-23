import { describe, expect, it } from "vitest";
import type { BackendRequest, BackendResponse, JevBackend } from "../src/backends/types.js";
import { isFetchedResult, postToolUse, preToolUse, stop } from "../src/codex-hooks.js";
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
  it("never converts an unknown gate answer to allow", async () => {
    const result = await gate(backend("unexpected_label"), {
      state: "test", action: { tool: "Bash", input: "rm -rf build" },
    });
    expect(result.decision).toBe("escalate");
  });

  it("uses only supported Codex pre-tool outputs", async () => {
    const unsure = await preToolUse(event, backend("allow", 0.1));
    expect(unsure).toEqual({ hookSpecificOutput: expect.objectContaining({
      hookEventName: "PreToolUse", additionalContext: expect.any(String),
    }) });
    expect(JSON.stringify(unsure)).not.toContain('"ask"');
    const denied = await preToolUse(event, backend("deny"));
    expect(denied).toEqual({ hookSpecificOutput: expect.objectContaining({ permissionDecision: "deny" }) });
    expect(await preToolUse(event, backend("allow"))).toBeUndefined();
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
