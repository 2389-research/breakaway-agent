// ABOUTME: Tests for defaultPolicy — verifies values and the identity contextStrategy.
// ABOUTME: No I/O; pure assertions against the exported policy object.

import { describe, test, expect } from 'bun:test';
import { defaultPolicy } from '../src/policy.ts';
import type { Message } from '../src/types.ts';

describe('defaultPolicy', () => {
  test('maxTurns is 40', () => {
    expect(defaultPolicy.maxTurns).toBe(40);
  });

  test('onToolError is retry', () => {
    expect(defaultPolicy.onToolError).toBe('retry');
  });

  test('contextStrategy is identity — returns same array', () => {
    const msgs: Message[] = [
      { role: 'system', content: 'hi' },
      { role: 'user', content: 'hello' },
    ];
    const result = defaultPolicy.contextStrategy(msgs);
    expect(result).toBe(msgs); // same reference
  });

  test('contextStrategy preserves all messages', () => {
    const msgs: Message[] = [
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'u1' },
      { role: 'assistant', content: 'a1' },
    ];
    const result = defaultPolicy.contextStrategy(msgs);
    expect(result.length).toBe(3);
    expect(result[0].role).toBe('system');
  });

  test('shouldContinue returns true for assistant message with tool_calls', () => {
    const msg: Message = {
      role: 'assistant',
      content: '',
      tool_calls: [{ id: 'tc1', type: 'function', function: { name: 'bash', arguments: '{}' } }],
    };
    expect(defaultPolicy.shouldContinue(msg)).toBe(true);
  });

  test('shouldContinue returns false for assistant message without tool_calls', () => {
    const msg: Message = { role: 'assistant', content: 'done' };
    expect(defaultPolicy.shouldContinue(msg)).toBe(false);
  });

  test('shouldContinue returns false for user message', () => {
    const msg: Message = { role: 'user', content: 'hi' };
    expect(defaultPolicy.shouldContinue(msg)).toBe(false);
  });

  test('shouldContinue returns false for empty tool_calls array', () => {
    const msg: Message = { role: 'assistant', content: 'done', tool_calls: [] };
    expect(defaultPolicy.shouldContinue(msg)).toBe(false);
  });
});
