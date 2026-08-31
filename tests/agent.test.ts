// ABOUTME: Tests for the agent loop state machine using canned LLM response objects.
// ABOUTME: Mocks client.chat to isolate loop logic from real API calls.

import { describe, test, expect, mock, beforeEach } from 'bun:test';
import type { Message, Tool, Policy, FinalState } from '../src/types.ts';
import { defaultPolicy } from '../src/policy.ts';

// --- Mock client module before importing agent ---
const mockChat = mock(async () => ({
  message: { role: 'assistant' as const, content: 'done' },
  usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
  finish_reason: 'stop',
}));

mock.module('../src/client.ts', () => ({ chat: mockChat }));

// Import agent AFTER mocking
const { run, STRATEGY_CHECKPOINT_MARKER } = await import('../src/agent.ts');

// A no-op tool for testing
function makeTool(name: string, handler: (args: Record<string, unknown>) => Promise<string> = async () => 'ok'): Tool {
  return {
    definition: {
      type: 'function',
      function: {
        name,
        description: `Tool ${name}`,
        parameters: { type: 'object', properties: {}, required: [] },
      },
    },
    handler,
  };
}

function makePolicy(overrides: Partial<Policy> = {}): Policy {
  // Most loop tests isolate behavior from the completion audit (on in the real default policy);
  // the audit has its own describe block that opts in explicitly with completionAudit: true.
  return { ...defaultPolicy, completionAudit: false, ...overrides };
}

function initialMessages(task = 'do something'): Message[] {
  return [
    { role: 'system', content: 'you are an agent' },
    { role: 'user', content: task },
  ];
}

beforeEach(() => {
  mockChat.mockReset();
});

describe('agent run — basic flow', () => {
  test('returns done when finish_reason is stop', async () => {
    mockChat.mockResolvedValueOnce({
      message: { role: 'assistant', content: 'all done' },
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      finish_reason: 'stop',
    });

    const state = await run(initialMessages(), [], makePolicy());
    expect(state.stopReason).toBe('done');
    expect(state.turns).toBe(1);
  });

  test('accumulates usage across turns', async () => {
    // Turn 1: tool call
    mockChat.mockResolvedValueOnce({
      message: {
        role: 'assistant',
        content: '',
        tool_calls: [{ id: 'tc1', type: 'function', function: { name: 'my_tool', arguments: '{}' } }],
      },
      usage: { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 },
      finish_reason: 'tool_calls',
    });
    // Turn 2: done
    mockChat.mockResolvedValueOnce({
      message: { role: 'assistant', content: 'finished' },
      usage: { prompt_tokens: 30, completion_tokens: 5, total_tokens: 35 },
      finish_reason: 'stop',
    });

    const state = await run(initialMessages(), [makeTool('my_tool')], makePolicy());
    expect(state.usage.prompt_tokens).toBe(50);
    expect(state.usage.completion_tokens).toBe(15);
    expect(state.usage.total_tokens).toBe(65);
    expect(state.turns).toBe(2);
  });
});

describe('agent run — unknown tool', () => {
  test('unknown tool name → error result + continue (does not abort)', async () => {
    // Turn 1: calls unknown tool
    mockChat.mockResolvedValueOnce({
      message: {
        role: 'assistant',
        content: '',
        tool_calls: [{ id: 'tc1', type: 'function', function: { name: 'ghost_tool', arguments: '{}' } }],
      },
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      finish_reason: 'tool_calls',
    });
    // Turn 2: finishes normally
    mockChat.mockResolvedValueOnce({
      message: { role: 'assistant', content: 'ok' },
      usage: { prompt_tokens: 15, completion_tokens: 5, total_tokens: 20 },
      finish_reason: 'stop',
    });

    const state = await run(initialMessages(), [], makePolicy({ onToolError: 'abort' }));
    // Should continue past the unknown tool and finish normally
    expect(state.stopReason).toBe('done');
    expect(state.turns).toBe(2);

    // Find the tool result message
    const toolResult = state.messages.find((m) => m.role === 'tool');
    expect(toolResult?.content).toMatch(/unknown tool/);
  });
});

