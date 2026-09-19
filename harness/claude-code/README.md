# Claude Code

## MCP tools

```bash
npx -y jev-use install claude    # runs `claude mcp add` for you, pinned
```

## Plugin form: tools + routing skill

The repo root is a Claude Code plugin: installing it adds a skill teaching
the routing rules on top of the tools.

```bash
git clone https://github.com/shitianfang/jev-use && cd jev-use && npm install
claude --plugin-dir .
```

(`/plugin install jev-use` also works from a marketplace that lists it.)

Manual wiring, in any project's `.mcp.json`:

```json
{
  "mcpServers": {
    "jev": { "command": "npx", "args": ["-y", "jev-use@0.6.1", "serve"] }
  }
}
```

Set one backend credential in the environment: `TYPESAFE_API_KEY`,
`OPENROUTER_API_KEY`, or `AI_GATEWAY_API_KEY` (see the root README).

## Optional: zero-token PreToolUse gate

`jev-use hook gate` risk-checks every tool call through Jev *before* it
runs, without spending any Claude tokens. It only ever tightens: `deny` →
deny with a reason, unsure → ask, `allow` → stays silent so your normal
permission flow decides; if Jev is unreachable it fails open.

This is deliberately NOT enabled by installing the plugin. To turn it on,
copy [`gate.hooks.json`](./gate.hooks.json) into your `settings.json`
`"hooks"` key (or `.claude/settings.json` per project):

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Bash|Write|Edit",
        "hooks": [
          {
            "type": "command",
            "command": "npx -y jev-use@0.6.1 hook gate",
            "timeout": 30
          }
        ]
      }
    ]
  }
}
```

Tune with `JEV_GATE_THRESHOLD` (default 0.75): higher = more actions get
routed to a human/Claude for review.
