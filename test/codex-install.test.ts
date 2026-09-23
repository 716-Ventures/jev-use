import { describe, expect, it } from "vitest";
import { mergedCodexHooks } from "../src/codex-install.js";

describe("Codex hook installation", () => {
  it("preserves existing handlers and stays idempotent", () => {
    const existing = { hooks: { Stop: [{ hooks: [{ type: "command", command: "node /other/hook.js" }] }] } };
    const once = mergedCodexHooks(existing, "/usr/bin/node", "/opt/jev/dist/cli.js");
    const twice = mergedCodexHooks(once, "/usr/bin/node", "/opt/jev/dist/cli.js");
    expect(twice).toEqual(once);
    expect(twice.hooks!.Stop).toHaveLength(2);
    expect(twice.hooks!.Stop[0].hooks![0].command).toBe("node /other/hook.js");
    expect(twice.hooks!.PreToolUse[0].hooks![0].command).toContain("hook codex pre");
    expect(twice.hooks!.PostToolUse[0].hooks![0].command).toContain("hook codex post");
  });
});
