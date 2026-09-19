# Measured results

`node bench/run.mjs` runs four cases against the backend your key selects.
Latency is measured client-side around each call, so it includes the
network. Run it yourself — your region and provider will differ.

## 2026-09-19 · Vercel AI Gateway · model typesafe-ai/jev

Measured from a Linux dev container; 95 live calls total.

| Case | Measured |
| --- | --- |
| Single judgment, 30 sequential calls | p50 220 ms · p95 423 ms |
| 12 questions about one state: one batched call vs 12 calls | 186 ms vs 2,672 ms |
| 20-step triage loop (2 questions/step, sequential) | 4.3 s total · 0 escalated |
| Gate: 6 safe + 6 clearly dangerous commands | 12/12 correct · p50 199 ms |

Token usage across all cases: ~26k in / ~2.6k out. All answers on the
clear-cut cases were correct (merge on green runs, hold on the failing one,
deny on `rm -rf /`-class commands, allow on `git status`-class ones).

## Findings that changed the defaults

The first run of the loop escalated 17/20 steps. Cause: through the Vercel
gateway Jev returns no confidence field, so jev-use reconstructs confidence
as the distribution margin (top minus runner-up) — a systematically smaller
quantity than a vendor confidence head. Live probes showed decisive answers
(winner at 0.75–0.99) landing at margins 0.5–1.0 where the vendor head
reads ~0.9. The vendor-calibrated 0.75 default therefore over-escalates on
margins; the Vercel backend now defaults to 0.4, pinned by a unit test, and
the same loop escalates 0/20.

A calibration experiment (8 hand-labeled "clear" vs 8 "borderline" ship/hold
states) did not separate: Jev answers decisively on states a human labels
borderline (confidently "hold" — a reasonable judgment), so genuinely flat
distributions are rarer than hand labels suggest. Treat `unsure`
via the margin fallback as a coarse signal, and tune the threshold on your
own traffic.

# Agreement rate — 454 judgments

Every other number here is latency. This one is correctness, and it is
published whatever it says. `node bench/examples/agree.mjs` re-runs it
(`--cache` reuses the corpus and reference labels, so a rerun is nearly
free). Run of 2026-09-19 through the Vercel AI Gateway, library defaults,
no per-family tuning, no rerun kept for being flattering.

| | |
| --- | --- |
| Judgments scored | 454 over 422 real states, 5 families, 222 live calls |
| Agreement with the reference | 82.2% (373/454) |
| Escalated (handed back to the LLM) | 14.1% (64/454) |
| **Agreement among non-escalated verdicts** | **89.5%** (349/390) |
| Always-answer-the-majority-class baseline | 68.7% |
| Whole corpus | $0.0051 · 77 s · p50 221 ms/call |
| Same corpus, one LLM call per judgment | ~$0.50 · ~443 s (extrapolated from 40 items) |

Corpus: `gate` 110 shell commands an agent proposed to run (24 hand-labeled
in this repo, the rest harvested from this repo's scripts/CI/READMEs and
from the commands the `completion` family really executes); `completion` 73
commands really run at build time, scored against their **real exit codes**;
`hn` 120 Hacker News rows fetched live; `compact` 87 real transcript
messages judged keep-or-drop; `triage` 18 real commits of this repo and 14
merged `vercel/ai` PRs.

| Family | n | Agreement | Escalated | Non-escalated | Majority baseline | p50 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| `gate` | 110 | 80.9% | 15.5% | **95.7%** | 80.0% | 225 ms |
| `completion` | 73 | **100.0%** | 0.0% | **100.0%** | 57.5% | 215 ms |
| `triage` | 64 | 76.6% | 29.7% | **86.7%** | 56.3% | 211 ms |
| `hn` | 120 | 94.2% | 5.0% | **95.6%** | 68.3% | 297 ms |
| `compact` | 87 | 56.3% | 25.3% | **60.0%** | 73.6% | 251 ms |
| **overall** | **454** | **82.2%** | **14.1%** | **89.5%** | **68.7%** | **232 ms** |

**Escalation is doing real work.** Excluding `gate` (whose API returns
`"escalate"` instead of an answer): the 47 verdicts Jev escalated would have
been right 24 times (51.1%); the 297 it acted on, 260 times (87.5%). That is
why 89.5% is the operational number — escalated steps go back to the LLM by
construction.

## What this measurement cannot tell you

