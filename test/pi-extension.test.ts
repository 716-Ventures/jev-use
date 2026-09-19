/** The pi extension registers both tools and answers through them. */

import { beforeEach, describe, expect, it, vi } from "vitest";
import registerJevUse from "../harness/pi/jev-use.js";

interface RegisteredTool {
  name: string;
  description: string;
  parameters: unknown;
  execute(
    toolCallId: string,
    params: Record<string, unknown>,
  ): Promise<{ content: { type: string; text: string }[] }>;
}

function loadExtension(): Map<string, RegisteredTool> {
  const tools = new Map<string, RegisteredTool>();
  registerJevUse({
    registerTool(tool) {
      tools.set(tool.name, tool as unknown as RegisteredTool);
    },
  });
  return tools;
}

describe("pi extension", () => {
  beforeEach(() => {
    vi.stubEnv("JEV_BACKEND", "mock");
  });

  it("registers jev_judge and jev_gate", () => {
    const tools = loadExtension();
    expect([...tools.keys()].sort()).toEqual(["jev_gate", "jev_judge"]);
  });

  it("answers a judge call through the mock backend", async () => {
    const tools = loadExtension();
    const res = await tools.get("jev_judge")!.execute("t1", {
      state: "tests: 12 passed",
      questions: [{ id: "ok", type: "noul", question: "Did tests pass?" }],
    });
    const parsed = JSON.parse(res.content[0].text);
    expect(parsed.backend).toBe("mock");
    expect(parsed.verdicts[0].id).toBe("ok");
  });

  it("fails open when no backend is configured", async () => {
    vi.stubEnv("JEV_BACKEND", "");
    vi.stubEnv("TYPESAFE_API_KEY", "");
    vi.stubEnv("OPENROUTER_API_KEY", "");
    vi.stubEnv("AI_GATEWAY_API_KEY", "");
    // fresh module state so the cached backend from other tests is dropped
    vi.resetModules();
    const { default: freshRegister } = await import("../harness/pi/jev-use.js");
    const tools = new Map<string, RegisteredTool>();
    freshRegister({
      registerTool(tool: unknown) {
        const t = tool as RegisteredTool;
        tools.set(t.name, t);
      },
    });
    const res = await tools.get("jev_gate")!.execute("t2", {
      state: "s",
      tool: "Bash",
      input: "ls",
    });
    const parsed = JSON.parse(res.content[0].text);
    expect(parsed.reason).toBe("unreachable");
    expect(parsed.escalated).toBe(true);
  });
});
