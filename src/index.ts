// ABOUTME: CLI entry point — parses args, builds initial messages, runs REPL or one-shot mode.
// ABOUTME: Every run ends with a stats line to stdout. Tool progress goes to stderr.

import { run, setVerbose } from './agent.ts';
import { tools } from './tools.ts';
import { defaultPolicy } from './policy.ts';
import type { Message, FinalState } from './types.ts';
import { readFileSync } from 'node:fs';

export function formatStats(state: FinalState): string {
  const secs = (state.elapsed / 1000).toFixed(1);
  return `done in ${state.turns} turns, ${state.usage.total_tokens} tokens (prompt: ${state.usage.prompt_tokens} / completion: ${state.usage.completion_tokens}), ${secs}s`;
}

function parseArgs(argv: string[]): { task: string | null; systemPath: string; verbose: boolean } {
  let task: string | null = null;
  let systemPath = 'system.txt';
  let verbose = false;

  const args = argv.slice(2);
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--verbose') {
      verbose = true;
    } else if (args[i] === '--system' && args[i + 1]) {
      systemPath = args[++i];
    } else if (!args[i].startsWith('--')) {
      task = args[i];
    }
  }

  return { task, systemPath, verbose };
}

function loadSystemPrompt(path: string): string {
  try {
    return readFileSync(path, 'utf8').trim();
  } catch {
    return 'You are a code agent. Work step by step. Use tools to read, write, and run code. Report what you did when done.';
  }
}

async function runTask(task: string, systemPrompt: string): Promise<FinalState> {
  const messages: Message[] = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: task },
  ];

  return run(messages, tools, defaultPolicy);
}

async function repl(systemPrompt: string): Promise<void> {
  const messages: Message[] = [{ role: 'system', content: systemPrompt }];

  process.stdout.write('break-away repl — ctrl+D to exit\n');

  for await (const line of console) {
    const task = line.trim();
    if (!task) {
      process.stdout.write('> ');
      continue;
    }

    messages.push({ role: 'user', content: task });

    const state = await run(messages, tools, defaultPolicy);

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

    process.stdout.write(formatStats(state) + '\n');
    process.stdout.write('> ');
  }
}

async function main(): Promise<void> {
  const { task, systemPath, verbose } = parseArgs(process.argv);

  setVerbose(verbose);

  const systemPrompt = loadSystemPrompt(systemPath);

  if (task) {
    const state = await runTask(task, systemPrompt);
    const lastMsg = state.messages[state.messages.length - 1];
    if (lastMsg && lastMsg.content) {
      process.stdout.write(lastMsg.content + '\n');
    }
    process.stdout.write(formatStats(state) + '\n');
  } else {
    await repl(systemPrompt);
  }
}

if (import.meta.main) {
  main().catch((err) => {
    process.stderr.write(`fatal: ${err}\n`);
    process.exit(1);
  });
}