describe('agent run — maxTurns', () => {
  test('stops at maxTurns and returns maxTurns stopReason', async () => {
    // Every turn returns a tool call — never finishes
    mockChat.mockImplementation(async () => ({
      message: {
        role: 'assistant' as const,
        content: '',
        tool_calls: [{ id: 'tc1', type: 'function', function: { name: 'my_tool', arguments: '{}' } }],
      },
      usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 },
      finish_reason: 'tool_calls',
    }));

    const state = await run(initialMessages(), [makeTool('my_tool')], makePolicy({ maxTurns: 3 }));
    expect(state.stopReason).toBe('maxTurns');
    expect(state.turns).toBe(3);
  });

  test('does not strip tools on the final turn — every model call gets the full tool set', async () => {
    // There is no forced tool-less synthesis turn: the model keeps its tools on every turn,
    // including the one that hits the cap. Hitting the cap is an incomplete outcome we preserve.
    mockChat.mockImplementation(async () => ({
      message: {
        role: 'assistant' as const,
        content: '',
        tool_calls: [{ id: 'tc1', type: 'function', function: { name: 'my_tool', arguments: '{}' } }],
      },
      usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 },
      finish_reason: 'tool_calls',
    }));

    const state = await run(initialMessages(), [makeTool('my_tool')], makePolicy({ maxTurns: 3 }));

    // An explicit cap still returns an incomplete maxTurns result.
    expect(state.stopReason).toBe('maxTurns');
    expect(state.turns).toBe(3);

    // No turn was called with tools stripped — every call saw the one tool.
    const calls = mockChat.mock.calls;
    expect(calls.length).toBe(3);
    for (const call of calls) {
      expect((call[1] as unknown[]).length).toBe(1);
    }

    // Partial output is preserved: the transcript keeps every turn's assistant message.
    const assistantMsgs = state.messages.filter((m) => m.role === 'assistant');
    expect(assistantMsgs.length).toBe(3);
  });

  test('runs past the old default cap when no explicit limit is set', async () => {
    // 45 tool turns, then a finish — well past the old default of 40. With no cap, the loop
    // must not stop early; it runs to a genuine completion instead of a maxTurns cutoff.
    let calls = 0;
    mockChat.mockImplementation(async () => {
      calls++;
      if (calls <= 45) {
        return {
          message: {
            role: 'assistant' as const,
            content: '',
            tool_calls: [{ id: 'tc1', type: 'function', function: { name: 'my_tool', arguments: '{}' } }],
          },
          usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 },
          finish_reason: 'tool_calls' as const,
        };
      }
      return {
        message: { role: 'assistant' as const, content: 'finally finished' },
        usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 },
        finish_reason: 'stop' as const,
      };
    });

    const state = await run(initialMessages(), [makeTool('my_tool')], makePolicy());
    expect(state.stopReason).toBe('done');
    expect(state.turns).toBe(46);
  });
});

describe('agent run — onToolError abort', () => {
  test('aborts loop when known tool errors with onToolError=abort', async () => {
    mockChat.mockResolvedValueOnce({
      message: {
        role: 'assistant',
        content: '',
        tool_calls: [{ id: 'tc1', type: 'function', function: { name: 'bad_tool', arguments: '{}' } }],
      },
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      finish_reason: 'tool_calls',
    });

    const errorTool = makeTool('bad_tool', async () => {
      throw new Error('boom');
    });

    const state = await run(initialMessages(), [errorTool], makePolicy({ onToolError: 'abort' }));
    expect(state.stopReason).toBe('aborted');
    // Should not have called chat a second time
    expect(mockChat.mock.calls.length).toBe(1);
  });
});

