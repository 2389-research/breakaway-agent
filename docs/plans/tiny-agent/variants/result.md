# Jam Results: tiny-agent (break-away)

Build a super tiny code agent in TypeScript — robust enough to actually write code.
Purpose: an experiment playground. Malleability beats features. LLM connectivity via
lunaroute (`https://gw.lunaroute.com/v1`, model `glm-5.3-flash-background`), verified
before design with live curls (plain completion + native OpenAI `tool_calls`).

## Perspective Panel

Five personas, dispatched independently (none saw another's proposal):

- **Zip** (minimalist) — the whole agent fits in your head; tininess IS robustness
- **Marisol** (flash-tier realist) — the harness must absorb model sloppiness
- **Roxy** (experimenter) — every axis Harper will A/B lives behind a seam
- **Gus** (unix greybeard) — an agent is a filter: task in, changes out, honest exit codes
- **Vex** (paranoid operator) — guardrails, audit trails, blast-radius control

Their proposals clustered into four genuinely different philosophies.

## Variants Explored

| Variant | Philosophy | LOC | Tests | Result |
|---------|-----------|-----|-------|--------|
| variant-seams | Experiment platform; policy object as the seam | 496 | PASS | **WINNER** |
| variant-one-file | One 222-line file you can hold in your head | 222 | PASS | Insights incorporated |
| variant-flash-hardened | Failure catalog + guards compensate for the model | 773 | PASS | Insights incorporated |
| variant-unix-filter | Cron-safe filter: stdout prose, stderr JSONL, exit codes | 607 | PASS | Insights incorporated |

## Review Panel

Four reviewers, each force-ranking all variants:

- **Cass** (cold code reader, source only) — found one-file's latent protocol bug and
  seams' dead error-policy guard; called flash-hardened's regex gate the best guardrail
- **Piper** (first-run user, cold start) — universal finding: nobody shipped a README
  or `.env.example`; praised unix-filter's usage-on-error
- **Otto** (operator, live unseen tasks incl. a hostile 3000-line JSONL flood) — seams
  fastest/cheapest; caught unix-filter's `--cwd` bug writing ghost files into its own
  source tree; flagged seams' bash tool hanging forever without a timeout
- **Nadia** (hacker, real modifications, weighted heavily — the product IS a
  playground) — seams: add a tool = append one object; only gap was env read at import
  time blocking model A/B

Force rankings: seams 2nd/2nd/1st/1st — the only variant never below 2nd. Wins
weighted and unweighted.

## Winner: variant-seams

It matched the stated purpose. `run(messages, tools, policy)` with tools as
`{definition, handler}` objects and the policy object (maxTurns, onToolError,
contextStrategy, shouldContinue) as the experiment surface meant every reviewer's
"try a weird idea" test touched ≤5 lines. Fastest and cheapest live. Its defects were
all shallow (missing timeout, stats on stdout, one dead guard); the losers' defects
were architectural.

Honest notes on the losers:

- **one-file**: pushes assistant messages WITHOUT their `tool_calls` field (an
  `as ChatMessage` cast hides it — the type lacks the field). Three live runs passed
  only because the lunaroute/GLM gateway tolerates orphaned tool results; a strict
  OpenAI endpoint would 400. A latent portability bug, and the sharpest lesson of the
  jam: a lenient backend can hide a broken protocol.
- **flash-hardened**: 70% over its LOC budget, and both of its signature mechanisms
  (edit-miss nudge counter, malformed-args abort counter) had bugs. The guards were
  good; the catalog bought less than it cost.
- **unix-filter**: `--cwd` only reached the bash tool — file tools wrote into the
  agent's own source tree during review (ghost `clean.ts`/`hi.txt` confirmed via git
  status). Its transcript JSONL and stdout discipline were the best ideas in the jam.

## Synthesis: What We Learned From Everyone

Post-review directive from Harper: the agent is **pure YOLO — no permission prompts,
full autonomy**. The destructive-command gate was explicitly declined.

| Source | Insight | Incorporated? | How |
|--------|---------|---------------|-----|
| flash-hardened / Otto | bash needs a timeout + kill | Yes | 30s default, `proc.kill()` on expiry, timeout reported in result string, optional `timeout_ms` |
| unix-filter / Cass | stdout must be pipe-safe | Yes | Stats + progress → stderr; stdout carries only the final prose answer |
| unix-filter's failure / Otto | `--cwd` must bind ALL tools | Yes | `process.chdir()` once at startup; agent-internal paths anchored to `import.meta.dir` first |
| one-file | tail-truncation (failures live at the end) | Yes | 8000-char cap keeps the LAST 8000 with a marker |
| Cass | dead `!== 'unknown'` guard in error policy | Yes | Removed; retry/abort/nudge each now unit-tested |
| Piper | README, `.env.example`, usage on bad args | Yes | All three; `--help` too; YOLO warning up top |
| Nadia | env read at import time blocks model A/B | Yes | Call-time `buildClientConfig()` + `--model` flag |
| unix-filter | per-run transcript JSONL | Yes | `src/transcript.ts` → `.transcripts/run-<ts>.jsonl`; run_start/assistant/tool_call/tool_result/done via an `onEvent` observer seam; best-effort, never crashes a run |
| flash-hardened / Vex | destructive-command y/N gate | No | Harper: pure YOLO, no permissions — declined by design |
| unix-filter / Gus | exit-code taxonomy (0–4) | No | REPL-first playground; over-formal here |
| one-file / Zip | single-file constraint | No | Core architecture of a losing variant |
| flash-hardened / Marisol | full failure catalog + nudge counters | No | Its two novel mechanisms were the buggy ones; seams' simpler policy machinery absorbs the same failures |

Synthesis verification: `bun test` green (33 tests before synthesis → 55 after; the
+22 includes a cap-on-timeout-partial-output fix caught in orchestrator review), plus
live one-shot e2e against the real gateway — file created in a `--cwd` temp dir,
stdout pure prose, transcript valid JSONL with all five event types, no stray files
in the tree (~3 turns, ~1.4k tokens, ~1–2s per run).

## The Jam Was All of Us Together

No single variant shipped this agent. The winner supplied the skeleton — the policy
seam that makes experiments cheap. A variant that lost on architecture supplied the
transcript that makes experiments *legible*, and its worst bug taught the winner how
to do `--cwd` right. The paranoid variant, mostly declined on philosophy, still fixed
the one hang that would have frozen a run forever. And the reviewer who never ran the
code caught the bug that three successful live runs could not: the gateway was
forgiving, the code was wrong. Four philosophies went in; one agent came out knowing
what all four knew.
