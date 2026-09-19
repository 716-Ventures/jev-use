#!/usr/bin/env node
/**
 * jev-use CLI.
 *
 *   jev-use serve             stdio MCP server (Claude Code, Codex, Cursor, ...)
 *   jev-use hook gate         PreToolUse hook adapter (Claude Code & Codex hooks)
 *   jev-use judge [json]      one-shot judgment from argv or stdin (smoke/CI)
 *   jev-use doctor            resolve the backend and run one live round trip
 *
 * Flags: --backend typesafe|openrouter|vercel|mock, --threshold 0..1
 */

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createBackend, createServerBackend } from "./backends/index.js";
import type { JevBackend } from "./backends/types.js";
import { Jev } from "./jev.js";
import { judge } from "./judge.js";
import { runInstall } from "./install.js";
import { check, type JudgeRequest } from "./protocol.js";
import { createServer, SERVER_VERSION } from "./server.js";

interface Args {
  command: string[];
  backend?: string;
  threshold?: number;
  json?: string;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { command: [] };
  for (let i = 0; i < argv.length; i++) {
    const argument = argv[i];
    if (argument === "--backend") args.backend = argv[++i];
    else if (argument === "--threshold") args.threshold = Number(argv[++i]);
    else if (argument === "--help" || argument === "-h") args.command = ["help"];
    else if (argument === "--version" || argument === "-v") args.command = ["version"];
    else if (argument.startsWith("{")) args.json = argument;
    else args.command.push(argument);
  }
  return args;
}

/**
 * One backend resolution for every command. The CLI resolves it itself —
 * rather than letting `new Jev()` do it — because `--backend` accepts any
 * string and `via` is part of what `serve` and `doctor` print.
 */
function connect(args: Args): { jev: Jev; backend: JevBackend; via: string } {
  const { backend, via } = createBackend(args.backend);
  return { jev: new Jev({ backend }), backend, via };
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

async function serve(args: Args): Promise<void> {
  const { backend, via } = createServerBackend(args.backend);
  process.stderr.write(`jev-use ${SERVER_VERSION} — backend ${backend.name} (${via})\n`);
  const server = createServer(backend);
  await server.connect(new StdioServerTransport());
}

/**
 * PreToolUse hook adapter, shared by Claude Code and Codex (their hook
 * protocols are shape-compatible). Reads the hook event on stdin, asks
 * jev_gate, and emits a permission decision:
 *
 *   deny      → permissionDecision "deny"
 *   escalate  → permissionDecision "ask"   (a human or the LLM decides)
 *   allow     → NO output: fall through to the user's normal permission
 *               flow. The gate only ever tightens, never loosens.
 *
 * Any failure is fail-open (exit 0, no output): a judgment sidecar being
 * down must never block the agent.
 */
async function hookGate(args: Args): Promise<void> {
  let event: Record<string, unknown>;
  try {
    event = JSON.parse(await readStdin()) as Record<string, unknown>;
  } catch {
    process.stderr.write("jev-use hook: stdin was not hook-event JSON\n");
    return;
  }
  try {
    const { jev } = connect(args);
    const toolInput = event.tool_input ?? {};
    const result = await jev.gate(
      [
        `An autonomous coding agent is working in: ${String(event.cwd ?? "unknown")}`,
        `Permission mode: ${String(event.permission_mode ?? "default")}`,
        "The agent proposes the tool call below. Judge only whether it is safe to run without human review.",
      ].join("\n"),
      {
        tool: String(event.tool_name ?? "unknown"),
        input: typeof toolInput === "string" ? toolInput : JSON.stringify(toolInput),
      },
      { confidenceThreshold: args.threshold ?? envNumber("JEV_GATE_THRESHOLD") },
    );

    if (result.decision === "allow") return; // stay silent: default flow decides

    const decision = result.decision === "deny" ? "deny" : "ask";
    const reason =
      result.decision === "deny"
        ? `Jev gate: denied (confidence ${result.confidence.toFixed(2)}).`
        : `Jev gate: not sure this is safe (${result.reason ?? "unsure"}) — please review.`;
    process.stdout.write(
      JSON.stringify({
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: decision,
          permissionDecisionReason: reason,
        },
      }) + "\n",
    );
  } catch (error) {
    process.stderr.write(`jev-use hook: fail-open (${String(error)})\n`);
  }
}

/**
 * One-shot judgment for smoke tests and CI. Prints the engine's result
 * verbatim — the same JSON the MCP tool returns — so it stays diffable.
 */
async function judgeOnce(args: Args): Promise<void> {
  const raw = args.json ?? (await readStdin());
  const request = JSON.parse(raw) as JudgeRequest;
  const { backend } = connect(args);
  const result = await judge(backend, {
    ...request,
    confidenceThreshold: request.confidenceThreshold ?? args.threshold,
  });
  process.stdout.write(JSON.stringify(result, null, 2) + "\n");
  process.exitCode = result.escalated ? 3 : 0;
}

async function doctor(args: Args): Promise<void> {
  const { jev, via } = connect(args);
  process.stdout.write(`backend : ${jev.backend.name}\nvia     : ${via}\n`);
  const started = Date.now();
  const { answers, model } = await jev.judge(
    "doctor check: the string 'jev-use' appears in this state.",
    { ping: check("Does the state mention jev-use?") },
  );
  const ping = answers.ping;
  process.stdout.write(
    `round   : ${Date.now() - started}ms (model ${model ?? "?"})\n` +
      `verdict : p=${String(ping.answer)} confidence=${ping.confidence.toFixed(2)} escalate=${ping.escalate}\n`,
  );
  if (ping.reason === "unreachable") {
    process.stdout.write(`error   : ${ping.hint ?? "unknown"}\n`);
    process.exitCode = 1;
  }
}

const HELP = `jev-use ${SERVER_VERSION} — the typed handoff between your LLM and Jev

usage:
  jev-use install [claude|codex|pi]      wire the MCP server into your harness (all found, if no target)
  jev-use serve [--backend name]         stdio MCP server
  jev-use hook gate [--threshold 0.75]   PreToolUse hook adapter (Claude Code / Codex)
  jev-use judge ['{...}']                one-shot JudgeRequest from argv or stdin
  jev-use doctor                         backend resolution + one live round trip

backends: typesafe (TYPESAFE_API_KEY) | openrouter (OPENROUTER_API_KEY)
        | vercel (AI_GATEWAY_API_KEY) | mock. Auto-detected from env,
        or forced with --backend / JEV_BACKEND. Model override: JEV_MODEL.
`;

function envNumber(name: string): number | undefined {
  const value = process.env[name];
  if (value === undefined) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const [command, subcommand] = args.command;
  try {
    if (command === "install") process.exitCode = runInstall(subcommand);
    else if (command === "serve") await serve(args);
    else if (command === "hook" && subcommand === "gate") await hookGate(args);
    else if (command === "judge") await judgeOnce(args);
    else if (command === "doctor") await doctor(args);
    else if (command === "version") process.stdout.write(`${SERVER_VERSION}\n`);
    else process.stdout.write(HELP);
  } catch (error) {
    process.stderr.write(
      `jev-use: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  }
}

void main();
