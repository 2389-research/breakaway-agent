# Vex (blast-radius skeptic) — proposal summary

- **A**: 4 tools: `read_file`, `write_file`, `edit_file(path, old_str, new_str)`,
  `bash(cmd, timeout_ms?)`. File tools are the SAFER surface (path-jailed in our code);
  bash is the escape hatch that stays in the audit trail. edit_file = exact-string
  replace, "the most important tool" — fails loudly when stale instead of corrupting.
- **B**: Forgiving loop + always-on guards (no knobs): MAX_STEPS 40 · bash timeout
  30s/120s max · output cap 8KB+8KB w/ [truncated] marker · cwd jail (path.resolve +
  startsWith check; bash cwd reset each call — drift self-corrects) · 200K session token
  cap. ONE confirmation gate: narrow destructive-command regex (rm -rf, git reset --hard,
  git checkout ., push --force) → y/N prompt, denial returned to model as signal.
  Admits unsolved: exfiltration, typosquats (audit trail is the answer). Cap read_file 100KB.
- **C**: One-shot CLI, no REPL. `break-away [--cwd] [--model] [--max-steps] [--log]
  [--dry-run] <task>`. Streaming one-line events; outputs truncated to 3 lines on screen,
  full in log. Audit trail: append-only `.break-away/run-<ts>.jsonl`, answers "what
  exactly did it do?" `--continue` = future hack, not day one.
- **Cross-cutting**: the system prompt IS a guard — prefer file tools over bash; a gate
  denial means try a non-destructive alternative. <200 words.
- **Size**: ~450 LOC, 6 files in src/ (index/agent/tools/confirm/log/types).
  Deps: openai only. Bun.
