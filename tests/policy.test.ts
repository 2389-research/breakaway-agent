// ABOUTME: Tests for defaultPolicy — verifies values and the identity contextStrategy.
// ABOUTME: No I/O; pure assertions against the exported policy object.

import { describe, test, expect } from 'bun:test';
import { defaultPolicy, seriousPolicy, selectPolicy, compactByCheckpoints } from '../src/policy.ts';
import { STRATEGY_CHECKPOINT_MARKER } from '../src/agent.ts';
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

  test('classifyFinish returns done for a real finish — assistant, content, no tool calls', () => {
    const msg: Message = { role: 'assistant', content: 'here is the answer' };
    expect(defaultPolicy.classifyFinish(msg)).toBe('done');
  });

  test('classifyFinish returns empty for a blank finish — whitespace is not an answer', () => {
    const msg: Message = { role: 'assistant', content: '   ' };
    expect(defaultPolicy.classifyFinish(msg)).toBe('empty');
  });

  test('classifyFinish returns empty when tool calls are still pending', () => {
    const msg: Message = {
      role: 'assistant',
      content: '',
      tool_calls: [{ id: 'tc1', type: 'function', function: { name: 'bash', arguments: '{}' } }],
    };
    expect(defaultPolicy.classifyFinish(msg)).toBe('empty');
  });

  test('classifyFinish returns empty for a non-assistant message', () => {
    const msg: Message = { role: 'user', content: 'hi' };
    expect(defaultPolicy.classifyFinish(msg)).toBe('empty');
  });

  test('classifyFinish returns done with an empty tool_calls array when content is present', () => {
    const msg: Message = { role: 'assistant', content: 'done', tool_calls: [] };
    expect(defaultPolicy.classifyFinish(msg)).toBe('done');
  });

  test('classifyFinish returns blocked for a BLOCKED: line', () => {
    const msg: Message = { role: 'assistant', content: 'BLOCKED: no AWS credentials in this environment' };
    expect(defaultPolicy.classifyFinish(msg)).toBe('blocked');
  });

  test('classifyFinish detects BLOCKED case-insensitively and after leading whitespace', () => {
    const msg: Message = { role: 'assistant', content: '   blocked: cannot reach the database' };
    expect(defaultPolicy.classifyFinish(msg)).toBe('blocked');
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
    expect(seriousPolicy.classifyFinish).toBe(defaultPolicy.classifyFinish);
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

describe('compactByCheckpoints — rolling evidence compaction', () => {
  const sys: Message = { role: 'system', content: 'sys' };
  const task: Message = { role: 'user', content: 'the original task' };
  const cp = (n: number): Message => ({ role: 'user', content: `${STRATEGY_CHECKPOINT_MARKER}\nturn ${n}` });
  const summary = (s: string): Message => ({ role: 'assistant', content: s });
  const toolCall: Message = {
    role: 'assistant',
    content: '',
    tool_calls: [{ id: 'tc', type: 'function', function: { name: 'bash', arguments: '{}' } }],
  };
  const toolResult: Message = { role: 'tool', content: 'ran', tool_call_id: 'tc', name: 'bash' };

  test('no checkpoint → identity (same array reference)', () => {
    const msgs = [sys, task, toolCall, toolResult];
    expect(compactByCheckpoints(msgs)).toBe(msgs);
  });

  test('a lone pending checkpoint (no summary yet) → identity, so its raw context survives', () => {
    const msgs = [sys, task, toolCall, toolResult, cp(2)];
    expect(compactByCheckpoints(msgs)).toBe(msgs);
  });

  test('one completed checkpoint → drops raw pre-checkpoint turns, keeps system+task+tail', () => {
    const working: Message = { role: 'assistant', content: 'still working' };
    const msgs = [sys, task, toolCall, toolResult, cp(2), summary('S2'), working];
    const view = compactByCheckpoints(msgs);
    expect(view).toEqual([sys, task, cp(2), summary('S2'), working]);
    expect(view).not.toContain(toolResult); // the raw pre-checkpoint tool pair is gone from the view
  });

  test('completed checkpoint followed by a fresh pending one → keeps everything from the completed one on', () => {
    const work: Message = { role: 'assistant', content: 'work' };
    const msgs = [sys, task, toolCall, toolResult, cp(2), summary('S2'), work, cp(4)];
    const view = compactByCheckpoints(msgs);
    expect(view).toEqual([sys, task, cp(2), summary('S2'), work, cp(4)]);
  });

  test('multiple completed checkpoints → keeps every summary (the evidence trail)', () => {
    const more: Message = { role: 'assistant', content: 'more' };
    const msgs = [sys, task, cp(2), summary('S2'), toolCall, toolResult, cp(4), summary('S4'), more];
    const view = compactByCheckpoints(msgs);
    expect(view).toEqual([sys, task, summary('S2'), cp(4), summary('S4'), more]);
  });

  test('a kept region never orphans a tool result from its call', () => {
    const msgs = [sys, task, cp(2), summary('S2'), toolCall, toolResult];
    const view = compactByCheckpoints(msgs);
    const idxCall = view.indexOf(toolCall);
    const idxResult = view.indexOf(toolResult);
    expect(idxCall).toBeGreaterThanOrEqual(0);
    expect(idxResult).toBe(idxCall + 1);
  });
});
