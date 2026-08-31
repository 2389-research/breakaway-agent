// ABOUTME: Tests for new agent event shapes — reasoning, api_ms, tool_retry, nudge.
// ABOUTME: Uses the same fake-client injection pattern as agent.test.ts.

import { describe, test, expect, mock, beforeEach } from 'bun:test';
import type { Message, Tool, Policy } from '../src/types.ts';
import { defaultPolicy } from '../src/policy.ts';

// Mock client before importing agent (same pattern as agent.test.ts)
const mockChat = mock(async () => ({
  message: { role: 'assistant' as const, content: 'done' },
  usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
  finish_reason: 'stop',
}));

mock.module('../src/client.ts', () => ({ chat: mockChat }));

const { run } = await import('../src/agent.ts');

function makeTool(name: string, handler: (args: Record<string, unknown>) => Promise<string> = async () => 'ok'): Tool {
  return {
    definition: {
      type: 'function',
      function: { name, description: `Tool ${name}`, parameters: { type: 'object', properties: {}, required: [] } },
    },
    handler,
  };
}

function makePolicy(overrides: Partial<Policy> = {}): Policy {
  // These event-shape tests script an exact number of responses; isolate them from the completion
  // audit (on in the real default policy) so it doesn't request an extra, unscripted turn.
  return { ...defaultPolicy, completionAudit: false, ...overrides };
}

function initialMessages(): Message[] {
  return [
    { role: 'system', content: 'you are an agent' },
    { role: 'user', content: 'do something' },
  ];
}

beforeEach(() => {
  mockChat.mockReset();
});

describe('agent events — reasoning field', () => {
  test('assistant event includes reasoning from response when present', async () => {
    // The real client surfaces reasoning at the top level (not on message).
    mockChat.mockResolvedValueOnce({
      message: { role: 'assistant' as const, content: 'answer' },
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      finish_reason: 'stop',
      reasoning: '17*23 = 391',
    });

    const events: Record<string, unknown>[] = [];
    await run(initialMessages(), [], makePolicy({ onEvent: (e) => events.push(e) }));

    const assistantEv = events.find((e) => e.event === 'assistant');
    expect(assistantEv).toBeDefined();
    expect(assistantEv!.reasoning).toBe('17*23 = 391');
  });

  test('assistant event has reasoning as empty string when absent', async () => {
    mockChat.mockResolvedValueOnce({
      message: { role: 'assistant' as const, content: 'answer' },
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      finish_reason: 'stop',
      reasoning: '',
    });

    const events: Record<string, unknown>[] = [];
    await run(initialMessages(), [], makePolicy({ onEvent: (e) => events.push(e) }));

    const assistantEv = events.find((e) => e.event === 'assistant');
    expect(assistantEv!.reasoning).toBe('');
  });

  test('reasoning is NOT included in subsequent messages sent back to the API', async () => {
    // Turn 1: tool call, with reasoning at top level (not on message)
    mockChat.mockResolvedValueOnce({
      message: {
        role: 'assistant' as const,
        content: '',
        tool_calls: [{ id: 'tc1', type: 'function', function: { name: 'my_tool', arguments: '{}' } }],
      },
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      finish_reason: 'tool_calls',
      reasoning: 'I should call the tool',
    });
    // Turn 2: done
    mockChat.mockResolvedValueOnce({
      message: { role: 'assistant' as const, content: 'done' },
      usage: { prompt_tokens: 15, completion_tokens: 5, total_tokens: 20 },
      finish_reason: 'stop',
    });

    await run(initialMessages(), [makeTool('my_tool')], makePolicy());

    // The second call's messages should NOT contain reasoning
    expect(mockChat.mock.calls.length).toBe(2);
    const secondCallMessages = mockChat.mock.calls[1][0] as Message[];
    for (const msg of secondCallMessages) {
      expect((msg as Record<string, unknown>).reasoning).toBeUndefined();
    }
  });
});

