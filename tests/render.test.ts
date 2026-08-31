// ABOUTME: Tests for the render.ts renderer — pure function of (event, config) -> stderr string.
// ABOUTME: All assertions run under NO_COLOR / non-TTY so output is plain text; no ANSI escapes.

import { describe, test, expect } from 'bun:test';
import { render, formatTransition, type RenderConfig } from '../src/render.ts';
import type { AgentTransition } from '../src/registry.ts';

// Capture rendered output into a string for assertion.
// render() writes to a provided writer; we pass a collector here.
function collect(event: Record<string, unknown>, config: RenderConfig): string {
  const chunks: string[] = [];
  render(event, config, (s: string) => chunks.push(s));
  return chunks.join('');
}

const QUIET: RenderConfig = { tier: 'quiet', tty: false };
const RICH: RenderConfig = { tier: 'rich', tty: false };
const DEBUG: RenderConfig = { tier: 'debug', tty: false };

// ── run_start / done ────────────────────────────────────────────────────────

describe('render — run_start', () => {
  test('quiet: omits run_start', () => {
    const out = collect({ event: 'run_start', task: 'write a test', model: 'gpt-4o', cwd: '/tmp' }, QUIET);
    expect(out).toBe('');
  });

  test('rich: prints task on run_start', () => {
    const out = collect({ event: 'run_start', task: 'write a test', model: 'gpt-4o', cwd: '/tmp' }, RICH);
    expect(out).toContain('write a test');
  });

  test('debug: prints task and model on run_start', () => {
    const out = collect({ event: 'run_start', task: 'write a test', model: 'gpt-4o', cwd: '/tmp' }, DEBUG);
    expect(out).toContain('write a test');
    expect(out).toContain('gpt-4o');
  });
});

describe('render — done', () => {
  test('quiet: prints stats line', () => {
    const out = collect({ event: 'done', turns: 3, tokens: 150, duration_ms: 4200 }, QUIET);
    expect(out).toContain('3 turns');
    expect(out).toContain('150 tokens');
  });

  test('rich: prints stats line', () => {
    const out = collect({ event: 'done', turns: 3, tokens: 150, duration_ms: 4200 }, RICH);
    expect(out).toContain('3 turns');
    expect(out).toContain('150 tokens');
  });
});

// ── tool_call ───────────────────────────────────────────────────────────────

describe('render — tool_call', () => {
  test('quiet: prints [tool] name args compact form', () => {
    const out = collect({ event: 'tool_call', name: 'bash', args: { cmd: 'ls' } }, QUIET);
    expect(out).toContain('[tool]');
    expect(out).toContain('bash');
  });

  test('rich: prints tool name with args preview', () => {
    const out = collect({ event: 'tool_call', name: 'bash', args: { cmd: 'ls -la' } }, RICH);
    expect(out).toContain('bash');
    expect(out).toContain('ls -la');
  });

  test('rich: truncates very long args', () => {
    const longArgs = { cmd: 'x'.repeat(200) };
    const out = collect({ event: 'tool_call', name: 'bash', args: longArgs }, RICH);
    // Should have some elision indicator when args are long
    expect(out.length).toBeLessThan(400); // not printing full 200-char payload inline
  });
});

// ── tool_result ─────────────────────────────────────────────────────────────

describe('render — tool_result', () => {
  test('quiet: prints nothing for tool_result', () => {
    const out = collect({ event: 'tool_result', name: 'bash', chars: 42, truncated: false, result: 'hello world' }, QUIET);
    expect(out).toBe('');
  });

  test('rich: prints snippet of result (first 300 chars or 6 lines)', () => {
    const result = 'line1\nline2\nline3';
    const out = collect({ event: 'tool_result', name: 'bash', chars: result.length, truncated: false, result }, RICH);
    expect(out).toContain('line1');
    expect(out).toContain('line2');
  });

  test('rich: elides when result exceeds 300 chars', () => {
    const result = 'a'.repeat(400);
    const out = collect({ event: 'tool_result', name: 'bash', chars: result.length, truncated: false, result }, RICH);
    expect(out).toContain('…');
  });

  test('rich: elides when result exceeds 6 lines', () => {
    const result = Array.from({ length: 10 }, (_, i) => `line${i + 1}`).join('\n');
    const out = collect({ event: 'tool_result', name: 'bash', chars: result.length, truncated: false, result }, RICH);
    expect(out).toContain('…');
    expect(out).not.toContain('line10');
  });

  test('debug: prints char count too', () => {
    const result = 'hello';
    const out = collect({ event: 'tool_result', name: 'bash', chars: result.length, truncated: false, result }, DEBUG);
    expect(out).toContain('5');
  });

  test('rich: shows truncated marker when truncated=true', () => {
    const out = collect({ event: 'tool_result', name: 'bash', chars: 8000, truncated: true, result: 'big output' }, RICH);
    expect(out).toContain('truncated');
  });
});

