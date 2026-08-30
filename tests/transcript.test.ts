// ABOUTME: Tests for per-run JSONL transcript writer.
// ABOUTME: Verifies file creation, valid JSON lines, and best-effort failure handling.

import { describe, test, expect, beforeEach, afterEach, mock } from 'bun:test';
import { mkdtempSync, rmSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { openTranscript, writeEvent, closeTranscript } from '../src/transcript.ts';

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'ba-transcript-test-'));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe('transcript writer', () => {
  test('creates a JSONL file in the given dir', async () => {
    const handle = await openTranscript(tmpDir);
    await writeEvent(handle, { event: 'run_start', task: 'test', model: 'test-model', cwd: '/tmp' });
    await closeTranscript(handle);

    const { readdirSync } = await import('node:fs');
    const files = readdirSync(tmpDir);
    expect(files.length).toBe(1);
    expect(files[0]).toMatch(/^run-.*\.jsonl$/);
  });

  test('each written event is a valid JSON line', async () => {
    const handle = await openTranscript(tmpDir);
    await writeEvent(handle, { event: 'run_start', task: 'hello', model: 'm1', cwd: '/x' });
    await writeEvent(handle, { event: 'done', turns: 2, tokens: 50, duration_ms: 1234 });
    await closeTranscript(handle);

    const { readdirSync } = await import('node:fs');
    const file = join(tmpDir, readdirSync(tmpDir)[0]);
    const lines = readFileSync(file, 'utf8').trim().split('\n');
    expect(lines.length).toBe(2);
    for (const line of lines) {
      const obj = JSON.parse(line); // throws if invalid
      expect(obj.ts).toBeDefined();
      expect(obj.event).toBeDefined();
    }
  });

  test('failures to write do not throw — returns null handle on bad dir', async () => {
    // Non-existent dir that can't be created (file at path, not dir)
    await Bun.write(join(tmpDir, 'notadir'), 'x');
    const handle = await openTranscript(join(tmpDir, 'notadir', 'subdir'));
    // Should return some handle or null — either way no exception
    // writeEvent should be a no-op on null handle
    await writeEvent(handle, { event: 'run_start', task: '', model: '', cwd: '' });
    await closeTranscript(handle);
    // reaching here without throwing is the assertion
    expect(true).toBe(true);
  });

  test('tool_call and tool_result events written via onEvent appear as valid JSON lines', async () => {
    const handle = await openTranscript(tmpDir);

    // Simulate the events that agent.ts emits
    await writeEvent(handle, { event: 'run_start', task: 'test', model: 'test-model', cwd: '/tmp' });
    await writeEvent(handle, { event: 'assistant', content: 'calling tool', tool_calls: [{ name: 'my_tool', args_chars: 7 }] });
    await writeEvent(handle, { event: 'tool_call', name: 'my_tool', args: { x: 1 } });
    await writeEvent(handle, { event: 'tool_result', name: 'my_tool', chars: 11, truncated: false });
    await writeEvent(handle, { event: 'done', turns: 1, tokens: 15, duration_ms: 100 });
    await closeTranscript(handle);

    const file = join(tmpDir, readdirSync(tmpDir)[0]);
    const lines = readFileSync(file, 'utf8').trim().split('\n');

    // All 5 lines must parse as JSON with ts + event
    expect(lines.length).toBe(5);
    const parsed = lines.map((l) => JSON.parse(l));
    for (const obj of parsed) {
      expect(obj.ts).toBeDefined();
      expect(obj.event).toBeDefined();
    }

    // Check specific event types present
    const eventTypes = parsed.map((o: { event: string }) => o.event);
    expect(eventTypes).toContain('tool_call');
    expect(eventTypes).toContain('tool_result');

    // tool_call line has name and args
    const tcLine = parsed.find((o: { event: string }) => o.event === 'tool_call');
    expect(tcLine.name).toBe('my_tool');
    expect(tcLine.args).toEqual({ x: 1 });

    // tool_result line has name, chars, truncated
    const trLine = parsed.find((o: { event: string }) => o.event === 'tool_result');
    expect(trLine.name).toBe('my_tool');
    expect(trLine.chars).toBe(11);
    expect(trLine.truncated).toBe(false);
  });
});
