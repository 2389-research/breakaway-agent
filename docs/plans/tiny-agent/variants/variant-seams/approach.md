# Variant: seams

**Philosophy**: An experiment platform. The measure of the design is "how many lines do
I touch to try a weird idea?" Every axis Harper will A/B lives behind a seam. Driven by Roxy.

- Files (flat, 6): `index.ts` (CLI entry, REPL, stats), `agent.ts` (the loop),
  `tools.ts` (registry), `policy.ts` (swappable policy), `client.ts` (OpenAI-compat
  HTTP), `types.ts`. ~600 LOC target.
- Loop signature: `run(messages, tools, policy) => FinalState`. Nothing else enters.
- Tools: array of `{definition, handler}` objects — adding a tool = appending one
  object. Ships with `read_file(path)`, `write_file(path, content)`, `bash(cmd)`.
  Deliberately NO edit_file (add it as your first tool experiment).
- Policy object (the experiment surface):
  - `maxTurns` (default 40)
  - `onToolError: 'retry' | 'abort' | 'nudge'`
  - `contextStrategy(messages) => messages` — called before every API call. Default:
    full transcript. Sliding-window and summarize variants are week-one experiments.
  - `shouldContinue(lastMessage) => boolean`
- Hardwired correctness (not policy): unknown tool → error result + continue; full
  stderr/exit fed back; errors as results never throws; 8000-char output cap.
- Interaction: REPL and one-shot, same codepath — `break-away` enters REPL,
  `break-away "task"` runs once and exits. Per-tool one-line progress. Reasoning stream
  off by default, `--verbose` enables. EVERY run ends with machine-readable stats:
  `done in N turns, N tokens (prompt: N / completion: N), N.Ns`.
- System prompt: a FILE (`system.txt`, `--system <path>` to swap). Prompt is data.
- Deps: `openai` only. Bun.

**Success**: swapping context strategy, system prompt, or tool set each touches ≤5 lines
outside the file that defines them.
