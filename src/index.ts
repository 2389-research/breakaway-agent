// ABOUTME: CLI entry point — parses args, builds initial messages, runs REPL or one-shot mode.
// ABOUTME: Stats and progress go to stderr; only the final prose answer goes to stdout.

import { run, setVerbose } from './agent.ts';
import { tools } from './tools.ts';
import { defaultPolicy } from './policy.ts';
import type { Message, FinalState, Policy } from './types.ts';
import { openTranscript, writeEvent, closeTranscript } from './transcript.ts';
import { readFileSync, existsSync } from 'node:fs';
import { resolve, join } from 'node:path';

// Anchor paths before any chdir so they survive --cwd.
const SOURCE_DIR = import.meta.dir;
const DEFAULT_TRANSCRIPT_DIR = resolve(SOURCE_DIR, '../.transcripts');
const DEFAULT_SYSTEM_PATH = join(SOURCE_DIR, '../system.txt');

export function formatStats(state: FinalState): string {
  const secs = (state.elapsed / 1000).toFixed(1);
  return `done in ${state.turns} turns, ${state.usage.total_tokens} tokens (prompt: ${state.usage.prompt_tokens} / completion: ${state.usage.completion_tokens}), ${secs}s`;
}

const USAGE = `
Usage: bun src/index.ts [OPTIONS] [TASK]

  TASK             Task string for one-shot mode. Omit for REPL.

Options:
  --cwd <path>     Change working directory before running tools.
  --model <name>   Override the model (env: OPENAI_COMPATIBLE_MODEL).
  --system <path>  Path to system prompt file (default: system.txt).
  --max-turns <n>  Override the loop turn budget (default: policy's maxTurns).
  --verbose        Print model reasoning (if supported by provider).
  --help           Print this help and exit.
`.trim();

export type ParsedArgs = {
  task: string | null;
  systemPath: string;
  verbose: boolean;
  model: string | null;
  cwd: string | null;
  maxTurns: number | null;
  help: boolean;
  unknownFlag: string | null;
};

export function parseArgs(argv: string[]): ParsedArgs {
  let task: string | null = null;
  let systemPath = DEFAULT_SYSTEM_PATH;
  let verbose = false;
  let model: string | null = null;
  let cwd: string | null = null;
  let maxTurns: number | null = null;
  let help = false;
  let unknownFlag: string | null = null;

  const args = argv.slice(2);
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--verbose') {
      verbose = true;
    } else if (args[i] === '--help') {
      help = true;
    } else if (args[i] === '--system' && args[i + 1]) {
      systemPath = args[++i];
    } else if (args[i] === '--model' && args[i + 1]) {
      model = args[++i];
    } else if (args[i] === '--cwd' && args[i + 1]) {
      cwd = args[++i];
    } else if (args[i] === '--max-turns' && args[i + 1]) {
      const n = Number(args[++i]);
      if (!Number.isInteger(n) || n < 1) {
        unknownFlag = `--max-turns (invalid value: ${args[i]})`;
      } else {
        maxTurns = n;
      }
    } else if (args[i].startsWith('--')) {
      unknownFlag = args[i];
    } else {
      task = args[i];
    }
  }

  return { task, systemPath, verbose, model, cwd, maxTurns, help, unknownFlag };
}

function loadSystemPrompt(path: string): string {
  try {
    return readFileSync(path, 'utf8').trim();
  } catch {
    return 'You are a code agent. Work step by step. Use tools to read, write, and run code. Report what you did when done.';
  }
}

function transcriptDir(): string {
  return process.env.BREAK_AWAY_TRANSCRIPT_DIR ?? DEFAULT_TRANSCRIPT_DIR;
}

async function runTask(
  task: string,
  systemPrompt: string,
  model: string | null,
  basePolicy: Policy = defaultPolicy,
): Promise<FinalState> {
  const messages: Message[] = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: task },
  ];

  const handle = await openTranscript(transcriptDir());
  await writeEvent(handle, {
    event: 'run_start',
    task,
    model: model ?? process.env.OPENAI_COMPATIBLE_MODEL ?? 'gpt-4o',
    cwd: process.cwd(),
  });

  const policy = { ...basePolicy, onEvent: (e: Record<string, unknown>) => writeEvent(handle, e) };
  const state = await run(messages, tools, policy, model);

  await writeEvent(handle, {
    event: 'done',
    turns: state.turns,
    tokens: state.usage.total_tokens,
    duration_ms: state.elapsed,
  });
  await closeTranscript(handle);

  return state;
}

async function repl(systemPrompt: string, model: string | null, basePolicy: Policy = defaultPolicy): Promise<void> {
  const messages: Message[] = [{ role: 'system', content: systemPrompt }];

  const handle = await openTranscript(transcriptDir());
  await writeEvent(handle, {
    event: 'run_start',
    task: 'repl',
    model: model ?? process.env.OPENAI_COMPATIBLE_MODEL ?? 'gpt-4o',
    cwd: process.cwd(),
  });

  process.stderr.write('break-away repl — ctrl+D to exit\n');

  for await (const line of console) {
    const task = line.trim();
    if (!task) {
      process.stderr.write('> ');
      continue;
    }

    messages.push({ role: 'user', content: task });

    const replPolicy = { ...basePolicy, onEvent: (e: Record<string, unknown>) => writeEvent(handle, e) };
    const state = await run(messages, tools, replPolicy, model);

    // Append the assistant's final reply to messages for continuity
    const lastAssistant = [...state.messages].reverse().find((m) => m.role === 'assistant');
    if (lastAssistant) {
      // state.messages already has it; splice back in for next round
      messages.length = 0;
      messages.push(...state.messages);
    }

    const lastMsg = state.messages[state.messages.length - 1];
    if (lastMsg && lastMsg.content) {
      process.stdout.write(lastMsg.content + '\n');
    }

    await writeEvent(handle, {
      event: 'done',
      turns: state.turns,
      tokens: state.usage.total_tokens,
      duration_ms: state.elapsed,
    });

    process.stderr.write(formatStats(state) + '\n');
    process.stderr.write('> ');
  }

  await closeTranscript(handle);
}

async function main(): Promise<void> {
  const { task, systemPath, verbose, model, cwd, maxTurns, help, unknownFlag } = parseArgs(process.argv);

  if (unknownFlag) {
    process.stderr.write(`error: unknown flag: ${unknownFlag}\n\n${USAGE}\n`);
    process.exit(1);
  }

  if (help) {
    process.stderr.write(USAGE + '\n');
    process.exit(0);
  }

  setVerbose(verbose);

  if (cwd) {
    const resolved = resolve(cwd);
    if (!existsSync(resolved)) {
      process.stderr.write(`error: --cwd path does not exist: ${resolved}\n\n${USAGE}\n`);
      process.exit(1);
    }
    process.chdir(resolved);
  }

  const systemPrompt = loadSystemPrompt(systemPath);
  const policy = maxTurns !== null ? { ...defaultPolicy, maxTurns } : defaultPolicy;

  if (task) {
    const state = await runTask(task, systemPrompt, model, policy);
    const lastMsg = state.messages[state.messages.length - 1];
    if (lastMsg && lastMsg.content) {
      process.stdout.write(lastMsg.content + '\n');
    }
    // Stats to stderr only
    process.stderr.write(formatStats(state) + '\n');
  } else {
    await repl(systemPrompt, model, policy);
  }
}

if (import.meta.main) {
  main().catch((err) => {
    process.stderr.write(`fatal: ${err}\n`);
    process.exit(1);
  });
}
