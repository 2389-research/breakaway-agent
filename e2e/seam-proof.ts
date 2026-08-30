// ABOUTME: Seam proof — runs the same task under two policies (default vs sliding window).
// ABOUTME: Prints both stats lines to stdout to show how contextStrategy swaps at the seam.

import { run } from '../src/agent.ts';
import { tools } from '../src/tools.ts';
import { defaultPolicy } from '../src/policy.ts';
import { formatStats } from '../src/index.ts';
import type { Message, Policy } from '../src/types.ts';
import { readFileSync } from 'node:fs';

const SYSTEM = readFileSync(
  new URL('../system.txt', import.meta.url).pathname,
  'utf8',
).trim();

const TASK = 'In /tmp/breakaway-seam-proof, write a file hello.txt containing "seam proof". Then read it back and confirm the content.';

// Sliding-window: keep system + last N messages
function slidingWindow(n: number) {
  return (messages: Message[]): Message[] => {
    const system = messages.filter((m) => m.role === 'system');
    const rest = messages.filter((m) => m.role !== 'system');
    return [...system, ...rest.slice(-n)];
  };
}

async function runWithPolicy(label: string, policy: Policy): Promise<void> {
  const messages: Message[] = [
    { role: 'system', content: SYSTEM },
    { role: 'user', content: TASK },
  ];
  const state = await run(messages, tools, policy);
  process.stdout.write(`[${label}] ${formatStats(state)}\n`);
}

async function main() {
  process.stderr.write('running with default policy (full context)...\n');
  await runWithPolicy('default', defaultPolicy);

  process.stderr.write('running with sliding-window policy (last 5 messages)...\n');
  const slidingPolicy: Policy = {
    ...defaultPolicy,
    contextStrategy: slidingWindow(5),
  };
  await runWithPolicy('sliding-window-5', slidingPolicy);
}

main().catch((err) => {
  process.stderr.write(`fatal: ${err}\n`);
  process.exit(1);
});
