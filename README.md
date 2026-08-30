# break-away

A deliberately tiny, hackable code agent. An experiment platform for exploring agent loop design — swappable policy, context strategy, tools, and system prompt, all in ~300 lines.

## ⚠ YOLO MODE — no guardrails

break-away has no permission prompts, no sandboxing, and no confirmation dialogs. It executes arbitrary shell commands the model requests. Run it where you can afford the blast radius — a throwaway VM, a temp dir, or somewhere you've already backed up.

## Setup

```sh
cp .env.example .env
# Edit .env — fill in your API key and endpoint
bun install
```

## Usage

**One-shot** (task as argument):
```sh
bun src/index.ts "write a hello.txt containing hello"
```

**REPL** (no argument — type tasks interactively):
```sh
bun src/index.ts
```

**Flags:**
```
--cwd <path>     Change working directory before running tools
--model <name>   Override the model (env: OPENAI_COMPATIBLE_MODEL)
--system <path>  Path to system prompt file (default: system.txt)
--max-turns <n>  Override the loop turn budget (default: policy's maxTurns)
--verbose        Print model reasoning (if supported by provider)
--help           Print this help and exit
```

In one-shot mode, only the model's final answer goes to stdout. Stats and progress go to stderr. That means you can pipe the answer cleanly:
```sh
bun src/index.ts "describe the project" > answer.txt
```

**Transcripts** are written as JSONL to `.transcripts/` (or `$BREAK_AWAY_TRANSCRIPT_DIR`). Each run gets its own file.

## Hacking it

**Add a tool:** append one object `{definition, handler}` to the array in `src/tools.ts`. That's it.

**Swap the system prompt:** pass `--system /path/to/your/prompt.txt`, or edit `system.txt` directly.

**Change max turns or error policy:** edit `src/policy.ts`. `onToolError` accepts `'retry' | 'abort' | 'nudge'`.

**Swap context strategy:** replace `contextStrategy` in `src/policy.ts` with a function that filters or trims the message array. A sliding-window example lives in `e2e/seam-proof.ts`.

**The loop itself** is ~90 lines in `src/agent.ts`. All behavior is injected through `Policy` — the loop is policy-blind.

## Self-modification

The agent can edit its own source files and reload or restart without restarting the wrapper:

- **Hot-reload seams** (tools.ts, policy.ts, system.txt): after editing, send `SIGHUP` to the process (`kill -HUP <pid>`) or type `/reload` in the REPL. The running agent re-imports tools and policy via cache-busted dynamic import and re-reads system.txt. No restart needed; the current REPL session continues.

- **Clean restart** (agent.ts, index.ts): after editing core files, send `SIGUSR2` (`kill -USR2 <pid>`) or type `/restart` in the REPL. The process exits with code 42 so `bin/break-away-loop` (see below) relaunches it.

- **`bin/break-away-loop`**: a wrapper that relaunches break-away whenever it exits with code 42, up to 20 times. Run instead of `bun src/index.ts`:
  ```sh
  bin/break-away-loop "task"   # one-shot with auto-restart
  bin/break-away-loop          # REPL with auto-restart
  ```
  `BREAK_AWAY_MAX_RESTARTS` overrides the cap (useful in tests).

## Subagents

`spawn_agent` launches a detached child agent that survives the parent's exit:

```
spawn_agent(task="...", cwd="/path/to/work")
```

The child runs `bun src/index.ts` in the background. Its stdout goes to a `spawn-<ts>.out` file in the transcript directory; stderr to `spawn-<ts>.err`. The parent gets back the pid and file paths immediately.

Agent depth is tracked via `BREAK_AWAY_DEPTH` (default 0). `BREAK_AWAY_MAX_DEPTH` (default 3) caps nesting — spawn_agent returns an error rather than launching when the cap is reached.

## Building a binary

```sh
bun run build
```

Produces a self-contained `break-away` binary (~61 MB) via `bun build --compile`. Run it from any directory:

```sh
./break-away "describe the project"
```

**What works in the binary (everything):**
- All tools (read_file, write_file, bash, spawn_agent), subagents, REPL
- Transcripts — written to `~/.break-away/transcripts/` (or `$BREAK_AWAY_TRANSCRIPT_DIR`)
- `.env` is picked up automatically from the launch directory

**What doesn't work (inherent limit):**
- Self-modification / hot-reload — the binary is a frozen snapshot; `SIGHUP` warns instead of reloading. Rebuild to pick up source changes.
- `/reload` in REPL has the same limit — it will report a failure; rebuild instead.

Per-experiment configuration: drop a `.env` in whatever directory you launch the binary from.
