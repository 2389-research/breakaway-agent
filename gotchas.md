# Gotchas

- **The lunaroute/GLM gateway is lenient about the tool-call protocol.** During the
  jam, a variant pushed assistant messages *without* their `tool_calls` field and
  three live runs still passed — a strict OpenAI endpoint would 400. Green e2e runs
  against this gateway do NOT prove protocol correctness; check the message shapes.
- **`.env` at repo root holds a live lunaroute API key.** Gitignored from commit
  zero. Never commit it, never echo it. Bun auto-loads it from CWD, so run
  `bun test` and the agent from the repo root.
- **Transcripts anchor to the source dir, not `--cwd`.** `.transcripts/` lives next
  to the code (via `import.meta.dir`), so runs never litter the target repo. A jam
  variant got this wrong and wrote ghost files into its own source tree — that's
  why the anchoring happens *before* `process.chdir`.
- **stdout purity is a contract.** One-shot mode: stdout carries only the model's
  final prose (pipe-safe); progress lines and the stats line go to stderr. Don't
  add `console.log` calls.
- **Tail-truncation is deliberate.** The 8000-char tool-output cap keeps the LAST
  8000 chars because test failures live at the end of output. This applies on the
  bash-timeout path too (partial output is capped — regression test exists).
- **YOLO is a feature.** No permission prompts anywhere, by explicit decision.
  Don't "helpfully" add confirmation gates.
