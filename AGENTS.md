# break-away

A deliberately tiny, hackable code agent. This is an experiment playground:
the measure of every change is "how many lines do I touch to try a weird idea?"

**Crew names** (recorded once, per house tradition): the agent working this repo is
**BEEFQUAKE**; the boss is **Doc Bizmarkie**. That's settled, no re-ceremonies.

## What this is

- `bun src/index.ts "task"` — one-shot. `bun src/index.ts` — REPL.
- Flags: `--cwd`, `--model`, `--system`, `--serious`, `--max-turns`, `--quiet`, `--debug`, `--help`.
- `--serious`: long-horizon profile (`seriousPolicy` in policy.ts) — `apiMaxAttempts: 5`, `completionAudit: true`, no turn limit (like the default). `--max-turns N` imposes an explicit safety/debug cap on top; hitting it exits nonzero.
- Output tiers: `--quiet` (tool calls + stats), default `rich` (reasoning + interim prose + tool snippets), `--debug` (rich + api_ms + longer excerpts). `--quiet` and `--debug` are mutually exclusive.
- **Pure YOLO by design**: no permission prompts, no sandbox, no confirmation
  gates. The agent executes whatever the model asks. This is intentional
  (Doc Bizmarkie's explicit call) — do not add gates or y/N prompts.

## Architecture (the seams)

- `src/agent.ts` — `run(messages, tools, policy)`. Nothing else enters the loop.
- `src/tools.ts` — array of `{definition, handler}`. New tool = append one object.
  Current set: `read_file` (whole-file or ranged by `start_line`/`max_lines`),
  `write_file`, `edit_file` (exact-match atomic replace), `bash`, `spawn_agent`.
- `src/policy.ts` — the experiment surface: `maxTurns`, `onToolError`,
  `contextStrategy`, `shouldContinue`, `onEvent` (transcript observer),
  `apiMaxAttempts`/`apiRetryBaseMs` (in-loop transient-error retry; a retry
  costs backoff, not a turn), `completionAudit` (one enforced verify pass
  before a no-tool finish counts as done).
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
| `/agents` | Print the descendant agent tree (pid, state, age, task); outsiders summarised |

## Signals

| Signal | Effect |
|--------|--------|
| `SIGHUP` | Hot-reload: re-imports tools + policy, re-reads system prompt. Registered at module load. |
| `SIGUSR2` | Clean restart: exits with code 42 so `break-away-loop` relaunches. |

## Wrapper: bin/break-away-loop

Relaunches break-away on exit code 42 (`RESTART_EXIT_CODE`), up to `BREAK_AWAY_MAX_RESTARTS` times (default 20). Pass `BREAK_AWAY_CMD` to override the command in tests.

## spawn_agent tool

Launches a detached child agent via `nohup bun src/index.ts ... &` in source mode (the binary spawns itself via `process.execPath` — see Binary mode). Child survives parent exit. Depth-guarded: `BREAK_AWAY_DEPTH` tracks nesting; `BREAK_AWAY_MAX_DEPTH` (default 3) sets the cap. Results go to `spawn-<ts>.out`/`.err` in the transcript directory.

The spawn renders a `◆ spawned agent <pid>` block to stderr immediately. A 2-second background poll watches for state transitions and prints `◆ agent <pid> done (<age>s)` or `✗ agent <pid> died (<age>s)` to stderr as they happen. After one-shot completes, still-running children are listed with `tail -f` hints.

**Registry:** every agent writes to `agents.jsonl` in the transcript directory (`BREAK_AWAY_TRANSCRIPT_DIR`, or `~/.break-away/transcripts` in binary mode). Records: `agent_spawn` (parent writes it), `agent_start` (child writes at boot), `agent_done` (child writes on clean exit). State is derived live via `process.kill(pid, 0)` — done > running > died.

## Binary mode (`bun run build`)

Running `bun run build` compiles to a `./break-away` binary. The binary is ignored by git. In binary mode:
- Transcripts go to `~/.break-away/transcripts/` (env var still wins).
- Subagents (`spawn_agent`) launch the binary itself via `process.execPath`.
- The system prompt is bundled at build time; `--system <path>` still overrides at runtime.
- `SIGHUP` / `/reload` warn that reload is unavailable — rebuild instead.

## Hard rules

- `.env` holds a live lunaroute key. NEVER commit it, never print it.
  `.env.example` is the shareable shape.
- stdout is sacred in one-shot mode: final prose answer only. Everything else
  (progress, stats) goes to stderr.
- Tool errors are results fed back to the model — never thrown.
- Read `gotchas.md` before working here.