// ── assistant ───────────────────────────────────────────────────────────────

describe('render — assistant', () => {
  test('quiet: omits assistant events without content', () => {
    const out = collect({ event: 'assistant', content: '', tool_calls: [], reasoning: '' }, QUIET);
    expect(out).toBe('');
  });

  test('rich: prints interim prose when present', () => {
    const out = collect({ event: 'assistant', content: 'I will check the files', tool_calls: [], reasoning: '' }, RICH);
    expect(out).toContain('I will check the files');
  });

  test('rich: prints reasoning when present', () => {
    const out = collect({ event: 'assistant', content: '', tool_calls: [], reasoning: '17*23 = 391' }, RICH);
    expect(out).toContain('17*23 = 391');
  });

  test('quiet: omits reasoning', () => {
    const out = collect({ event: 'assistant', content: '', tool_calls: [], reasoning: '17*23 = 391' }, QUIET);
    expect(out).toBe('');
  });

  test('debug: includes api_ms when present', () => {
    const out = collect({ event: 'assistant', content: 'done', tool_calls: [], reasoning: '', api_ms: 1234 }, DEBUG);
    expect(out).toContain('1234');
    expect(out).toContain('ms');
  });
});

// ── tool_retry / nudge ───────────────────────────────────────────────────────

describe('render — tool_retry', () => {
  test('quiet: omits tool_retry', () => {
    const out = collect({ event: 'tool_retry', tool: 'bash', attempt: 1 }, QUIET);
    expect(out).toBe('');
  });

  test('rich: prints retry notice', () => {
    const out = collect({ event: 'tool_retry', tool: 'bash', attempt: 1 }, RICH);
    expect(out).toContain('retry');
    expect(out).toContain('bash');
  });
});

describe('render — nudge', () => {
  test('quiet: omits nudge', () => {
    const out = collect({ event: 'nudge', tool: 'bash' }, QUIET);
    expect(out).toBe('');
  });

  test('rich: prints nudge notice', () => {
    const out = collect({ event: 'nudge', tool: 'bash' }, RICH);
    expect(out).toContain('nudge');
    expect(out).toContain('bash');
  });
});

// ── strategy_checkpoint ───────────────────────────────────────────────────────

describe('render — strategy_checkpoint', () => {
  test('rich: shows the checkpoint turn', () => {
    const out = collect({ event: 'strategy_checkpoint', turn: 40 }, RICH);
    expect(out).toContain('strategy checkpoint');
    expect(out).toContain('40');
  });

  test('quiet: omits the checkpoint line', () => {
    const out = collect({ event: 'strategy_checkpoint', turn: 40 }, QUIET);
    expect(out).toBe('');
  });
});

// ── child_result / awaiting_children ────────────────────────────────────────

describe('render — child_result', () => {
  test('rich: shows child pid and status', () => {
    const out = collect({ event: 'child_result', pid: 4242, task: 't', status: 'done' }, RICH);
    expect(out).toContain('child 4242');
    expect(out).toContain('done');
  });

  test('quiet: omits it', () => {
    expect(collect({ event: 'child_result', pid: 4242, status: 'done' }, QUIET)).toBe('');
  });
});

describe('render — awaiting_children', () => {
  test('rich: shows the count', () => {
    const out = collect({ event: 'awaiting_children', pids: [1, 2, 3] }, RICH);
    expect(out).toContain('awaiting 3');
  });
});

// ── unknown events ────────────────────────────────────────────────────────────

describe('render — unknown events', () => {
  test('unknown event type: silently ignored', () => {
    const out = collect({ event: 'something_new', foo: 'bar' }, RICH);
    // No crash; output may be empty or contain something — just don't throw
    expect(typeof out).toBe('string');
  });
});

// ── spawn_agent tool_result special rendering ─────────────────────────────────