describe('agent run — onToolError nudge', () => {
  test('pushes user nudge message and continues on tool error', async () => {
    // Turn 1: tool call to erroring tool
    mockChat.mockResolvedValueOnce({
      message: {
        role: 'assistant',
        content: '',
        tool_calls: [{ id: 'tc1', type: 'function', function: { name: 'flaky_tool', arguments: '{}' } }],
      },
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      finish_reason: 'tool_calls',
    });
    // Turn 2: done
    mockChat.mockResolvedValueOnce({
      message: { role: 'assistant', content: 'recovered' },
      usage: { prompt_tokens: 15, completion_tokens: 5, total_tokens: 20 },
      finish_reason: 'stop',
    });

    const errorTool = makeTool('flaky_tool', async () => {
      throw new Error('flaky');
    });

    const state = await run(initialMessages(), [errorTool], makePolicy({ onToolError: 'nudge' }));
    expect(state.stopReason).toBe('done');

    const nudge = state.messages.find((m) => m.role === 'user' && m.content === 'that tool errored, try again');
    expect(nudge).toBeDefined();
  });
});

describe('agent run — onToolError retry', () => {
  test('retries the tool once on error and pushes the retry result', async () => {
    mockChat.mockResolvedValueOnce({
      message: {
        role: 'assistant',
        content: '',
        tool_calls: [{ id: 'tc1', type: 'function', function: { name: 'flaky_retry', arguments: '{}' } }],
      },
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      finish_reason: 'tool_calls',
    });
    mockChat.mockResolvedValueOnce({
      message: { role: 'assistant', content: 'done after retry' },
      usage: { prompt_tokens: 15, completion_tokens: 5, total_tokens: 20 },
      finish_reason: 'stop',
    });

    let callCount = 0;
    const retryTool = makeTool('flaky_retry', async () => {
      callCount++;
      if (callCount === 1) throw new Error('first attempt fails');
      return 'retry succeeded';
    });

    const state = await run(initialMessages(), [retryTool], makePolicy({ onToolError: 'retry' }));
    expect(state.stopReason).toBe('done');
    // Tool was called twice (original + 1 retry)
    expect(callCount).toBe(2);
    // The retry result is in messages
    const toolResult = state.messages.find((m) => m.role === 'tool');
    expect(toolResult?.content).toBe('retry succeeded');
  });
});

describe('agent run — contextStrategy', () => {
  test('contextStrategy is called before each API call', async () => {
    let called = 0;
    const capturingStrategy = (messages: Message[]) => {
      called++;
      return messages;
    };

    mockChat.mockResolvedValueOnce({
      message: {
        role: 'assistant',
        content: '',
        tool_calls: [{ id: 'tc1', type: 'function', function: { name: 'my_tool', arguments: '{}' } }],
      },
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      finish_reason: 'tool_calls',
    });
    mockChat.mockResolvedValueOnce({
      message: { role: 'assistant', content: 'done' },
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      finish_reason: 'stop',
    });

    await run(initialMessages(), [makeTool('my_tool')], makePolicy({ contextStrategy: capturingStrategy }));
    expect(called).toBe(2);
  });
});

