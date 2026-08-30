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
- **SIGHUP handler registered at module load, not in main().** The signal handler calls `doReload` with whatever `_sighupSystemPath` is set to (defaults to `system.txt`). main() updates `_sighupSystemPath` if `--system` was passed. Tests that import index.ts without calling main() will still see the SIGHUP handler registered.
- **`doReload` uses cache-busted dynamic import.** `import(path + '?v=' + Date.now())` — verified working in Bun 1.3.14. If you pass the same path twice, the query-string suffix forces a fresh module load. Without it, Bun returns the cached module.
- **`spawn_agent` depth guard uses env var, not argument.** `BREAK_AWAY_DEPTH` is inherited by child processes and incremented on each spawn. Never pass it explicitly to the child; let env inheritance handle it. `BREAK_AWAY_MAX_DEPTH` defaults to 3.
- **Compiled binary (`bun run build`) has embedded FS.** `import.meta.dir` = `/$bunfs/root` in the binary — paths anchored there are read-only and break at runtime. Fixes: text import bundles system.txt; transcripts redirect to `~/.break-away/transcripts`; spawn_agent uses `process.execPath` for children. `bun test` runs from source — these paths are never hit during tests, which is by design.
- **SIGHUP / `/reload` in binary warns, doesn't reload.** The binary is a frozen snapshot. Rebuild (`bun run build`) to pick up source changes.
- **Pid-reuse in agent state derivation.** State is derived via `process.kill(pid, 0)`: running if alive, died if not, done if an `agent_done` record exists. If the OS recycles a dead child's pid and hands it to an unrelated process, that child will report as `running` instead of `died`. Accepted for this playground; note it if debugging unexpected state.
- **`diffAgentStates` returns `AgentTransition[]`, not strings.** Changed in the lifecycle-color pass. Use `formatTransition(t, renderCfg)` from `render.ts` to format for display. Don't grep for the old string-format assertions.
- **`verifySpawn` adds ~700ms to every spawn.** This is intentional — nohup returns a pid even for corpses, so we wait 700ms then check. Spawns are rare. E2e tests with tight timeouts may need bumping if total time creeps up.
- **`/restart` and `SIGUSR2` now write `agent_done` before exiting.** The record is written synchronously (appendFileSync inside async wrapper) so calling without await just before `process.exit` is safe. This prevents the old pid from reading as "died" after a clean restart.
- **Bun timer `unref()` works as expected.** Verified in Bun 1.3.14: `setInterval` returns an object with an `unref()` method; calling it prevents the timer from keeping the process alive after the main work finishes. The poller uses this — a one-shot run exits promptly without needing `clearInterval` on every path (though `stopPoller()` is also called for cleanliness).
- **Models misread combined commands that partially time out.** Observed live (2026-08-30): a parent agent ran `cat file; ls; find / -maxdepth 6` as ONE bash call — the cat succeeded but the find hit the 30s timeout, and the `[timed out]` marker made the model treat the whole result as failure and loop retrying. The model sees one result string per call; a timeout marker poisons everything bundled with it. If an agent loops on "failing" commands that should work, look for this.
