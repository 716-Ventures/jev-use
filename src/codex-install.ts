/** Merge and remove Codex hooks without disturbing unrelated hooks. */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const MARKER = "JEV_USE_CODEX_HOOK=1";
type Handler = { type?: string; command?: string; timeout?: number; statusMessage?: string };
type Group = { matcher?: string; hooks?: Handler[] };
type HooksFile = { hooks?: Record<string, Group[]>; [key: string]: unknown };

function quoted(value: string): string { return `'${value.replaceAll("'", "'\\''")}'`; }

function removeOwnGroups(config: HooksFile): HooksFile {
  const hooks = config.hooks ?? {};
  for (const [event, groups] of Object.entries(hooks)) {
    hooks[event] = groups.map((group) => ({
      ...group,
      hooks: (group.hooks ?? []).filter((handler) => !handler.command?.includes(MARKER)),
    })).filter((group) => (group.hooks?.length ?? 0) > 0);
  }
  return { ...config, hooks };
}

export function mergedCodexHooks(config: HooksFile, nodePath: string, cliPath: string, keychainService?: string): HooksFile {
  const result = removeOwnGroups(structuredClone(config));
  const keychain = keychainService ? ` JEV_TYPESAFE_KEYCHAIN_SERVICE=${quoted(keychainService)}` : "";
  const command = (kind: string) => `${MARKER}${keychain} ${quoted(nodePath)} ${quoted(cliPath)} hook codex ${kind}`;
  const entries: [string, Group][] = [
    ["PreToolUse", { matcher: "*", hooks: [{ type: "command", command: command("pre"), timeout: 5, statusMessage: "Jev checks the proposed action" }] }],
    ["PostToolUse", { matcher: "Bash|mcp__.*", hooks: [{ type: "command", command: command("post"), timeout: 5, statusMessage: "Jev checks fetched evidence" }] }],
    ["Stop", { hooks: [{ type: "command", command: command("stop"), timeout: 5, statusMessage: "Jev checks task completion" }] }],
  ];
  for (const [event, group] of entries) {
    (result.hooks ??= {})[event] ??= [];
    result.hooks[event].push(group);
  }
  return result;
}

export function updateCodexHooks(codexHome: string, nodePath: string, cliPath: string, install: boolean, keychainService?: string): string {
  const file = join(codexHome, "hooks.json");
  const original = existsSync(file) ? readFileSync(file, "utf8") : "{}\n";
  const parsed = JSON.parse(original) as HooksFile;
  const updated = install ? mergedCodexHooks(parsed, nodePath, cliPath, keychainService) : removeOwnGroups(structuredClone(parsed));
  mkdirSync(codexHome, { recursive: true });
  if (existsSync(file) && !existsSync(`${file}.jev-use-backup`)) {
    writeFileSync(`${file}.jev-use-backup`, original, { mode: 0o600 });
  }
  const temporary = `${file}.jev-use-tmp`;
  writeFileSync(temporary, JSON.stringify(updated, null, 2) + "\n", { mode: 0o600 });
  renameSync(temporary, file);
  return file;
}
