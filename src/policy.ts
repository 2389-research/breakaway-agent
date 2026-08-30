// ABOUTME: Default policy for the agent loop — max turns, error handling, context, and continuation.
// ABOUTME: Swap any field to change agent behavior without touching the loop itself.

import type { Policy, Message } from './types.ts';

export const defaultPolicy: Policy = {
  maxTurns: 40,
  onToolError: 'retry',
  contextStrategy: (messages: Message[]) => messages,
  shouldContinue: (msg: Message) => msg.role === 'assistant' && !!msg.tool_calls?.length,
};
