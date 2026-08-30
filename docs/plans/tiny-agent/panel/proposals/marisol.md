# Marisol (flash-model wrangler) — proposal summary

- **A**: 4 tools: `read_file`, `write_file`, `edit_file(path, old_str, new_str)`, `run_bash`.
  edit_file errors force read-before-edit discipline. Required-only schemas, no unions.
  Small surface = flash can't hallucinate a 5th tool.
- **B**: Forgiving loop w/ typed error feedback + nudge escalation. Ranked flash failures:
  1. malformed JSON args → TOOL_CALL_ERROR tool result, cap 3/turn
  2. hallucinated tool name → error listing real tools
  3. edit on unread file → old_str-not-found error; 2 fails same path → explicit nudge
  4. infinite loop → nudge at 30 calls, abort at 40
  5. false victory → prompt-level rule only ("not done until verification command ran")
  6. context degradation → deliberately NOT handled in v1
  Errors are tool results, never thrown.
- **C**: REPL only (`--model`, `--cwd` flags). Streaming text; tool calls printed BEFORE
  execution; display truncated 2000 chars (model gets 8000). `/quit`, `/reset`.
- **Cross-cutting**: bash output truncation at MODEL level (8000 chars + notice) — flash
  hallucinates from 50k-char compiler noise. No compaction in v1, document the gap.
- **Size**: ~350-400 LOC, 4 flat files (agent/tools/llm/types). Dep: openai only (Bun
  loads .env natively). Bun.
- **Prompt**: <400 tokens, numbered imperatives, tool list at TOP + repeated, explicit
  done-criterion. NO personality — flash treats persona as license to invent tool names.