describe('agent run — onEvent observer', () => {
  test('collects assistant, tool_call, tool_result, assistant events for a scripted exchange', async () => {
    // Turn 1: assistant calls a tool
    mockChat.mockResolvedValueOnce({
      message: {
        role: 'assistant',
        content: 'let me check',
        tool_calls: [{ id: 'tc1', type: 'function', function: { name: 'my_tool', arguments: '{"x":1}' } }],
      },
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      finish_reason: 'tool_calls',
    });
    // Turn 2: done
    mockChat.mockResolvedValueOnce({
      message: { role: 'assistant', content: 'all done' },
      usage: { prompt_tokens: 15, completion_tokens: 5, total_tokens: 20 },
      finish_reason: 'stop',
    });

    const events: Record<string, unknown>[] = [];
    const policy = makePolicy({
      onEvent: (e) => events.push(e),
    });

    await run(initialMessages(), [makeTool('my_tool', async () => 'tool output')], policy);

    // Expect: assistant (with tool_calls) → tool_call → tool_result → assistant (final)
    expect(events.length).toBe(4);

    const [ev0, ev1, ev2, ev3] = events;

    expect(ev0.event).toBe('assistant');
    expect(ev0.content).toBe('let me check');
    expect(Array.isArray(ev0.tool_calls)).toBe(true);
    const tc0 = (ev0.tool_calls as Array<{ name: string; args_chars: number }>)[0];
    expect(tc0.name).toBe('my_tool');
    expect(tc0.args_chars).toBe('{"x":1}'.length);

    expect(ev1.event).toBe('tool_call');
    expect(ev1.name).toBe('my_tool');
    expect((ev1.args as Record<string, unknown>).x).toBe(1);

    expect(ev2.event).toBe('tool_result');
    expect(ev2.name).toBe('my_tool');
    expect(ev2.chars).toBe('tool output'.length);
    expect(ev2.truncated).toBe(false);

    expect(ev3.event).toBe('assistant');
    expect(ev3.content).toBe('all done');
    expect(Array.isArray(ev3.tool_calls)).toBe(true);
    expect((ev3.tool_calls as unknown[]).length).toBe(0);
  });

  test('redacts secrets in tool output before they reach the model or transcript', async () => {
    // Turn 1: model calls a tool that leaks a secret; Turn 2: model finishes.
    mockChat.mockResolvedValueOnce({
      message: {
        role: 'assistant',
        content: '',
        tool_calls: [{ id: 'tc1', type: 'function', function: { name: 'leaky', arguments: '{}' } }],
      },
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      finish_reason: 'tool_calls',
    });
    mockChat.mockResolvedValueOnce({
      message: { role: 'assistant', content: 'ok' },
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      finish_reason: 'stop',
    });

    const secret = 'lr_livekey0123456789abcdef';
    const events: Record<string, unknown>[] = [];
    const leaky = makeTool('leaky', async () => `OPENAI_COMPATIBLE_API_KEY=${secret}`);

    const state = await run(initialMessages(), [leaky], makePolicy({ onEvent: (e) => events.push(e) }));

    // The tool message the model sees must not contain the secret.
    const toolMsg = state.messages.find((m) => m.role === 'tool');
    expect(toolMsg?.content).not.toContain(secret);
    expect(toolMsg?.content).toContain('[REDACTED]');

    // The transcript tool_result event must not contain the secret either.
    const toolResultEvent = events.find((e) => e.event === 'tool_result');
    expect(String(toolResultEvent?.result)).not.toContain(secret);
    expect(String(toolResultEvent?.result)).toContain('[REDACTED]');
  });

  test('a throwing onEvent observer does not crash the run', async () => {
    mockChat.mockResolvedValueOnce({
      message: { role: 'assistant', content: 'fine' },
      usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 },
      finish_reason: 'stop',
    });

    const policy = makePolicy({
      onEvent: () => { throw new Error('observer explodes'); },
    });

    const state = await run(initialMessages(), [], policy);
    expect(state.stopReason).toBe('done');
  });
});

