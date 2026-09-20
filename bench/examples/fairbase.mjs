/**
 * Example: the FAIR baseline. Is Jev still faster once the chat models are
 * allowed to stop reasoning?
 *
 * `pong.mjs` measures decision RATE with nothing disabled on the chat lanes:
 * max_tokens 1000, free text, reason-then-answer. That is an honest picture of
 * a naive caller, and a dishonest picture of the models — a reviewer is right
 * to object that a one-of-three answer should be asked for with the enum
 * pinned and the thinking turned off. This script settles that objection by
 * asking the SAME question about the SAME states five ways:
 *
 *   jev            typed `pick` over {up, down, stay} — the answer is an
 *                  element of the option set by construction.
 *   haiku-free     anthropic/claude-haiku-4.5 exactly as pong.mjs calls it
 *                  (max_tokens 1000, plain prompt). The control that has to
 *                  reproduce the published row.
 *   haiku-strict   same model, answer pinned to the enum by a strict
 *                  json_schema response_format, max_tokens 16.
 *   gemini-free    google/gemini-3-flash as pong.mjs calls it.
 *   gemini-strict  same model, same json_schema, max_tokens 64, and thinking
 *                  switched OFF via providerOptions.google.thinkingConfig.
 *
 * Fairness is mechanical: ONE set of N states, generated once by rolling
 * pong.mjs's own deterministic physics forward from a seeded decision
 * sequence, is replayed to every arm in every run — so no arm sees an easier
 * board. Arms are interleaved per state (and rotated, so no arm always goes
 * first) instead of being run in blocks, which keeps a slow minute from
 * landing on one arm alone. Every call is counted once: there are NO retries,
 * and a transport error is recorded as an error rather than re-rolled.
 *
 * Alongside latency and tokens each arm is scored against a geometric
 * reference move — the ball is projected forward through the wall bounces to
 * the paddle plane, and the move that carries the paddle band toward that
 * intercept (or `stay`, when the band already covers it) is the reference.
 * It is a heuristic, not ground truth for "good Pong", but it is identical
 * for every arm, so the agreement column is comparable across arms.
 *
 * Environment: AI_GATEWAY_API_KEY (every arm — Jev and both chat models).
 *
 * Run:  node bench/examples/fairbase.mjs [--n 40] [--runs 2] [--json out.json]
 */

import { writeFileSync } from "node:fs";
import { Jev, pick } from "../../dist/index.js";

const argv = process.argv.slice(2);
const flag = (name) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : undefined);
const N = Number(flag("--n") ?? 40);
const RUNS = Number(flag("--runs") ?? 2);
const SEED = Number(flag("--seed") ?? 7);
const jsonPath = flag("--json");

// ---- the question, verbatim from pong.mjs -----------------------------------
const FIELD = { w: 280, h: 272 };
const PADDLE = { x: 268, w: 8, h: 56, step: 22 };
const BALL = { r: 6, x: 40, y: 80, vx: 16, vy: 11 };
const MOVES = ["up", "down", "stay"];
const QUESTION = "Move the paddle to intercept the ball. Which move?";
const OPTIONS = { up: "move the paddle up", down: "move the paddle down", stay: "keep the paddle where it is" };
const FREE_MAX_TOKENS = 1000; // pong.mjs's setting, reproduced exactly
const GATEWAY = process.env.AI_GATEWAY_BASE_URL ?? "https://ai-gateway.vercel.sh";

/** The enum, as a strict JSON schema — the constraint mechanism both strict arms use. */
const SCHEMA = {
  type: "object",
  properties: { move: { type: "string", enum: MOVES } },
  required: ["move"],
  additionalProperties: false,
};
const RESPONSE_FORMAT = { type: "json_schema", json_schema: { name: "move", strict: true, schema: SCHEMA } };
/** Gemini 3 keeps thinking unless the provider's own budget is zeroed; `reasoning_effort` does not reach it. */
const GEMINI_NO_THINKING = { providerOptions: { google: { thinkingConfig: { thinkingBudget: 0, includeThoughts: false } } } };

