# Perspective panel (approved by Harper 2026-08-30)

1. **Zip, the line-count zealot** — every line is a liability; a code agent is a
   while-loop with a bash tool, ~150 lines is proof of understanding.
   Optimizes: smallest readable core.
2. **Marisol, the flash-model wrangler** — runs agents on cheap fast models daily;
   knows they emit malformed args, hallucinate tool names, loop forever.
   Optimizes: harness forgiveness — the loop compensates for the model.
3. **Roxy, the tinkerer** — Harper's proxy; rips it apart weekly to test context
   strategies and tool designs. Optimizes: clean seams, zero framework lock-in.
4. **Gus, the Unix graybeard** — an agent is a filter: task on stdin, diff on stdout,
   honest exit codes, logs on stderr. Optimizes: scriptability, composability.
5. **Vex, the blast-radius skeptic** — it runs bash on your laptop. Optimizes:
   containment (cwd jail, timeouts, audit trail) without enterprise ceremony.