describe('agent run — API retry (survive transient errors)', () => {
  test('retries a transient API error and completes instead of dying', async () => {
    let calls = 0;
    mockChat.mockImplementation(async () => {
      calls++;
      if (calls === 1) {
        // Mirror a real OpenAI APIError: a numeric .status rides on the thrown error.
        throw Object.assign(new Error('bad gateway sk-should-not-leak'), { status: 503 });
      }
      return {
        message: { role: 'assistant' as const, content: 'recovered' },
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
        finish_reason: 'stop',
      };
    });

    const events: Record<string, unknown>[] = [];
    const state = await run(
      initialMessages(),
      [],
      makePolicy({ apiMaxAttempts: 3, apiRetryBaseMs: 1, onEvent: (e) => events.push(e) }),
    );

    // A single blip must not kill the run — this is the whole point of the fix.
    expect(state.stopReason).toBe('done');
    expect(calls).toBe(2);
    // A retried API call is NOT a turn: the model only produced one real response.
    expect(state.turns).toBe(1);

    // The retry is observable to the TUI...
    const retry = events.find((e) => e.event === 'api_retry');
    expect(retry).toBeDefined();
    expect(retry?.attempt).toBe(1);
    expect(retry?.max_attempts).toBe(3);
    // ...but the event must not leak the error payload — status only, no keys, no message body.
    const reason = String(retry?.reason);
    expect(reason).toContain('503');
    expect(reason).not.toContain('sk-');
  });

  test('gives up after apiMaxAttempts transient failures and returns error', async () => {
    let calls = 0;
    mockChat.mockImplementation(async () => {
      calls++;
      throw Object.assign(new Error('server exploded'), { status: 500 });
    });

    const state = await run(
      initialMessages(),
      [],
      makePolicy({ apiMaxAttempts: 3, apiRetryBaseMs: 1 }),
    );

    expect(state.stopReason).toBe('error');
    // Exactly apiMaxAttempts total tries — bounded, never infinite.
    expect(calls).toBe(3);
  });

  test('does not retry a permanent client error', async () => {
    let calls = 0;
    mockChat.mockImplementation(async () => {
      calls++;
      throw Object.assign(new Error('unauthorized'), { status: 401 });
    });

    const state = await run(
      initialMessages(),
      [],
      makePolicy({ apiMaxAttempts: 3, apiRetryBaseMs: 1 }),
    );

    expect(state.stopReason).toBe('error');
    // 401 is a permanent client error — one attempt, no wasted retries.
    expect(calls).toBe(1);
  });

  test('a transient blip mid-run does not inflate the turn count', async () => {
    let calls = 0;
    mockChat.mockImplementation(async () => {
      calls++;
      if (calls === 1) {
        return {
          message: {
            role: 'assistant' as const,
            content: '',
            tool_calls: [{ id: 'tc1', type: 'function', function: { name: 'my_tool', arguments: '{}' } }],
          },
          usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 },
          finish_reason: 'tool_calls',
        };
      }
      if (calls === 2) {
        throw Object.assign(new Error('rate limited'), { status: 429 });
      }
      return {
        message: { role: 'assistant' as const, content: 'done after blip' },
        usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 },
        finish_reason: 'stop',
      };
    });

    const state = await run(
      initialMessages(),
      [makeTool('my_tool')],
      makePolicy({ apiMaxAttempts: 3, apiRetryBaseMs: 1 }),
    );

    expect(state.stopReason).toBe('done');
    // Two real model responses = two turns; the 429 blip between them is not a turn.
    expect(state.turns).toBe(2);
    expect(calls).toBe(3);
  });
});

