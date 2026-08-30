# break-away: tiny code agent — jam context

## Problem

Build a super tiny code agent in TypeScript, robust enough to actually write code.
Purpose: **experiment/playground** — Harper will hack on it weekly to test agent ideas
(context strategies, tool designs). Malleability matters most. "Super tiny" is a hard
aesthetic constraint: readable in one sitting. Not a framework.

## Established facts (verified 2026-08-30)

- LLM access via **lunaroute** gateway: OpenAI-compatible chat completions at
  `https://gw.lunaroute.com/v1`, configured via `.env`:
  `LLM_PROVIDER=openai-compatible`, `OPENAI_COMPATIBLE_API_KEY`,
  `OPENAI_COMPATIBLE_BASE_URL`, `OPENAI_COMPATIBLE_MODEL`.
- Model: `glm-5.3-flash-background` — flash-tier (fast/cheap). Native OpenAI
  `tool_calls` confirmed working via curl: clean JSON args, `finish_reason=tool_calls`.
- TypeScript. Runtime (Bun vs Node) left open for the panel.

## Architectural slots

- **A. Tool surface** — bash-only · typed file tools (read/write/edit/bash) · hybrid
- **B. Robustness strategy** — fail-fast · forgiving loop (error feedback, retries,
  nudges, iteration caps) · supervised (+ compaction, transcripts)
- **C. Interaction model** — one-shot CLI · REPL · both; how the human watches it work

## Constraint that shapes everything

Flash-tier model = the harness must absorb model sloppiness (malformed args,
hallucinated tool names, loops) without ballooning past "tiny."