const jev = new Jev();
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const r0 = (v) => Math.round(v);
const pct = (xs, p) => {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return Math.round(s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))]);
};
const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
// bold, dim, green, yellow, red, cyan, reset
const [B, D, G, Y, R, C, X] = ["1m", "2m", "32m", "33m", "31m", "36m", "0m"].map((c) => `\x1b[${c}`);

// ---- the shared state set ---------------------------------------------------
/** pong.mjs's physics, lifted unchanged, so the states are ones that sim really reaches. */
function advance(s, decision) {
  if (decision === "up") s.paddleY -= PADDLE.step;
  else if (decision === "down") s.paddleY += PADDLE.step;
  s.paddleY = clamp(s.paddleY, 0, FIELD.h - PADDLE.h);
  const b = s.ball;
  b.x += b.vx;
  b.y += b.vy;
  if (b.y < BALL.r) (b.y = BALL.r), (b.vy = -b.vy);
  if (b.y > FIELD.h - BALL.r) (b.y = FIELD.h - BALL.r), (b.vy = -b.vy);
  if (b.x < BALL.r) (b.x = BALL.r), (b.vx = -b.vx);
  if (b.vx <= 0 || b.x + BALL.r < PADDLE.x) return;
  if (b.y >= s.paddleY - BALL.r && b.y <= s.paddleY + PADDLE.h + BALL.r) {
    (b.x = PADDLE.x - BALL.r), (b.vx = -b.vx);
    return;
  }
  s.resets++;
  Object.assign(b, { x: BALL.x, y: BALL.y, vx: BALL.vx, vy: s.resets % 2 ? -BALL.vy : BALL.vy });
}

/** The state handed to every arm — pong.mjs's shape and rounding. */
const stateOf = (s) => ({
  ball: { x: r0(s.ball.x), y: r0(s.ball.y), vx: s.ball.vx, vy: s.ball.vy },
  paddle: { x: PADDLE.x, y: r0(s.paddleY), h: PADDLE.h },
  field: FIELD,
});

/**
 * N distinct states, reachable by the real sim: roll the physics forward with a
 * seeded decision sequence and snapshot whenever the ball is heading toward the
 * paddle (`vx > 0`), which is the only board on which the question has an answer
 * worth grading. Seeded, so every arm and every run sees the identical set.
 */
function buildStates(n, seed) {
  let x = seed >>> 0;
  const rnd = () => ((x = (x * 1664525 + 1013904223) >>> 0) / 2 ** 32);
  const sim = { ball: { ...BALL }, paddleY: (FIELD.h - PADDLE.h) / 2, resets: 0 };
  const out = [];
  while (out.length < n) {
    advance(sim, MOVES[Math.floor(rnd() * 3)]);
    if (sim.ball.vx > 0) out.push(stateOf(sim));
  }
  return out;
}

/**
 * Geometric reference move: project the ball to the paddle plane through the
 * wall bounces, then name the move that carries the paddle band toward that
 * intercept. A heuristic reference — identical for every arm, so agreement with
 * it is comparable across arms, but it is not "the one right answer".
 */
function referenceMove(st) {
  const span = FIELD.h - 2 * BALL.r;
  const steps = (PADDLE.x - BALL.r - st.ball.x) / st.ball.vx;
  // Reflect the unbounded landing point back into the field (triangle wave).
  const raw = st.ball.y - BALL.r + st.ball.vy * steps;
  const m = ((raw % (2 * span)) + 2 * span) % (2 * span);
  const y = (m <= span ? m : 2 * span - m) + BALL.r;
  if (y >= st.paddle.y - BALL.r && y <= st.paddle.y + PADDLE.h + BALL.r) return "stay";
  return y < st.paddle.y ? "up" : "down";
}

// ---- the arms ---------------------------------------------------------------
const promptFor = (state) =>
  `Pong state (JSON): ${JSON.stringify(state)}\n\n${QUESTION}\nAnswer with exactly one word: up, down, or stay.`;

