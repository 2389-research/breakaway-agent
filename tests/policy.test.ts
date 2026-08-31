// ABOUTME: Tests for defaultPolicy — verifies values and the identity contextStrategy.
// ABOUTME: No I/O; pure assertions against the exported policy object.

import { describe, test, expect } from 'bun:test';
import { defaultPolicy, seriousPolicy, selectPolicy } from '../src/policy.ts';
import type { Message } from '../src/types.ts';

describe('defaultPolicy', () => {
  test('maxTurns has no limit — the default run is unbounded', () => {
    expect(defaultPolicy.maxTurns).toBe(Infinity);
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

  test('isComplete accepts a real finish — assistant, content, no tool calls', () => {
    const msg: Message = { role: 'assistant', content: 'here is the answer' };
    expect(defaultPolicy.isComplete(msg)).toBe(true);
  });

  test('isComplete rejects a blank finish — empty content is not an answer', () => {
    const msg: Message = { role: 'assistant', content: '   ' };
    expect(defaultPolicy.isComplete(msg)).toBe(false);
  });

  test('isComplete rejects a message that still has tool calls — the model is not done', () => {
    const msg: Message = {
      role: 'assistant',
      content: '',
      tool_calls: [{ id: 'tc1', type: 'function', function: { name: 'bash', arguments: '{}' } }],
    };
    expect(defaultPolicy.isComplete(msg)).toBe(false);
  });

  test('isComplete rejects a non-assistant message', () => {
    const msg: Message = { role: 'user', content: 'hi' };
    expect(defaultPolicy.isComplete(msg)).toBe(false);
  });

  test('isComplete treats an empty tool_calls array as a real finish when content is present', () => {
    const msg: Message = { role: 'assistant', content: 'done', tool_calls: [] };
    expect(defaultPolicy.isComplete(msg)).toBe(true);
  });

  test('maxEmptyRetries is 1 — one nudge on a blank finish, then the run errors', () => {
    expect(defaultPolicy.maxEmptyRetries).toBe(1);
  });

  test('completionAudit is on by default — every run audits its finish before accepting done', () => {
    expect(defaultPolicy.completionAudit).toBe(true);
  });
});

describe('seriousPolicy — the long-horizon profile', () => {
  test('maxTurns has no limit — a serious run is unbounded too', () => {
    expect(seriousPolicy.maxTurns).toBe(Infinity);
  });

  test('apiMaxAttempts is higher than default — more blip-survival on a long run', () => {
    expect(seriousPolicy.apiMaxAttempts).toBe(5);
    expect(defaultPolicy.apiMaxAttempts).toBe(3);
  });

  test('completionAudit is on — a serious run audits its own completion before finishing', () => {
    expect(seriousPolicy.completionAudit).toBe(true);
  });

  test('inherits the rest of the default policy', () => {
    expect(seriousPolicy.onToolError).toBe(defaultPolicy.onToolError);
    expect(seriousPolicy.isComplete).toBe(defaultPolicy.isComplete);
  });
});

describe('selectPolicy — CLI intent to policy', () => {
  test('neither flag: the default policy, by reference', () => {
    expect(selectPolicy({ serious: false, maxTurns: null })).toBe(defaultPolicy);
  });

  test('--serious: the serious profile, by reference', () => {
    expect(selectPolicy({ serious: true, maxTurns: null })).toBe(seriousPolicy);
  });

  test('--max-turns overrides the default horizon and leaves the rest default', () => {
    const p = selectPolicy({ serious: false, maxTurns: 10 });
    expect(p.maxTurns).toBe(10);
    expect(p.apiMaxAttempts).toBe(3);
  });

  test('explicit --max-turns wins over --serious, but keeps the serious survival bump', () => {
    const p = selectPolicy({ serious: true, maxTurns: 120 });
    expect(p.maxTurns).toBe(120); // explicit number wins
    expect(p.apiMaxAttempts).toBe(5); // ...but serious survival stays
  });
});
