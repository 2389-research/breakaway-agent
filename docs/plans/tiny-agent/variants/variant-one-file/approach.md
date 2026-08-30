# Variant: one-file

**Philosophy**: The whole agent fits in your head. Tininess IS the robustness — nothing
hides, so nothing surprises. Driven by Zip.

- ONE source file: `agent.ts` (~200 lines target, hard ceiling 250). Plus package.json,
  tsconfig.json, .env.example, and a test file.
- Tools (4, typed, flat schemas, all fields required):
  `read_file(path)`, `write_file(path, content)`, `run_command(command)`,
  `list_files(path)`.
- Loop: forgiving. Tool errors (bad JSON args, missing file, non-zero exit) become tool
  result strings — never thrown. finish stop → done. Hard cap 40 iterations. One API
  retry budget per user turn.
- Context: message window — before each API call keep system prompt + current task +
  last N messages (N=30 via env). A slice, not a compaction system.
- Interaction: REPL only. `bun run agent.ts`. `>` prompt, `[tool: name] arg` progress
  lines to stderr, final message to stdout. Ctrl-C / `quit` exits.
- Output caps: tool results capped at 8000 chars, tail-truncated, with explicit
  truncation notice.
- Deps: `openai` only (Bun loads .env natively).
- System prompt: one short paragraph string literal in agent.ts — tools, cwd, turn cap,
  "read before write, verify after write."

**Success**: a stranger reads agent.ts top to bottom in one sitting and can predict
everything the agent will do.