describe('agent run — completion audit (catch false victory)', () => {
  const noToolFinish = (content: string) => ({
    message: { role: 'assistant' as const, content },
    usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 },
    finish_reason: 'stop' as const,
  });
  const toolCall = (name: string) => ({
    message: {
      role: 'assistant' as const,
      content: '',
      tool_calls: [{ id: 'tc1', type: 'function' as const, function: { name, arguments: '{}' } }],
    },
    usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 },
    finish_reason: 'tool_calls' as const,
  });

  test('a premature no-tool finish injects one audit turn, model then verifies with tools, ends done', async () => {
    let calls = 0;
    mockChat.mockImplementation(async () => {
      calls++;
      if (calls === 1) return noToolFinish('looks done to me'); // premature victory
      if (calls === 2) return toolCall('verify'); // audit turn: model actually checks
      return noToolFinish('verified against the tests, all good'); // genuine finish
    });

    const events: Record<string, unknown>[] = [];
    const state = await run(
      initialMessages(),
      [makeTool('verify')],
      makePolicy({ completionAudit: true, onEvent: (e) => events.push(e) }),
    );

    // The audit turned a premature stop into a verified completion — not maxTurns, not error.
    expect(state.stopReason).toBe('done');
    expect(state.turns).toBe(3);
    // Exactly one audit was triggered for the task.
    expect(events.filter((e) => e.event === 'completion_audit')).toHaveLength(1);
    // The audit turn (call 2) was made WITH tools enabled, so the model could actually verify.
    expect((mockChat.mock.calls[1][1] as unknown[]).length).toBe(1);
  });

  test('the audit appends a user message telling the model to verify before finalizing', async () => {
    let calls = 0;
    mockChat.mockImplementation(async () => {
      calls++;
      if (calls === 1) return noToolFinish('done'); // premature
      return noToolFinish('ok, confirmed'); // finish after audit
    });

    const state = await run(
      initialMessages(),
      [makeTool('verify')],
      makePolicy({ completionAudit: true }),
    );

    const audit = state.messages.find(
      (m) => m.role === 'user' && typeof m.content === 'string' && m.content.includes('audit the task'),
    );
    expect(audit).toBeDefined();
  });

  test('a second no-tool answer after the audit does not trigger another audit', async () => {
    let calls = 0;
    mockChat.mockImplementation(async () => {
      calls++;
      return noToolFinish(calls === 1 ? 'done' : 'still done, no tools needed');
    });

    const events: Record<string, unknown>[] = [];
    const state = await run(
      initialMessages(),
      [makeTool('verify')],
      makePolicy({ completionAudit: true, onEvent: (e) => events.push(e) }),
    );

    // A genuinely-no-tools task still finishes — after exactly one audit turn, never a loop.
    expect(state.stopReason).toBe('done');
    expect(state.turns).toBe(2);
    expect(calls).toBe(2);
    expect(events.filter((e) => e.event === 'completion_audit')).toHaveLength(1);
  });

  test('with completionAudit off, a premature finish returns immediately (no audit)', async () => {
    let calls = 0;
    mockChat.mockImplementation(async () => {
      calls++;
      return noToolFinish('done');
    });

    const events: Record<string, unknown>[] = [];
    const state = await run(
      initialMessages(),
      [makeTool('verify')],
      makePolicy({ completionAudit: false, onEvent: (e) => events.push(e) }),
    );

    expect(state.stopReason).toBe('done');
    expect(state.turns).toBe(1);
    expect(calls).toBe(1);
    expect(events.filter((e) => e.event === 'completion_audit')).toHaveLength(0);
  });

  test('a tiny maxTurns cannot create an over-budget audit call', async () => {
    let calls = 0;
    mockChat.mockImplementation(async () => {
      calls++;
      return noToolFinish('done'); // always tries to finish with no tools
    });

    const events: Record<string, unknown>[] = [];
    // maxTurns 2: the premature finish lands on turn index 1, leaving no room for a real
    // tool-enabled audit turn, so the audit must NOT fire and no extra call is made.
    const state = await run(
      initialMessages(),
      [makeTool('verify')],
      makePolicy({ completionAudit: true, maxTurns: 2, onEvent: (e) => events.push(e) }),
    );

    expect(state.stopReason).toBe('done');
    expect(events.filter((e) => e.event === 'completion_audit')).toHaveLength(0);
    // Never more model calls than the turn budget allows.
    expect(calls).toBeLessThanOrEqual(2);
    expect(calls).toBe(1);
  });
});

describe('agent run — blocked finish', () => {
  test('a BLOCKED: finish returns stopReason blocked with no audit turn', async () => {
    mockChat.mockResolvedValueOnce({
      message: { role: 'assistant', content: 'BLOCKED: missing database credentials' },
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      finish_reason: 'stop',
    });

    // completionAudit ON to prove a block short-circuits it — there must be no second chat call.
    const state = await run(initialMessages(), [], makePolicy({ completionAudit: true }));
    expect(state.stopReason).toBe('blocked');
    expect(state.turns).toBe(1);
    expect(mockChat).toHaveBeenCalledTimes(1);
  });
});

