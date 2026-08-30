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
