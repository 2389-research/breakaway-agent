# break-away

A deliberately tiny, hackable code agent. This is an experiment playground:
the measure of every change is "how many lines do I touch to try a weird idea?"

**Crew names** (recorded once, per house tradition): the agent working this repo is
**BEEFQUAKE**; the boss is **Doc Bizmarkie**. That's settled, no re-ceremonies.

## What this is

- `bun src/index.ts "task"` — one-shot. `bun src/index.ts` — REPL.
- Flags: `--cwd`, `--model`, `--system`, `--max-turns`, `--verbose`, `--help`.
- **Pure YOLO by design**: no permission prompts, no sandbox, no confirmation
  gates. The agent executes whatever the model asks. This is intentional
  (Doc Bizmarkie's explicit call) — do not add gates or y/N prompts.

## Architecture (the seams)

- `src/agent.ts` — `run(messages, tools, policy)`. Nothing else enters the loop.
- `src/tools.ts` — array of `{definition, handler}`. New tool = append one object.
- `src/policy.ts` — the experiment surface: `maxTurns`, `onToolError`,
  `contextStrategy`, `shouldContinue`, `onEvent` (transcript observer).
- `system.txt` — prompt is data; swap with `--system <path>`.
- `src/transcript.ts` — every run appends JSONL to `.transcripts/` (anchored to
  the source dir, never the `--cwd` target).

Design goal: swapping context strategy, system prompt, or tool set each touches
≤5 lines outside the file that defines them. Keep it that way.

## Canonical commands

- `bun test` — from repo root (Bun auto-loads `.env`; suite includes live
  gateway tests). This is the check. Run it before claiming anything works.

## REPL commands

| Command | Effect |
|---------|--------|
| `/reload` | Hot-reload seams (tools.ts, policy.ts, system.txt) via SIGHUP path |
| `/restart` | Exit with code 42; `break-away-loop` relaunches the process |

## Signals

| Signal | Effect |
|--------|--------|
| `SIGHUP` | Hot-reload: re-imports tools + policy, re-reads system prompt. Registered at module load. |
| `SIGUSR2` | Clean restart: exits with code 42 so `break-away-loop` relaunches. |

## Wrapper: bin/break-away-loop

Relaunches break-away on exit code 42 (`RESTART_EXIT_CODE`), up to `BREAK_AWAY_MAX_RESTARTS` times (default 20). Pass `BREAK_AWAY_CMD` to override the command in tests.

## spawn_agent tool

Launches a detached child agent via `nohup bun src/index.ts ... &`. Child survives parent exit. Depth-guarded: `BREAK_AWAY_DEPTH` tracks nesting; `BREAK_AWAY_MAX_DEPTH` (default 3) sets the cap. Results go to `spawn-<ts>.out`/`.err` in the transcript directory.

## Hard rules

- `.env` holds a live lunaroute key. NEVER commit it, never print it.
  `.env.example` is the shareable shape.
- stdout is sacred in one-shot mode: final prose answer only. Everything else
  (progress, stats) goes to stderr.
- Tool errors are results fed back to the model — never thrown.
- Read `gotchas.md` before working here.