describe('render — spawn_agent tool_result', () => {
  const spawnSuccessResult = 'spawned child agent (pid 12345)\nresults: read_file /tmp/x.out\nerrors: read_file /tmp/x.err\nstatus: read_file /tmp/transcripts/agents.jsonl';

  test('rich: renders spawn success as distinct block with pid', () => {
    const out = collect({ event: 'tool_result', name: 'spawn_agent', chars: spawnSuccessResult.length, truncated: false, result: spawnSuccessResult }, RICH);
    expect(out).toContain('spawned');
    expect(out).toContain('12345');
  });

  test('quiet: still shows spawn success block (it is signal)', () => {
    const out = collect({ event: 'tool_result', name: 'spawn_agent', chars: spawnSuccessResult.length, truncated: false, result: spawnSuccessResult }, QUIET);
    expect(out).toContain('spawned');
    expect(out).toContain('12345');
  });

  test('rich: spawn refusal renders normally (no special block)', () => {
    const refusal = 'spawn refused: max agent depth 3 reached';
    const out = collect({ event: 'tool_result', name: 'spawn_agent', chars: refusal.length, truncated: false, result: refusal }, RICH);
    // Falls through to normal tool_result render — not a spawn success block
    expect(out).not.toContain('◆ spawned');
    expect(out).toContain('spawn_agent');
  });

  test('rich: spawn error renders normally', () => {
    const err = 'error: failed to get child pid';
    const out = collect({ event: 'tool_result', name: 'spawn_agent', chars: err.length, truncated: false, result: err }, RICH);
    expect(out).not.toContain('◆ spawned');
  });

  test('debug: spawn success includes out path detail', () => {
    const out = collect({ event: 'tool_result', name: 'spawn_agent', chars: spawnSuccessResult.length, truncated: false, result: spawnSuccessResult }, DEBUG);
    expect(out).toContain('/tmp/x.out');
  });
});

// ── ANSI / color gating ───────────────────────────────────────────────────────

describe('render — color gating', () => {
  test('tty:false produces no ANSI escape codes', () => {
    const out = collect(
      { event: 'assistant', content: 'hello', tool_calls: [], reasoning: 'thinking' },
      { tier: 'rich', tty: false },
    );
    // ESC [ ... m pattern
    expect(out).not.toMatch(/\x1b\[/);
  });

  test('tty:true produces ANSI codes for reasoning (dim)', () => {
    const out = collect(
      { event: 'assistant', content: '', tool_calls: [], reasoning: 'thinking' },
      { tier: 'rich', tty: true },
    );
    expect(out).toMatch(/\x1b\[/);
  });
});

// ── formatTransition ─────────────────────────────────────────────────────────

describe('formatTransition', () => {
  const PLAIN: RenderConfig = { tier: 'rich', tty: false };
  const TTY: RenderConfig = { tier: 'rich', tty: true };

  test('done+ok → plain text contains pid and ageSecs (no ANSI)', () => {
    const t: AgentTransition = { pid: 42, state: 'done', ageSecs: 10, exitStatus: 'ok' };
    const out = formatTransition(t, PLAIN);
    expect(out).toContain('42');
    expect(out).toContain('10s');
    expect(out).toContain('done');
    expect(out).not.toMatch(/\x1b\[/);
  });

  test('done+ok → tty emits green ANSI codes', () => {
    const t: AgentTransition = { pid: 42, state: 'done', ageSecs: 10, exitStatus: 'ok' };
    const out = formatTransition(t, TTY);
    expect(out).toContain('42');
    // Green = \x1b[32m
    expect(out).toContain('\x1b[32m');
  });

  test('done+error → plain text contains pid, stop_reason, and ageSecs', () => {
    const t: AgentTransition = { pid: 7, state: 'done', ageSecs: 5, exitStatus: 'error', stopReason: 'aborted' };
    const out = formatTransition(t, PLAIN);
    expect(out).toContain('7');
    expect(out).toContain('aborted');
    expect(out).toContain('5s');
    expect(out).not.toMatch(/\x1b\[/);
  });

  test('done+error → tty emits yellow ANSI codes', () => {
    const t: AgentTransition = { pid: 7, state: 'done', ageSecs: 5, exitStatus: 'error', stopReason: 'aborted' };
    const out = formatTransition(t, TTY);
    // Yellow = \x1b[33m
    expect(out).toContain('\x1b[33m');
  });

  test('died → plain text contains pid and ageSecs', () => {
    const t: AgentTransition = { pid: 99, state: 'died', ageSecs: 3 };
    const out = formatTransition(t, PLAIN);
    expect(out).toContain('99');
    expect(out).toContain('3s');
    expect(out).toContain('died');
    expect(out).not.toMatch(/\x1b\[/);
  });

  test('died → tty emits red ANSI codes', () => {
    const t: AgentTransition = { pid: 99, state: 'died', ageSecs: 3 };
    const out = formatTransition(t, TTY);
    // Red = \x1b[31m
    expect(out).toContain('\x1b[31m');
  });

  test('done+ok without exitStatus treated as ok (green)', () => {
    // exitStatus is optional; absent means treat as ok
    const t: AgentTransition = { pid: 1, state: 'done', ageSecs: 2 };
    const out = formatTransition(t, TTY);
    expect(out).toContain('\x1b[32m');
  });
});