describe('agent events — api_ms', () => {
  test('assistant event includes api_ms (positive integer)', async () => {
    mockChat.mockResolvedValueOnce({
      message: { role: 'assistant' as const, content: 'done' },
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      finish_reason: 'stop',
    });

    const events: Record<string, unknown>[] = [];
    await run(initialMessages(), [], makePolicy({ onEvent: (e) => events.push(e) }));

    const assistantEv = events.find((e) => e.event === 'assistant');
    expect(typeof assistantEv!.api_ms).toBe('number');
    expect(assistantEv!.api_ms as number).toBeGreaterThanOrEqual(0);
  });
});

describe('agent events — tool_result includes result text', () => {
  test('tool_result event includes result field', async () => {
    mockChat.mockResolvedValueOnce({
      message: {
        role: 'assistant' as const,
        content: '',
        tool_calls: [{ id: 'tc1', type: 'function', function: { name: 'my_tool', arguments: '{}' } }],
      },
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      finish_reason: 'tool_calls',
    });
    mockChat.mockResolvedValueOnce({
      message: { role: 'assistant' as const, content: 'done' },
      usage: { prompt_tokens: 15, completion_tokens: 5, total_tokens: 20 },
      finish_reason: 'stop',
    });

    const events: Record<string, unknown>[] = [];
    await run(
      initialMessages(),
      [makeTool('my_tool', async () => 'the actual output text')],
      makePolicy({ onEvent: (e) => events.push(e) }),
    );

    const toolResultEv = events.find((e) => e.event === 'tool_result');
    expect(toolResultEv).toBeDefined();
    expect(toolResultEv!.result).toBe('the actual output text');
  });
});

describe('agent events — tool_retry', () => {
  test('emits tool_retry event on retry path', async () => {
    mockChat.mockResolvedValueOnce({
      message: {
        role: 'assistant' as const,
        content: '',
        tool_calls: [{ id: 'tc1', type: 'function', function: { name: 'flaky', arguments: '{}' } }],
      },
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      finish_reason: 'tool_calls',
    });
    mockChat.mockResolvedValueOnce({
      message: { role: 'assistant' as const, content: 'done' },
      usage: { prompt_tokens: 15, completion_tokens: 5, total_tokens: 20 },
      finish_reason: 'stop',
    });

    let call = 0;
    const flakyTool = makeTool('flaky', async () => {
      if (++call === 1) throw new Error('first fails');
      return 'retry ok';
    });

    const events: Record<string, unknown>[] = [];
    await run(initialMessages(), [flakyTool], makePolicy({ onToolError: 'retry', onEvent: (e) => events.push(e) }));

    const retryEv = events.find((e) => e.event === 'tool_retry');
    expect(retryEv).toBeDefined();
    expect(retryEv!.tool).toBe('flaky');
    expect(typeof retryEv!.attempt).toBe('number');
  });
});

describe('agent events — nudge', () => {
  test('emits nudge event on nudge path', async () => {
    mockChat.mockResolvedValueOnce({
      message: {
        role: 'assistant' as const,
        content: '',
        tool_calls: [{ id: 'tc1', type: 'function', function: { name: 'bad_tool', arguments: '{}' } }],
      },
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      finish_reason: 'tool_calls',
    });
    mockChat.mockResolvedValueOnce({
      message: { role: 'assistant' as const, content: 'recovered' },
      usage: { prompt_tokens: 15, completion_tokens: 5, total_tokens: 20 },
      finish_reason: 'stop',
    });

    const errorTool = makeTool('bad_tool', async () => { throw new Error('oops'); });

    const events: Record<string, unknown>[] = [];
    await run(
      initialMessages(),
      [errorTool],
      makePolicy({ onToolError: 'nudge', onEvent: (e) => events.push(e) }),
    );

    const nudgeEv = events.find((e) => e.event === 'nudge');
    expect(nudgeEv).toBeDefined();
    expect(nudgeEv!.tool).toBe('bad_tool');
  });
});
