# break-away

A deliberately tiny, hackable code agent. An experiment platform for exploring agent loop design — swappable policy, context strategy, tools, and system prompt, with a policy-blind core loop you can read in one sitting.

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
--serious        Long-horizon profile: 80 turns, extra API-retry headroom,
                 and a completion audit that verifies before accepting a finish
--max-turns <n>  Override the loop turn budget (default: policy's maxTurns)
--quiet          Minimal progress: tool calls and stats only
--debug          Rich view plus API timing and fuller result excerpts
--help           Print this help and exit
```

The default view shows the model's reasoning, its dialog between tool calls, and a snippet of each tool result — all on stderr. In one-shot mode, only the model's final answer goes to stdout. Stats and progress go to stderr. That means you can pipe the answer cleanly:
```sh
bun src/index.ts "describe the project" > answer.txt
```

**Transcripts** are written as JSONL to `.transcripts/` (or `$BREAK_AWAY_TRANSCRIPT_DIR`). Each run gets its own file.

## Tools

The model drives five tools:

- `read_file(path, start_line?, max_lines?)` — read a whole file, or page a large one by line window. Ranged reads return `[lines X-Y of N; next_start_line=Z]` metadata so the model can walk a big file deterministically.
- `write_file(path, content)` — create or overwrite a file.
- `edit_file(path, old_text, new_text)` — exact-match, single-occurrence replacement written atomically. Refuses (unchanged file) if `old_text` matches zero times or more than once.
- `bash(cmd, timeout_ms?)` — run a shell command; on timeout the whole process group is killed. Output is capped to the last 8000 chars.
- `spawn_agent(task, cwd?)` — launch a detached child agent (see Subagents).

## Hacking it

**Add a tool:** append one object `{definition, handler}` to the array in `src/tools.ts`. That's it.

**Swap the system prompt:** pass `--system /path/to/your/prompt.txt`, or edit `system.txt` directly.

**Change max turns or error policy:** edit `src/policy.ts`. `onToolError` accepts `'retry' | 'abort' | 'nudge'`.

**Swap context strategy:** replace `contextStrategy` in `src/policy.ts` with a function that filters or trims the message array. A sliding-window example lives in `e2e/seam-proof.ts`.

**The loop itself** is the `run()` function in `src/agent.ts` (~150 lines; the file is ~265 with the retry and tool-dispatch helpers). All behavior is injected through `Policy` — the loop is policy-blind.

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

In source mode the child runs `bun src/index.ts` in the background; the compiled binary spawns itself instead (`process.execPath`). Either way, its stdout goes to a `spawn-<ts>.out` file in the transcript directory; stderr to `spawn-<ts>.err`. The parent gets back the pid and file paths immediately, and renders a `◆ spawned agent <pid>` block to stderr.

Agent depth is tracked via `BREAK_AWAY_DEPTH` (default 0). `BREAK_AWAY_MAX_DEPTH` (default 3) caps nesting — spawn_agent returns an error rather than launching when the cap is reached.

**Agent registry:** every process records its spawn, start, and done events to `agents.jsonl` in the transcript directory. This gives a shared view of what's running across parent and child agents — even after the parent exits and pids get reparented to PID 1.

**Boot verification:** after launching a child, `spawn_agent` waits 700ms and checks the pid is still alive. If the child died at boot, the error message fed back to the model includes the head of the `.err` file so the model can see what went wrong.

**Live status polling:** while a run is active, a 2-second background poll watches for direct-child state changes and prints one line per transition to stderr (with color when the terminal supports it):
- `◆ agent <pid> done (<age>s)` — child finished (green)
- `◆ agent <pid> done (error: <reason>, <age>s)` — child finished with an error (yellow)
- `✗ agent <pid> died (<age>s)` — child crashed without writing a done record (red)

**Done records carry status:** `agent_done` in the registry includes `status` (`ok` or `error`) and `stop_reason` (the `FinalState.stopReason` value). Clean restarts (`/restart`, `SIGUSR2`) also record `agent_done` with `status:ok, stop_reason:restart` so they don't read as "died" after relaunch.

**REPL `/agents` command:** prints a depth-indented tree of all agents descended from the current process, with state marker (● CYAN running / ✔ GREEN done / ✔ YELLOW done-error / ✗ RED died), age, and task snippet. Outsiders (live agents from other tree roots) are summarised at the bottom.

**Self-serve child status:** the spawn result now ends with `status: read_file <registryPath>` instead of a shell command, so the parent model can check child status with a plain `read_file` call.

Each child's `.err` file is its own live TUI stream — follow it with:
```sh
tail -f /path/to/spawn-<ts>.err
```
The path appears in the `◆ spawned agent` block at spawn time and in the end-of-run summary for any still-running children.

## Building a binary

```sh
bun run build
```

Produces a self-contained `break-away` binary (~61 MB) via `bun build --compile`. Run it from any directory:

```sh
./break-away "describe the project"
```

**What works in the binary (everything):**
- All tools (read_file, write_file, edit_file, bash, spawn_agent), subagents, REPL
- Transcripts — written to `~/.break-away/transcripts/` (or `$BREAK_AWAY_TRANSCRIPT_DIR`)
- `.env` is picked up automatically from the launch directory

**What doesn't work (inherent limit):**
- Self-modification / hot-reload — the binary is a frozen snapshot; `SIGHUP` warns instead of reloading. Rebuild to pick up source changes.
- `/reload` in REPL has the same limit — it will report a failure; rebuild instead.

Per-experiment configuration: drop a `.env` in whatever directory you launch the binary from.
