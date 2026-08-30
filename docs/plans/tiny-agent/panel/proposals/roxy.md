# Roxy (tinkerer) — proposal summary

- **A**: 3 tools only: `read_file`, `write_file`, `bash`. No edit_file ("seductive
  complexity trap") — write_file suffices while the project fits in context; add edit
  when pressure appears. Tools = array of `{definition, handler}` objects in tools.ts;
  adding a tool is appending one object.
- **B**: Forgiving loop. Hardwired correctness: unknown-tool → error message + continue;
  full stderr/exit fed back; hard turn cap 40. Swappable `policy.ts`:
  `maxTurns`, `onToolError`, `contextStrategy(messages)→messages` (THE experiment
  surface), `shouldContinue(lastMessage)`. Loop signature: `run(messages, tools, policy)`.
- **C**: REPL + one-shot escape hatch, same codepath (`break-away` vs `break-away "task"`).
  Per-tool-call one-liners; reasoning stream off by default (`--verbose`). Machine-readable
  stats line every run: `done in N turns, N tokens (prompt/completion), Ns`.
- **Cross-cutting**: week-one experiments define the seams: (1) context strategies →
  policy.contextStrategy; (2) system prompt A/B → `--system <file>` (prompt is data, not
  code); (3) tool design variants → swap the tools array import.
- **Size**: ~550-700 LOC, 6 flat files (index/agent/tools/policy/client/types). Deps:
  openai + dotenv (drop dotenv on Bun). Bun.
- **Prompt**: from file (`./system.txt` default), short, no rules list.
