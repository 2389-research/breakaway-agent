// ABOUTME: Default policy for the agent loop — max turns, error handling, context, and continuation.
// ABOUTME: Swap any field to change agent behavior without touching the loop itself.

import type { Policy, Message } from './types.ts';

export const defaultPolicy: Policy = {
  // No turn limit by default: a run finishes when the model does, not at an arbitrary count.
  // `--max-turns N` sets an explicit safety/debug cap; hitting it is an incomplete (nonzero) exit.
  maxTurns: Infinity,
  onToolError: 'retry',
  contextStrategy: (messages: Message[]) => messages,
  // A finish must be a real answer, an honest block, or a blank. A blank no-tool response is
  // 'empty' (never 'done'); a line beginning BLOCKED: is an honest terminal state.
  classifyFinish: (msg: Message): 'done' | 'blocked' | 'empty' => {
    if (msg.role !== 'assistant' || msg.tool_calls?.length) return 'empty';
    const content = (msg.content ?? '').trim();
    if (content === '') return 'empty';
    if (/^BLOCKED:/i.test(content)) return 'blocked';
    return 'done';
  },
  // Survival by default: retry transient gateway blips so a run finishes instead of dying at turn N.
  apiMaxAttempts: 3,
  apiRetryBaseMs: 750,
  // A blank finish gets this many nudges to recover before the run ends as 'error' (never a false done).
  maxEmptyRetries: 1,
  // On by default: never accept the model's first "looks done" without one enforced verify pass.
  completionAudit: true,
};

// The "I mean business" profile (--serious): extra blip-survival on top of the default. The
// completion audit is already baseline (on in defaultPolicy), so serious only needs to add more
// API-retry headroom. Like the default it runs unbounded (maxTurns inherited as Infinity).
export const seriousPolicy: Policy = {
  ...defaultPolicy,
  apiMaxAttempts: 5,
};

// Resolve CLI intent into a Policy. --serious picks the survival profile; an explicit --max-turns
// then imposes a turn cap on top, so `--serious --max-turns 120` keeps the serious survival
// settings but stops at 120 turns. No flags → the default policy (unbounded), by reference.
export function selectPolicy(opts: { serious: boolean; maxTurns: number | null }): Policy {
  const base = opts.serious ? seriousPolicy : defaultPolicy;
  return opts.maxTurns !== null ? { ...base, maxTurns: opts.maxTurns } : base;
}
