# Variant: flash-hardened

**Philosophy**: The harness compensates for the model. A flash-tier model WILL emit
malformed args, hallucinate tool names, edit files it never read, and loop — the loop
absorbs all of it. Driven by Marisol + Vex.

- Files (flat, no src/): `agent.ts` (REPL + loop + message mgmt), `tools.ts`
  (defs + dispatch + guards), `llm.ts` (client + streaming), `types.ts`. ~450 LOC target.
- Tools (4, required-only schemas, no unions/optionals):
  `read_file(path)` (100KB cap), `write_file(path, content)`,
  `edit_file(path, old_str, new_str)` — old_str not found →
  `EDIT_FAILED: ... read the file first and copy the exact string`,
  `run_bash(command)` (30s timeout, stdout+stderr+exit_code).
- Failure catalog (each handled with a SPECIFIC message back to the model):
  1. Malformed JSON args → TOOL_CALL_ERROR + ask to retry; 3 on one turn → abort.
  2. Hallucinated tool name → error listing the four real tools.
  3. edit_file misses twice on same path → nudge: read_file then retry with exact substring.
  4. Loop runaway → nudge at 30 tool calls ("wrap up"), hard abort at 40.
  5. False victory → system-prompt rule: not done until a verification command ran.
- Guards (always-on, from Vex): path jail on file tools (resolve + startsWith project
  root), bash cwd reset to root each call, output cap 8000 chars at model level with
  `[output truncated]` marker, destructive-command regex (rm -rf, git reset --hard,
  git checkout ., push --force) → y/N confirmation via readline, denial returned to
  model as information.
- Interaction: REPL (`--cwd`, `--model` flags only). Streaming text; tool calls printed
  BEFORE execution; display truncation 2000 chars (model gets 8000). `/quit`, `/reset`.
- Deps: `openai` only. Bun.
- System prompt: <400 tokens, numbered imperatives, tool list at TOP and repeated at
  end, explicit done-criterion, prefer file tools over bash for file ops, NO personality.

**Success**: survives a deliberately hostile e2e — malformed edits, huge outputs,
looping — and still lands the code change.