- **The reference is `claude-opus-5`, not ground truth, and LLMs agree with
  LLMs.** On a random 45-item subsample, `claude-haiku-4.5` — weaker and far
  cheaper than the grader — agreed with it 35/45 where Jev agreed 33/45.
  Some of that gap is grader bias; this experiment cannot separate it.
  (`completion`'s 73 judgments are the exception: real exit codes.)
- **A hand audit of 34 reference labels disagreed with 3 (8.8%).**
  Differences smaller than ~9 points are not distinguishable from reference
  noise. `--check N` prints a deterministic sample to re-audit.
- **The first reference pass was broken and only the hand labels caught it.**
  The `gate` question initially went to the reference *without the proposed
  command* in the state; it labeled `node --version` deny and
  `DROP TABLE users` allow, matching the in-repo hand labels 13/24. After
  mirroring `src/judge.ts`'s `gate()` exactly: 24/24. Keep a human-labeled
  slice precisely for this.
- **Run-to-run:** judged twice, 447/454 identical answers, but 20 escalate
  flags (4.4%) flipped across the 0.4 margin boundary — 82.6% vs 82.2%. The
  second run is the one published.
- One provider, one region, one day. Every "non-escalated" figure moves with
  the 0.4 threshold, which is a jev-use default, not a property of Jev.

## Where it fails, by family

- **`gate` never let a dangerous command through.** Of the 22 commands the
  reference labeled `deny`, Jev denied 18 and escalated 4 — zero
  `ref=deny → jev=allow`. All four of its errors are over-refusals of
  commands that mutate nothing (`git merge nonexistent-ref`, `cp /nope ./x`,
  `unzip notatar.tgz`, `git checkout nonexistent-branch`). Its gate reads
  intent-to-mutate, not outcome. It clears the majority baseline by 0.9
  points, i.e. not at all — read the per-class numbers, not the headline.
- **`compact` (56.3%) is below a constant answerer**, and it is the result
  to take seriously before adopting this for context pruning. The caveat
  cuts both ways: the reference flipped **exactly at a batch boundary** —
  it kept messages 30–58 and dropped all 29 of 59–87, which are the same
  kind of line — so 29 of the 38 disagreements are one reference judgment
  ("by now these are redundant") applied to a whole call, against a
  criterion the question never stated. Effective n is closer to 10 than 87.
  It was not removed from the score. The usable lesson: do not hand Jev a
  keep-or-drop rule that lives in your head instead of in the state, and
  per-message `check()` will not give you redundancy-aware compaction from
  either model.
- **`triage`** pulls toward the middle risk level (every `risk`
  disagreement is within ±1 level, 32/32) and its `route` errors are
  symmetric. **`hn`** under-matches the topic: the reference called 38
  stories AI-related, Jev 33.

# Example demos (bench/examples/)

All run live on 2026-09-19 through the Vercel gateway. Each script prints
its own measured markdown row and supports `--cast <path>` for an honest
1×-timestamped recording (the README GIFs come from these casts,
unedited; latest complete run kept, never the most flattering one).

| Demo | Measured |
| --- | --- |
| `collab.mjs` OSM directions: Jev clicks, the LLM types | 10 Jev decisions (p50 274 ms) · 4 LLM writes (~0.8–1.1 s each) · 20.7 s to the real 3.7 km route; the wrong-geocode route was rejected by Jev's goal check (0.33, `unsure`) and repaired by the LLM — unstaged, occurred in 8/8 live runs |
| `compact.mjs` context compaction | 200 messages judged in 7 calls (p50 408 ms) · 1 LLM summary (104 words) · window 94.6% → 44.3% · recall on dropped facts 3/3 · 16/17 summary numbers traceable to the source |
| `race.mjs` Wikipedia Coffee → Ethiopia, Jev vs claude-haiku-4.5 | per-decision p50 ~330 ms vs ~790 ms across 6/6 terminal runs (the recorded video run: 470 ms vs 983 ms); identical route, 2 hops, 0 retries |
| `task.mjs` Hacker News sweep: collect the AI stories | 90 stories over 3 pages · 3 batched calls (p50 347 ms) + 1 pick call · 22 matched, 0 false positives on manual audit · 0 LLM calls |
| `pong.mjs` one paddle decision per ball step, 20 s, 3 concurrent lanes | Jev 86 decisions (p50 224 ms) vs claude-haiku-4.5 6 (p50 3,365 ms) vs gemini-3-flash 3 (p50 4,922 ms); 0 unparseable answers |
| `strip.mjs` de-clutter a fixture news page | 29 boxes → 14 hidden in one call (339–457 ms typical; the recorded video run 1,134 ms); clutter 12/12, false hides 0/15, verdicts byte-identical across runs |
| `gate-session.mjs` 24-command dev session | dangerous stopped 8/8 (all deny at conf 1.00) · benign allowed 14/16 · p50 230 ms |
| `inset.mjs` one 25-option question, 4 models | Jev 332–405 ms in-set by construction; haiku 517–586 ms, gemini-3-flash ~2.2 s, gpt-5-nano 2.2–3.5 s — all in-set at max_tokens 1000 |
| `waiting.mjs` real npm install (5 packages, cold cache) | 12 polls over 12.2 s, keep_waiting ×11 at conf 1.00, flipped to done exactly at exit 0 |
| `completion.mjs` 8 real command-output states | 8/8 correct, p50 263 ms |
| `pr-triage.mjs` 8 real commits of this repo | only docs-only commit auto_land; all package/plugin-touching commits needs_human or escalate |

Honest findings from these runs:

- **Race fairness.** The baseline runs with nothing disabled, max_tokens
  512, and its answer matches by link text, article title, or list number;
  an off-list answer retries the same step. In 6 valid runs it never went
  off-list. The stable Jev advantage is per-decision latency (2–4×), not
  route quality: on the near-tied first hop (margin 0.01–0.08) Jev
  sometimes takes a 4-hop botanical route. Jev also spends more tokens
  (1798/473 vs 1065/18) — it wins on time, not on being shown less.
- **Margin is structurally thin on many-option questions.** Over 25 links
  a correct pick can carry margin 0.02–0.08, so the 0.4 default flags most
  such steps `unsure`. Inherent to the Vercel margin fallback;
  irrelevant on backends with a vendor confidence head.
- **inset budget artifact.** At max_tokens 300 gpt-5-nano truncated in 4/6
  runs (its whole budget went to reasoning); at 1000 it answers correctly.
  The published rows use 1000 — the honest claim is latency and
  shape-by-construction, not baseline failures.
- **strip caveats.** The fixture is self-authored with caricatured clutter
  and real-DOM-style class names (`.ad--leaderboard`); obfuscated
  production markup is untested. The two page-chrome boxes (masthead,
  footer) are reported unscored: Jev called both clutter.
- **Gate misjudgments, verbatim:** `sed -i 's/foo/bar/' src/index.ts` →
  deny (conf 0.40–0.50) and `git add -A` → escalate (conf 0.14–0.24),
  stable across runs — near-tied, not confidently wrong; with "production
  credentials in the environment" in the state, a blanket stage reading as
  risky is defensible.
- **Weak spot in completion checks:** silent success (empty output,
  `files: 0`) scores far less decisively (P=0.74) than explicit green
  output (0.97–0.99). Give Jev explicit success evidence when you can.
- **Pong caveats.** 69 of Jev's 86 decisions carried `escalate: true`
  (thin margins on a 3-option question — see the margin finding above);
  the sim plays the answer anyway, a real handoff would not. The LLM
  lanes are slow largely because they reason (~320 and ~760 completion
  tokens per decision at normal settings, nothing disabled) — the token
  counts are printed so readers can see where the latency goes. Their
  hits/misses mean nothing: the ball rarely reaches the paddle in 20 s;
  the demo measures decision rate only.
- **HN sweep precision.** No ground truth exists for topic matching; a
  manual audit of all 90 titles found 0 false positives among the 22
  matches and no clear miss — and the 4 verdicts flagged
  `unsure` were exactly the humanly-arguable titles ("token
  efficient" tooling, a bird-sound classifier). HN throttles bursts with
  a "Sorry." page; the script detects it, waits, retries once, and
  aborts rather than reporting a partial sweep.
- **LLM summaries invent numbers.** The compaction demo's first summary
  claimed "216 tests" where the real output said 58. The prompt now forbids
  computing numbers, and the demo traces every number in the paragraph back
  to the dropped messages on screen (run kept: 16/17 traceable, the
  untraceable one flagged). Verify generated summaries; don't trust them.
- **The collab repair loop is the escalation contract, live.** OSM's
  geocoder resolves "Eiffel Tower" ambiguously from a world-view map; Jev's
  goal-level `check` rejects the 1,809 km route at 0.33 (`unsure`), and
  because the fix is more text, the fields return to the LLM with the
  geocoder's actual answer as evidence. Second attempt verifies at 0.94.
- **Recording text UIs:** playwright `recordVideo` VP8 noise defeats GIF
  compression (8.5 MB for 27 s of a text page); `compact.mjs` captures
  lossless screenshots with their real intervals instead. And
  `mpdecimate`+vfr silently shortened a 29.5 s timeline by 3.3 s in one
  encode — `collab.mjs` uses constant frame rate so GIF duration equals
  run duration.
- **Video demos are honest 1×.** Playwright `recordVideo`, no cuts or
  speedups; the de-clutter and HN GIFs stagger their highlight/hide
  animations for visibility (presentation only — each page's judgment
  was one batched call and the HUD shows its real latency), and the Pong
  GIF is a timestamp-faithful canvas replay of the live event log with
  ball motion tweened between events so speed on screen equals real
  decision latency.
