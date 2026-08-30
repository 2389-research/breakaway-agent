# Zip (line-count zealot) — proposal summary

- **A**: 4 typed tools, NO bash-only: `read_file`, `write_file`, `run_command`, `list_files`.
  Flat schemas, no optional fields. Output capped 8000 chars, tail-truncated with notice.
- **B**: Forgiving loop. Errors become tool-result strings; non-zero exit is information,
  not exception. One API-retry budget per turn. Hard cap 40 iterations. NOT handled:
  context overflow, injection, rate limits ("die — that's a signal").
- **C**: REPL only, no flags. `[tool: name] arg` lines to stderr, final message stdout.
  History accumulates across tasks = free context.
- **Cross-cutting**: message-window management — keep last N messages (default 30) +
  system prompt + current task. 5-line slice, not a compaction system.
- **Size**: ~180 LOC, ONE file (`agent.ts`) + `.env`. Deps: openai, dotenv. Bun.
- **Prompt**: one short paragraph, string literal in code; tools, cwd, turn cap, one rule.
