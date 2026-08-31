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
const { run } = await import('../src/agent.ts');

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
  return { ...defaultPolicy, ...overrides };
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

  test('reserves the final turn for synthesis: strips tools and returns a prose answer', async () => {
    // Model keeps calling tools while any are offered, but produces prose when tools are stripped.
    mockChat.mockImplementation(async (_messages: Message[], toolDefs: unknown[]) => {
      if (toolDefs.length === 0) {
        return {
          message: { role: 'assistant' as const, content: 'best synthesis given the evidence so far' },
          usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 },
          finish_reason: 'stop',
        };
      }
      return {
        message: {
          role: 'assistant' as const,
          content: '',
          tool_calls: [{ id: 'tc1', type: 'function', function: { name: 'my_tool', arguments: '{}' } }],
        },
        usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 },
        finish_reason: 'tool_calls',
      };
    });

    const state = await run(initialMessages(), [makeTool('my_tool')], makePolicy({ maxTurns: 3 }));

    // Hitting the cap is still an incomplete outcome...
    expect(state.stopReason).toBe('maxTurns');
    // ...but the final message now carries a usable answer instead of an empty tool-call turn.
    const last = state.messages[state.messages.length - 1];
    expect(last.role).toBe('assistant');
    expect(last.content).toBe('best synthesis given the evidence so far');

    // The final API call was made with tools disabled; earlier calls had the tool available.
    const calls = mockChat.mock.calls;
    expect((calls[0][1] as unknown[]).length).toBe(1);
    expect((calls[calls.length - 1][1] as unknown[]).length).toBe(0);
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