/**
 * pong.mjs's parser for a free-text answer, as generous as a caller plausibly
 * could be: a bare option is `clean`, an option named anywhere in prose is
 * `unwrapped` (the LAST one, where a model that reasons first puts its verdict),
 * and only a text naming no option at all is off-set.
 */
function parseMove(raw) {
  const text = (raw ?? "").toLowerCase();
  const bare = text.trim().replace(/[^a-z ]+/g, " ").trim();
  if (MOVES.includes(bare)) return { move: bare, flag: "clean" };
  const found = [...text.matchAll(/\b(up|down|stay)\b/g)];
  if (found.length) return { move: found.at(-1)[1], flag: "unwrapped" };
  return { move: null, flag: "off-set" };
}

/** Strict arms answer as JSON; anything that is not an in-enum `move` is off-set. */
function parseStrict(raw) {
  try {
    const v = JSON.parse(raw ?? "")?.move;
    if (MOVES.includes(v)) return { move: v, flag: "clean" };
  } catch {
    /* fall through: unparseable JSON is off-set, same as an off-enum value */
  }
  return { move: null, flag: "off-set" };
}

/** One chat call over the gateway's OpenAI-compatible endpoint. No retries, ever. */
const chatArm = (model, extra, parse) => async (state) => {
  const started = performance.now();
  try {
    const res = await fetch(`${GATEWAY}/v1/chat/completions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${process.env.AI_GATEWAY_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model, messages: [{ role: "user", content: promptFor(state) }], ...extra }),
    });
    const body = await res.text();
    const ms = performance.now() - started;
    if (!res.ok) return { ms, error: body.replace(/\s+/g, " ").slice(0, 80) };
    const j = JSON.parse(body);
    const choice = j.choices?.[0];
    const u = j.usage ?? {};
    return {
      ms,
      ...parse(choice?.message?.content),
      raw: choice?.message?.content ?? "",
      finish: choice?.finish_reason,
      inTok: u.prompt_tokens ?? 0,
      outTok: u.completion_tokens ?? 0,
      reasonTok: u.completion_tokens_details?.reasoning_tokens ?? 0,
      cost: Number(u.cost ?? 0),
    };
  } catch (err) {
    return { ms: performance.now() - started, error: String(err.message).slice(0, 80) };
  }
};

/** Jev arm: one typed choice question, through the client this package ships. */
const jevArm = async (state) => {
  try {
    const res = await jev.judge(state, { move: pick(QUESTION, OPTIONS) });
    const v = res.answers.move;
    const raw = v.answer === null ? "" : String(v.answer);
    return {
      ms: res.latencyMs ?? 0,
      move: MOVES.includes(raw) ? raw : null,
      flag: MOVES.includes(raw) ? "clean" : "off-set",
      raw,
      finish: "typed",
      inTok: res.usage?.inputTokens ?? 0,
      outTok: res.usage?.outputTokens ?? 0,
      reasonTok: 0,
      cost: 0, // the SDK does not surface the gateway's cost field; priced from the rate card below
      escalate: v.escalate,
    };
  } catch (err) {
    return { ms: 0, error: String(err.message).slice(0, 80) };
  }
};

/**
 * Published list prices, per token, USD. Both chat rows equal what the gateway's
 * own catalogue (GET /v1/models) reports, and the gateway's per-call `cost` is
 * recorded alongside as a live cross-check.
 *   anthropic/claude-haiku-4.5  $1.00 / $5.00 per Mtok   platform.claude.com/docs/en/about-claude/pricing
 *   google/gemini-3-flash       $0.50 / $3.00 per Mtok   ai.google.dev/gemini-api/docs/pricing
 *   typesafe-ai/jev             $0.042 / $0 per Mtok     Vercel AI Gateway catalogue
 * Checked 2026-09-19.
 */
const PRICE = {
  "anthropic/claude-haiku-4.5": { in: 1e-6, out: 5e-6 },
  "google/gemini-3-flash": { in: 5e-7, out: 3e-6 },
  "typesafe-ai/jev": { in: 4.2e-8, out: 0 },
};

const ARMS = [
  { key: "jev", model: "typesafe-ai/jev", constraint: "typed pick (enum by construction)", call: jevArm },
  {
    key: "haiku-free",
    model: "anthropic/claude-haiku-4.5",
    constraint: `none — max_tokens ${FREE_MAX_TOKENS}, free text (pong.mjs config)`,
    call: chatArm("anthropic/claude-haiku-4.5", { max_tokens: FREE_MAX_TOKENS }, parseMove),
  },
  {
    key: "haiku-strict",
    model: "anthropic/claude-haiku-4.5",
    constraint: "json_schema strict enum, max_tokens 16",
    call: chatArm("anthropic/claude-haiku-4.5", { max_tokens: 16, response_format: RESPONSE_FORMAT }, parseStrict),
  },
  {
    key: "gemini-free",
    model: "google/gemini-3-flash",
    constraint: `none — max_tokens ${FREE_MAX_TOKENS}, free text (pong.mjs config)`,
    call: chatArm("google/gemini-3-flash", { max_tokens: FREE_MAX_TOKENS }, parseMove),
  },
  {
    key: "gemini-strict",
    model: "google/gemini-3-flash",
    constraint: "json_schema strict enum + thinkingBudget 0, max_tokens 64",
    call: chatArm("google/gemini-3-flash", { max_tokens: 64, response_format: RESPONSE_FORMAT, ...GEMINI_NO_THINKING }, parseStrict),
  },
];

// ---- run --------------------------------------------------------------------
const states = buildStates(N, SEED);
const reference = states.map(referenceMove);

console.log(`${B}jev-use fairbase${X} ${D}· ${ARMS.length} arms × ${N} states × ${RUNS} runs · one decision per call, no retries${X}`);
console.log(`${D}backend ${jev.backend.name} (${jev.via}) · gateway ${GATEWAY}${X}`);
console.log(`${D}states: ${N} distinct boards from pong.mjs physics, seed ${SEED}, identical for every arm${X}`);

const runs = [];
for (let run = 1; run <= RUNS; run++) {
  const acc = Object.fromEntries(ARMS.map((a) => [a.key, []]));
  process.stderr.write(`\nrun ${run}/${RUNS}\n`);
  for (let i = 0; i < N; i++) {
    // Rotate the arm order so no arm is always the one that goes first after a pause.
    const order = ARMS.slice(i % ARMS.length).concat(ARMS.slice(0, i % ARMS.length));
    for (const arm of order) {
      const rec = await arm.call(states[i]);
      acc[arm.key].push({ ...rec, state: i, reference: reference[i] });
      process.stderr.write(
        `  ${String(i + 1).padStart(3)}/${N} ${arm.key.padEnd(14)} ` +
          (rec.error ? `${R}ERROR ${rec.error}${X}` : `${String(r0(rec.ms)).padStart(5)}ms ${String(rec.move ?? "-").padEnd(5)} ` +
            `${D}${rec.inTok}/${rec.outTok}tok${rec.reasonTok ? ` (${rec.reasonTok} rsn)` : ""} ${rec.flag}${X}`) + "\n",
      );
    }
  }
  runs.push(summarize(acc));
  printTable(runs.at(-1), `Run ${run}`);
}

/** Per-arm numbers from one run's raw records. Errored calls are excluded from latency. */
function summarize(acc) {
  return ARMS.map((arm) => {
    const all = acc[arm.key];
    const ok = all.filter((r) => !r.error);
    const lat = ok.map((r) => r.ms);
    const inTok = mean(ok.map((r) => r.inTok));
    const outTok = mean(ok.map((r) => r.outTok));
    const price = PRICE[arm.model];
    return {
      key: arm.key,
      model: arm.model,
      constraint: arm.constraint,
      n: ok.length,
      errors: all.length - ok.length,
      p50: pct(lat, 50),
      p95: pct(lat, 95),
      min: pct(lat, 0),
      max: pct(lat, 100),
      inTok,
      outTok,
      reasonTok: mean(ok.map((r) => r.reasonTok ?? 0)),
      offSet: ok.filter((r) => r.flag === "off-set").length,
      unwrapped: ok.filter((r) => r.flag === "unwrapped").length,
      truncated: ok.filter((r) => r.finish === "length").length,
      agree: ok.filter((r) => r.move && r.move === r.reference).length,
      escalated: ok.filter((r) => r.escalate).length,
      costPer1k: (inTok * price.in + outTok * price.out) * 1000,
      gatewayCostPer1k: mean(ok.map((r) => r.cost ?? 0)) * 1000,
      raw: all,
    };
  });
}

function printTable(rows, title) {
  console.log(`\n${B}${title}${X} ${D}· latency client-side, network included · n excludes errored calls${X}\n`);
  const head = "| arm | n | p50 | p95 | min | max | in tok | out tok | off-set | ref-agree | errors |";
  console.log(head);
  console.log("| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |");
  for (const s of rows) {
    console.log(
      `| \`${s.key}\` | ${s.n} | ${s.p50} ms | ${s.p95} ms | ${s.min} ms | ${s.max} ms | ` +
        `${s.inTok.toFixed(0)} | ${s.outTok.toFixed(0)}${s.reasonTok >= 1 ? ` (${s.reasonTok.toFixed(0)} rsn)` : ""} | ` +
        `${s.offSet} | ${s.agree}/${s.n} | ${s.errors} |`,
    );
  }
  console.log();
  for (const s of rows) {
    const note = (n, txt) => (n ? ` · ${n} ${txt}` : "");
    console.log(
      `${s.key.padEnd(14)} ${C}p50 ${String(s.p50).padStart(5)}ms${X} ${D}$${s.costPer1k.toFixed(3)}/1k judgments` +
        `${s.gatewayCostPer1k ? ` (gateway says $${s.gatewayCostPer1k.toFixed(3)})` : ""}${X}` +
        note(s.unwrapped, "needed unwrapping") + note(s.truncated, "hit the token ceiling") +
        note(s.escalated, "low-confidence escalate"),
    );
  }
}

