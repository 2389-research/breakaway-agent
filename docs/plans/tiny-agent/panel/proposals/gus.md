# Gus (Unix graybeard) — proposal summary

- **A**: 3 tools: `bash(cmd, timeout_ms?)` (default 30s, max 120s), `read_file`, `write_file`.
  No edit_file — sed/grep/find exist. read/write exist only to dodge heredoc quoting hell.
- **B**: Forgiving loop. Feedback loop closure IS the robustness. 25-iteration cap,
  10-min wall clock cap, 1 API retry w/ 2s backoff.
  **Sacred exit codes**: 0 done · 1 iter cap · 2 wall clock · 3 API fail · 4 bad invocation.
- **C**: ONE-SHOT ONLY: `break-away "task" [--cwd] [--max-iter] [--timeout-ms]`.
  "A REPL is a toy." stdout = final prose only (pipe-safe). stderr = JSONL event stream
  (tool_call/tool_result/llm_message/done events). Cron- and CI-ready.
- **Cross-cutting**: transcript on disk as FIRST-CLASS artifact: `agent-run-<ts>.jsonl`
  every run, not optional. Diff runs, grep tool calls, replay. Format is resume-compatible
  (resume itself YAGNI'd).
- **Size**: ~400 LOC, 5 files in src/ (main/agent/tools/llm/transcript).
  Deps: ZERO. Raw fetch, Bun.spawn. "An SDK is a dependency that owns your upgrade path."
- **Prompt**: one tight prose paragraph in a string constant (versioned with code);
  tools, cwd, exit signal TASK_COMPLETE, two rules: never guess paths; verify writes.
