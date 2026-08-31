// ABOUTME: Default policy for the agent loop — max turns, error handling, context, and continuation.
// ABOUTME: Swap any field to change agent behavior without touching the loop itself.

import type { Policy, Message } from './types.ts';

export const defaultPolicy: Policy = {
  maxTurns: 40,
  onToolError: 'retry',
  contextStrategy: (messages: Message[]) => messages,
  shouldContinue: (msg: Message) => msg.role === 'assistant' && !!msg.tool_calls?.length,
  // Survival by default: retry transient gateway blips so a run finishes instead of dying at turn N.
  apiMaxAttempts: 3,
  apiRetryBaseMs: 750,
};

// The "I mean business" profile (--serious): a long horizon for big tasks plus extra
// blip-survival, since a longer run has more chances to hit a transient gateway error.
export const seriousPolicy: Policy = {
  ...defaultPolicy,
  maxTurns: 80,
  apiMaxAttempts: 5,
};

// Resolve CLI intent into a Policy. --serious picks the long-horizon profile; an explicit
// --max-turns then overrides just the turn budget, so `--serious --max-turns 120` keeps the
// serious survival settings but runs to 120 turns. No flags → the default policy, by reference.
export function selectPolicy(opts: { serious: boolean; maxTurns: number | null }): Policy {
  const base = opts.serious ? seriousPolicy : defaultPolicy;
  return opts.maxTurns !== null ? { ...base, maxTurns: opts.maxTurns } : base;
}
