import { describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCodexHook } from "../src/codex-audit.js";
import type { JevBackend } from "../src/backends/types.js";

describe("Codex hook audit", () => {
  it("distinguishes a Jev judgment from a skipped hook without recording content", async () => {
    const directory = mkdtempSync(join(tmpdir(), "jev-audit-"));
    const path = join(directory, "audit.jsonl");
    process.env.JEV_AUDIT_LOG = path;
    process.env.JEV_TASK_STATE = "Check a tool call with private task text";
    const backend: JevBackend = {
      name: "fixture",
      async judge() { return { answers: [{ answer: "allow", confidence: 0.99 }] }; },
    };
    try {
      await runCodexHook("pre", {
        session_id: "session-1", turn_id: "turn-1", tool_name: "Bash",
        tool_input: { command: "echo secret-command" }, cwd: "/private/workspace",
      }, backend);
      await runCodexHook("post", {
        session_id: "session-1", turn_id: "turn-1", tool_name: "Bash",
        tool_input: { command: "git status" }, tool_response: "private-result",
      }, backend);
      const raw = readFileSync(path, "utf8");
      const records = raw.trim().split("\n").map((line) => JSON.parse(line));
      expect(records).toHaveLength(2);
      expect(records[0]).toMatchObject({ event: "pre", status: "judged", backendCalls: 1, backendSuccesses: 1, effect: "none" });
      expect(records[1]).toMatchObject({ event: "post", status: "skipped", skipReason: "not_retrieval", backendCalls: 0 });
      expect(raw).not.toMatch(/secret-command|private-result|private task text|\/private\/workspace/);
      expect(statSync(path).mode & 0o777).toBe(0o600);
    } finally {
      delete process.env.JEV_AUDIT_LOG;
      delete process.env.JEV_TASK_STATE;
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("records a failed backend attempt without claiming a judgment", async () => {
    const directory = mkdtempSync(join(tmpdir(), "jev-audit-error-"));
    const path = join(directory, "audit.jsonl");
    process.env.JEV_AUDIT_LOG = path;
    process.env.JEV_TASK_STATE = "Check a tool call";
    try {
      await runCodexHook("pre", { tool_name: "Bash", tool_input: { command: "pwd" } }, {
        name: "fixture",
        async judge() { throw new Error("private provider error"); },
      });
      const record = JSON.parse(readFileSync(path, "utf8"));
      expect(record).toMatchObject({ status: "backend_error", backendCalls: 1, backendSuccesses: 0, backendErrors: 1 });
      expect(readFileSync(path, "utf8")).not.toContain("private provider error");
    } finally {
      delete process.env.JEV_AUDIT_LOG;
      delete process.env.JEV_TASK_STATE;
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
