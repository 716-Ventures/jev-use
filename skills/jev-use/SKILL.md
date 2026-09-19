---
name: jev-use
description: Route quick judgment questions to Jev via the jev_judge / jev_gate MCP tools instead of reasoning them out — batching every question about one state into one call — and take the handoff back whenever a verdict says escalate. Use whenever a step is a judgment over known context (did X succeed, which option, how good, is it safe) rather than something to write.
---

# Handing off to Jev

Jev answers typed judgment questions about a state in ~100ms for ~1/100th of
the cost of reasoning them out in tokens. You stay the planner and the writer;
Jev takes the quick calls.

## Route each step, before you work on it

| The step is...                                            | Route  |
| --------------------------------------------------------- | ------ |
| Producing new content: text, code, free-form tool args     | You    |
| A judgment, but the options can't be enumerated            | You    |
| A yes/no or "did it work?" over context you already have   | `jev_judge` (noul) |
| Picking the next action from options you can list          | `jev_judge` (choice) |
| Rating quality/severity/urgency on levels you can describe | `jev_judge` (score) |
| "Is this action safe to run?" before something risky       | `jev_gate` |

## Rules that make it pay off

- **Batch.** Collect every question you have about one state and send them in
  a single `jev_judge` call — 13 batched questions cost ~12x less than 13
  calls. Never call it once per question.
- **State is everything Jev sees.** Put the relevant facts (tool output,
  file excerpts, task intent) into `state`; Jev has no other context.
- **Honor escalations.** A verdict with `escalate: true` hands that question
  back to you: `writing`/`open_ended` mean it was structurally yours;
  `oversized` means the state was too big to judge; `unsure` means Jev's
  answer is only a prior (it's still in `answer` — use it as a hint);
  `unreachable` means proceed as if Jev didn't exist.
- **Don't route trivia.** If you already know the answer, just act; a Jev
  call you didn't need is still a call.
