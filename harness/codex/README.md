# Codex integration in this fork

This fork adds three synchronous Codex hook commands. Codex itself is unchanged.

| Hook | Command | Judgment |
| --- | --- | --- |
| `PreToolUse` | `hook codex pre` | Is the proposed tool call safe and consistent with the task? |
| `PostToolUse` | `hook codex post` | Is a fetched result relevant to the task? |
| `Stop` | `hook codex stop` | Is a requested part plainly unfinished? |

The post hook runs only for retrieval-shaped MCP tools and Bash calls using
`curl`, `wget`, or `gh api`. It discards a result only when Jev says `irrelevant`
with confidence at least 0.9. The stop hook requests at most one continuation
per turn. Uncertain verdicts leave control with Codex. The pre hook uses Codex's
supported `additionalContext` on uncertainty; Codex does **not** support the
`permissionDecision: "ask"` shape used by the older generic hook adapter.

## Install from a stable clone

Use Node.js 20+. For TypeSafe direct on macOS, store the key in Keychain from
your own terminal; `security` prompts for it without placing it in shell
history or in the Codex conversation:

```bash
security add-generic-password -a "$(whoami)" -s jev-use-typesafe -U -w
```

You can instead make `TYPESAFE_API_KEY` available in the environment that
launches Codex. `JEV_BACKEND=mock` is only for local contract tests; mock
judgments are not real safety decisions.

```bash
npm ci
npm run build
JEV_TYPESAFE_KEYCHAIN_SERVICE=jev-use-typesafe node dist/cli.js doctor
JEV_TYPESAFE_KEYCHAIN_SERVICE=jev-use-typesafe node dist/cli.js install codex-hooks
codex mcp add jev -- env JEV_TYPESAFE_KEYCHAIN_SERVICE=jev-use-typesafe node /absolute/path/to/your/clone/dist/cli.js serve
```

`install codex-hooks` checks backend configuration, then merges the three hook
entries into `~/.codex/hooks.json`. It preserves other hooks, writes a backup
at `~/.codex/hooks.json.jev-use-backup`, and can be rerun without duplicates.
Keep the clone at the same path: hook commands use its absolute `dist/cli.js`
path. Use `node dist/cli.js uninstall codex-hooks` to remove only this fork's
hook handlers. Review and trust the changed hooks via `/hooks` in Codex.

The MCP server is optional for automatic hooks. Its tools are useful when Codex
explicitly asks Jev to judge facts already in context. Configure the key in
Codex's process environment for the hooks, and in the MCP server environment if
you use that server. `jev-use doctor` makes a live round trip once the key is
available.

## Context and limits

The hooks read the latest user message from `transcript_path` when available.
They send at most 4,000 characters of that message, 6,000 characters of a
fetched result, or 4,000 characters of the proposed final answer. Set
`JEV_TASK_STATE` to supply context when no transcript is available. Built-in
redaction masks common credential formats, but it is not a guarantee that all
private data is removed; inspect provider data policy before enabling automatic
remote judgments for sensitive work.

Oversized tool inputs are returned to Codex for review, and oversized fetched
results or proposed answers are left untouched. Jev does not make a decisive
judgment from a truncated result.

Each automatic judgment uses one HTTP attempt with a 2.5-second request
limit. Override with `JEV_HTTP_TIMEOUT_MS` and `JEV_HTTP_RETRIES` if needed.
A backend failure or missing task context leaves Codex to handle the event.

Codex's local hooks do not cover hosted web search or every specialized tool
path. Route retrieval through a hook-covered local or MCP tool when a
post-fetch judgment is required.
