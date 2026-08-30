# break-away

A deliberately tiny, hackable code agent. An experiment platform for exploring agent loop design — swappable policy, context strategy, tools, and system prompt, all in ~300 lines.

## ⚠ YOLO MODE — no guardrails

break-away has no permission prompts, no sandboxing, and no confirmation dialogs. It executes arbitrary shell commands the model requests. Run it where you can afford the blast radius — a throwaway VM, a temp dir, or somewhere you've already backed up.

## Setup

```sh
cp .env.example .env
# Edit .env — fill in your API key and endpoint
bun install
```

## Usage

**One-shot** (task as argument):
```sh
bun src/index.ts "write a hello.txt containing hello"
```

**REPL** (no argument — type tasks interactively):
```sh
bun src/index.ts
```

**Flags:**
```
--cwd <path>     Change working directory before running tools
--model <name>   Override the model (env: OPENAI_COMPATIBLE_MODEL)
--system <path>  Path to system prompt file (default: system.txt)
--verbose        Print model reasoning (if supported by provider)
--help           Print this help and exit
```

In one-shot mode, only the model's final answer goes to stdout. Stats and progress go to stderr. That means you can pipe the answer cleanly:
```sh
bun src/index.ts "describe the project" > answer.txt
```

**Transcripts** are written as JSONL to `.transcripts/` (or `$BREAK_AWAY_TRANSCRIPT_DIR`). Each run gets its own file.

## Hacking it

**Add a tool:** append one object `{definition, handler}` to the array in `src/tools.ts`. That's it.

**Swap the system prompt:** pass `--system /path/to/your/prompt.txt`, or edit `system.txt` directly.

**Change max turns or error policy:** edit `src/policy.ts`. `onToolError` accepts `'retry' | 'abort' | 'nudge'`.

**Swap context strategy:** replace `contextStrategy` in `src/policy.ts` with a function that filters or trims the message array. A sliding-window example lives in `e2e/seam-proof.ts`.

**The loop itself** is ~90 lines in `src/agent.ts`. All behavior is injected through `Policy` — the loop is policy-blind.
