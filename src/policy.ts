// ABOUTME: Default policy for the agent loop — max turns, error handling, context, and continuation.
// ABOUTME: Swap any field to change agent behavior without touching the loop itself.

import type { Policy, Message } from './types.ts';

export const defaultPolicy: Policy = {
  // No turn limit by default: a run finishes when the model does, not at an arbitrary count.
  // `--max-turns N` sets an explicit safety/debug cap; hitting it is an incomplete (nonzero) exit.
  maxTurns: Infinity,
  onToolError: 'retry',
  contextStrategy: (messages: Message[]) => messages,
  shouldContinue: (msg: Message) => msg.role === 'assistant' && !!msg.tool_calls?.length,
  // Survival by default: retry transient gateway blips so a run finishes instead of dying at turn N.
  apiMaxAttempts: 3,
  apiRetryBaseMs: 750,
  // Off by default so existing experiments are unchanged; --serious turns it on.
  completionAudit: false,
};

// The "I mean business" profile (--serious): extra blip-survival plus a completion audit for
// big tasks. Like the default it runs unbounded (maxTurns inherited as Infinity) — the horizon
// is now the model's own judgment, not a turn count.
export const seriousPolicy: Policy = {
  ...defaultPolicy,
  apiMaxAttempts: 5,
  // A serious run should not accept the model's first "looks done" at face value — audit it.
  completionAudit: true,
};

// Resolve CLI intent into a Policy. --serious picks the survival profile; an explicit --max-turns
// then imposes a turn cap on top, so `--serious --max-turns 120` keeps the serious survival
// settings but stops at 120 turns. No flags → the default policy (unbounded), by reference.
export function selectPolicy(opts: { serious: boolean; maxTurns: number | null }): Policy {
  const base = opts.serious ? seriousPolicy : defaultPolicy;
  return opts.maxTurns !== null ? { ...base, maxTurns: opts.maxTurns } : base;
}
