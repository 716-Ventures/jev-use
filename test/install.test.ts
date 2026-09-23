import { describe, expect, it } from "vitest";
import { installPlan } from "../src/install.js";

describe("installPlan", () => {
  it("drives each harness's own config command using the maintained fork", () => {
    const plan = installPlan();
    expect(plan.map((s) => s.harness)).toEqual(["claude", "codex", "pi"]);

    const claude = plan[0];
    expect(claude.command).toBe("claude");
    expect(claude.args).toEqual([
      "mcp", "add", "--scope", "user", "jev", "--",
      "npx", "-y", "github:716-Ventures/jev-use#main", "serve",
    ]);

    const codex = plan[1];
    expect(codex.args).toEqual(["mcp", "add", "jev", "--", "npx", "-y", "github:716-Ventures/jev-use#main", "serve"]);

    const pi = plan[2];
    expect(pi.args).toEqual(["install", "git:github.com/716-Ventures/jev-use"]);
  });
});
