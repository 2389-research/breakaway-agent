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