describe('agent run — strategy checkpoint', () => {
  test('injects a checkpoint every strategyCheckpointEvery turns and does not finish on the answer', async () => {
    const toolResp = {
      message: {
        role: 'assistant' as const,
        content: '',
        tool_calls: [{ id: 'tc', type: 'function' as const, function: { name: 'my_tool', arguments: '{}' } }],
      },
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      finish_reason: 'tool_calls' as const,
    };
    // Turns 1-2: tool-calling work (so the run doesn't finish before the checkpoint fires at turn 2).
    // Turn 3 = the checkpoint answer (prose, skipped as a finish). Turn 4 = the real finish.
    mockChat
      .mockResolvedValueOnce(toolResp)
      .mockResolvedValueOnce(toolResp)
      .mockResolvedValueOnce({
        message: { role: 'assistant', content: 'Goal: X. Evidence ranked. Next: Y.' },
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        finish_reason: 'stop',
      })
      .mockResolvedValueOnce({
        message: { role: 'assistant', content: 'final answer' },
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        finish_reason: 'stop',
      });

    const events: Record<string, unknown>[] = [];
    const policy = makePolicy({
      strategyCheckpointEvery: 2,
      onEvent: (e) => events.push(e),
      contextStrategy: (m) => m, // isolate injection from compaction in this test
    });
    const state = await run(initialMessages(), [makeTool('my_tool')], policy);

    // The checkpoint answer (turn 3) did NOT end the run; the real finish (turn 4) did.
    expect(state.stopReason).toBe('done');
    expect(state.turns).toBe(4);

    const cpEvents = events.filter((e) => e.event === 'strategy_checkpoint');
    expect(cpEvents.length).toBe(1);
    expect(cpEvents[0].turn).toBe(2);

    const injected = state.messages.find(
      (m) => m.role === 'user' && String(m.content).includes(STRATEGY_CHECKPOINT_MARKER),
    );
    expect(injected).toBeDefined();
  });
});

describe('agent run — honest completion (a blank finish is not success)', () => {
  const emptyFinish = () => ({
    message: { role: 'assistant' as const, content: '' },
    usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 },
    finish_reason: 'stop' as const,
  });
  const realFinish = (content: string) => ({
    message: { role: 'assistant' as const, content },
    usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 },
    finish_reason: 'stop' as const,
  });
  const toolCall = (name: string) => ({
    message: {
      role: 'assistant' as const,
      content: '',
      tool_calls: [{ id: 'tc1', type: 'function' as const, function: { name, arguments: '{}' } }],
    },
    usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 },
    finish_reason: 'tool_calls' as const,
  });

  test('a blank finish is rejected — the loop nudges the model instead of reporting a false done', async () => {
    let calls = 0;
    mockChat.mockImplementation(async () => {
      calls++;
      return calls === 1 ? emptyFinish() : realFinish('here is the real answer');
    });

    const events: Record<string, unknown>[] = [];
    const state = await run(initialMessages(), [], makePolicy({ onEvent: (e) => events.push(e) }));

    // The empty turn did not end the run as done; the model got one nudge and recovered.
    expect(state.stopReason).toBe('done');
    expect(state.turns).toBe(2);
    // The final message is the real answer, not the blank one.
    expect(state.messages[state.messages.length - 1].content).toBe('here is the real answer');
    // A nudge was injected, and the empty response was flagged for observers.
    const nudge = state.messages.find((m) => m.role === 'user' && /empty/i.test(m.content));
    expect(nudge).toBeDefined();
    expect(events.filter((e) => e.event === 'empty_response')).toHaveLength(1);
  });

  test('a persistently blank finish ends the run as error, never a false done', async () => {
    let calls = 0;
    mockChat.mockImplementation(async () => {
      calls++;
      return emptyFinish();
    });

    const state = await run(initialMessages(), [], makePolicy());

    // One retry (maxEmptyRetries: 1), then an honest failure — not a silent 'done'.
    expect(state.stopReason).toBe('error');
    expect(state.turns).toBe(2);
    expect(calls).toBe(2);
  });

  test('a blank streak is consecutive — a productive turn between blanks resets the count', async () => {
    let calls = 0;
    mockChat.mockImplementation(async () => {
      calls++;
      if (calls === 1) return emptyFinish();       // blank #1 → nudge
      if (calls === 2) return toolCall('my_tool');  // productive turn → resets the streak
      if (calls === 3) return emptyFinish();        // blank #1 again (not #2) → nudge, not error
      return realFinish('finished for real');        // genuine finish → done
    });

    const state = await run(initialMessages(), [makeTool('my_tool')], makePolicy());

    // Without the reset, call 3 would be the 2nd consecutive blank and the run would error.
    expect(state.stopReason).toBe('done');
    expect(state.turns).toBe(4);
    expect(calls).toBe(4);
  });
});