// ---- both runs together -----------------------------------------------------
if (RUNS > 1) {
  console.log(`\n${B}Run-to-run${X} ${D}· p50 per arm, and the spread between runs${X}\n`);
  console.log("| arm | " + runs.map((_, i) => `run ${i + 1} p50`).join(" | ") + " | spread |");
  console.log("| --- |" + runs.map(() => " --- |").join("") + " --- |");
  for (let a = 0; a < ARMS.length; a++) {
    const ps = runs.map((r) => r[a].p50);
    console.log(`| \`${ARMS[a].key}\` | ${ps.map((p) => `${p} ms`).join(" | ")} | ${Math.max(...ps) - Math.min(...ps)} ms |`);
  }
}

const last = runs.at(-1);
const jevRow = last.find((s) => s.key === "jev");
const best = last.filter((s) => s.key !== "jev").sort((a, b) => a.p50 - b.p50)[0];
console.log(
  `\n${B}fastest constrained baseline${X} ${D}·${X} ${best.key} ${C}${best.p50}ms${X} ` +
    `${D}vs jev${X} ${C}${jevRow.p50}ms${X} ${D}= ${(best.p50 / jevRow.p50).toFixed(1)}× ${G}(${best.constraint})${X}`,
);

if (jsonPath) {
  writeFileSync(jsonPath, JSON.stringify({ n: N, runs: RUNS, seed: SEED, states, reference, results: runs }, null, 1));
  console.error(`json written: ${jsonPath}`);
}

// Exactly one markdown row, last line on stdout.
const cell = (k) => {
  const s = last.find((r) => r.key === k);
  return `${k} ${s.p50}ms`;
};
console.log(
  `| Fair baseline, ${N} states × ${RUNS} runs | ${cell("jev")} vs ${cell("haiku-strict")} / ${cell("gemini-strict")} constrained ` +
    `vs ${cell("haiku-free")} / ${cell("gemini-free")} unconstrained |`,
);
