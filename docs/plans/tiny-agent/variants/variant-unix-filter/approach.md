# Variant: unix-filter

**Philosophy**: An agent is a filter: task in, changes out, honest exit codes, logs on
stderr. Anything you can't run from cron is a toy. Driven by Gus, audit trail from Vex.

- Files: `src/main.ts` (argv, env validation), `src/agent.ts` (loop), `src/tools.ts`,
  `src/llm.ts` (raw fetch client), `src/transcript.ts` (JSONL writer). ~400 LOC target.
- Tools (3): `bash(cmd, timeout_ms?)` (default 30s, max 120s),
  `read_file(path)`, `write_file(path, content)`. No edit_file — sed exists.
- CLI (one-shot ONLY, no REPL):
  `break-away "task" [--cwd PATH] [--max-iter N] [--timeout-ms N]`
- Contract (sacred):
  - stdout: the model's final prose answer, nothing else. Pipe-safe.
  - stderr: JSONL event stream — one line per event:
    `{ts, event: "tool_call"|"tool_result"|"llm_message"|"done", ...}`.
  - exit codes: 0 done · 1 iteration cap · 2 wall-clock cap · 3 API failure · 4 bad
    invocation. `AGENT_ERROR: <reason>` on stderr for non-zero.
- Caps: 25 iterations, 10-minute wall clock (harness-enforced), 1 API retry w/ 2s
  backoff, 8000-char tool output cap with truncation notice.
- Transcript: EVERY run appends events to `agent-run-<timestamp>.jsonl` in cwd (or
  `$AGENT_TRANSCRIPT_DIR`). Not optional, no flag. Format reconstructs the full message
  array (resume-compatible; resume itself not built).
- Deps: ZERO. Raw fetch against the OpenAI-compatible endpoint, Bun.spawn for bash.
  TypeScript via Bun. Nothing in package.json dependencies.
- System prompt: one tight prose paragraph, string constant in agent.ts — tools, cwd,
  completion signal, two rules: never guess paths; verify writes.

**Success**: `break-away "fix the failing test" 2>>agent.log; echo $?` works from a shell
script, in CI, and from cron, with a transcript you can grep afterward.
