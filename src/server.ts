/**
 * The MCP surface. Only `tools` are used — the one MCP primitive every
 * major harness (Claude Code, Codex CLI, Cursor, Gemini CLI, VS Code,
 * pi) supports — so jev-use works anywhere MCP does. The handoff-return
 * leg is expressed entirely in tool RESULTS (`escalate` + `reason`),
 * never as a server-initiated callback.
 *
 * The tools call the engine directly rather than the `Jev` client: the
 * client's extra `answers` map would duplicate every verdict in a payload an
 * LLM pays for, and a tool result is exactly the ordered `JudgeResult`.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { gate, judge } from "./judge.js";
import type { JevBackend } from "./backends/types.js";

export const SERVER_NAME = "jev-use";
export const SERVER_VERSION = "0.6.1";

/** The `Question` shape as MCP callers send it — the wire contract, unchanged. */
const questionShape = z.object({
  id: z
    .string()
    .optional()
    .describe("Your identifier for this question; echoed back in the verdict."),
  type: z
    .enum(["noul", "choice", "score"])
    .describe(
      "noul = probability that something is true; choice = pick one of enumerated options; " +
        "score = place the state on an ordered list of levels.",
    ),
  question: z.string().describe("The question, phrased about the state."),
  options: z
    .union([z.array(z.string()), z.record(z.string(), z.string())])
    .optional()
    .describe(
      "choice only: >= 2 distinct options — a list of labels, or a map of label -> what picking it means.",
    ),
  levels: z
    .array(z.string())
    .optional()
    .describe(
      "score only: >= 2 ORDERED level descriptions (e.g. ['broken', 'works but rough', 'production ready']). " +
        "The answer is a possibly-fractional index into this list.",
    ),
  criteria: z
    .object({ true: z.string(), false: z.string() })
    .optional()
    .describe("noul only (optional): what a yes and a no mean, to sharpen calibration."),
});

/** Build the MCP server: two tools over one already-resolved backend. */
export function createServer(backend: JevBackend): McpServer {
  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION });

  server.registerTool(
    "jev_judge",
    {
      title: "Batch fast judgments with Jev",
      description:
        "Hand a batch of quick judgment questions to Jev (TypeSafe AI's System One model): " +
        "~70-500ms, ~100x cheaper than reasoning them out yourself, calibrated probabilities. " +
        "Use it whenever the next step is a JUDGMENT you could answer from context — did X succeed, " +
        "which option next, how good is Y — not a generation. Batch every question you have about " +
        "one state into ONE call (batching is where the speedup comes from). " +
        "Do NOT use it for anything that needs new text/code written, or choices whose options you " +
        "cannot enumerate — that work is yours. " +
        "Each verdict returns {answer, confidence, escalate, reason, hint}. escalate=true means the " +
        "question is handed back to you: writing/open_ended = structurally yours, " +
        "oversized = the state is too big to judge, " +
        "unsure = Jev's answer is only a prior (it is still included) — decide yourself, " +
        "unreachable = Jev is down, proceed without it.",
      inputSchema: {
        state: z
          .string()
          .describe(
            "The shared context/environment both parties judge against: relevant facts, recent tool " +
            "output, file excerpts. Serialize objects to JSON. Keep it under ~30k tokens.",
          ),
        questions: z
          .array(questionShape)
          .min(1)
          .describe("All questions you have about this state — batch them."),
        confidence_threshold: z
          .number()
          .min(0)
          .max(1)
          .optional()
          .describe(
            "Escalate verdicts below this confidence. Default 0.75 (0.4 via the Vercel gateway, whose confidence is a margin fallback).",
          ),
        model: z.string().optional().describe("Backend model override, e.g. jev-latest."),
      },
    },
    async ({ state, questions, confidence_threshold, model }) => {
      const result = await judge(backend, {
        state,
        questions,
        confidenceThreshold: confidence_threshold,
        model,
      });
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      };
    },
  );

  server.registerTool(
    "jev_gate",
    {
      title: "Gate an action with Jev",
      description:
        "Ask Jev to risk-check one proposed agent action against the current state in a single " +
        "~100ms call. Returns {decision: allow|deny|escalate, confidence, hint}. " +
        "escalate means Jev is not sure enough either way — judge the action yourself. " +
        "Designed to be wired into harness hooks (PreToolUse) so gating costs zero LLM tokens; " +
        "calling it explicitly before a risky/irreversible action also works.",
      inputSchema: {
        state: z
          .string()
          .describe("Current task context the action should be judged against."),
        tool: z.string().describe("Name of the tool/command about to run."),
        input: z.string().describe("The action's input/arguments, verbatim."),
        description: z
          .string()
          .optional()
          .describe("What the action is meant to accomplish."),
        confidence_threshold: z.number().min(0).max(1).optional(),
        model: z.string().optional(),
      },
    },
    async ({ state, tool, input, description, confidence_threshold, model }) => {
      const result = await gate(backend, {
        state,
        action: { tool, input, description },
        confidenceThreshold: confidence_threshold,
        model,
      });
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      };
    },
  );

  return server;
}
