---
name: jev-use
description: Use before ANY step that is a decision rather than writing: labelling, filtering or triaging MANY items; checking whether a command, test or build succeeded; picking the next action from options you can list; judging safety, quality or severity; or risk-checking each command of a checklist or pipeline before it runs. Route by where the facts already are: facts already in your context go to the jev_judge tool with ALL questions batched into ONE call; items sitting in a file or in tool output go through the `jev-use judge` CLI from a script, so that data never enters the conversation; a safety decision that blocks every tool call belongs in the `jev-use hook gate` PreToolUse hook, not in a call you make by hand. Take any verdict back with escalate: true. Never for steps that must produce new text or code, or judgments whose options you cannot enumerate.
---

# Handing off to Jev

Per decision, measured: Jev $0.000032 / 257 ms vs claude-haiku-4.5 $0.000761 /
792 ms and claude-sonnet-5 $0.001494 / 1366 ms — 24x and 47x cheaper. That is a
RATE win ($0.042/Mtok in, $0 out), not a token win: Jev spends *more* tokens per
decision, not fewer. So the saving is real only when the decision **leaves the
conversation** — which is what the routing below is for. You stay the planner
and the writer.

## Route each decision: where are the facts × does it block?

| Where the facts are | **Nothing is blocked** — you can keep working | **Blocked** — nothing proceeds until this is decided |
| --- | --- | --- |
| **Already in your context** | `jev_judge`, every question about that state batched into **ONE** call (`noul` yes/no, `choice` next action, `score` quality) | `jev_gate` on that one action before you run it — and if it is *every* tool call, wire `jev-use hook gate` as a PreToolUse hook **once** and the decision leaves the conversation for good: 24 gated commands, 17.1 s, **zero LLM tokens**, vs 46.9 s / $0.2366 through a supervisor LLM |
| **Sitting in a file or tool output** | a script pipes the file to `jev-use judge` — the items never enter your context | same CLI, from the script, then act on the verdicts it prints |
| **To be written by you** (new text, code, options you cannot enumerate) | yours | yours |

## Rules that make it pay off

- **Never paste bulk data into `jev_judge`.** Measured on 90 items: pushing
  them through the tool by hand cost **1.66x MORE** money and 1.45x more time
  than just deciding them yourself. Instead route by reference (the CLI), or
  route only the handful you genuinely cannot settle — that lane cost less than
  pasting everything, and was the only one that got all 90 right 3 times of 3.
- **Batch.** Measured: 12 questions about one state in ONE call took 186 ms;
  the same 12 one at a time took 2,672 ms. Never one call per item.
- **State is everything Jev sees.** Put the relevant facts (tool output, file
  excerpts, task intent) into `state`; Jev has no other context.
- **Honor escalations.** A verdict with `escalate: true` hands that question
  back to you: `writing`/`open_ended` mean it was structurally yours;
  `oversized` means the state was too big to judge; `unsure` means Jev's
  answer is only a prior (it's still in `answer` — use it as a hint);
  `unreachable` means proceed as if Jev didn't exist.
- **Don't route trivia.** If you already know the answer, just act; a Jev
  call you didn't need is still a call.

Numbers, lanes, variance and caveats: `bench/RESULTS.md`.
