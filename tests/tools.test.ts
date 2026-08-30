// ABOUTME: Tests for the tool registry — finding tools by name, and read/write handlers with temp files.
// ABOUTME: Uses real Bun file I/O; no mocks for the actual file operations.

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { tools } from '../src/tools.ts';
import { join } from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';

function findTool(name: string) {
  return tools.find((t) => t.definition.function.name === name);
}

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'ba-tools-test-'));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe('tool registry', () => {
  test('exports an array with at least 3 tools', () => {
    expect(Array.isArray(tools)).toBe(true);
    expect(tools.length).toBeGreaterThanOrEqual(3);
  });

  test('has read_file tool', () => {
    expect(findTool('read_file')).toBeDefined();
  });

  test('has write_file tool', () => {
    expect(findTool('write_file')).toBeDefined();
  });

  test('has bash tool', () => {
    expect(findTool('bash')).toBeDefined();
  });

  test('each tool has definition and handler', () => {
    for (const tool of tools) {
      expect(tool.definition).toBeDefined();
      expect(typeof tool.handler).toBe('function');
      expect(tool.definition.type).toBe('function');
      expect(tool.definition.function.name).toBeTruthy();
    }
  });
});

describe('write_file handler', () => {
  test('writes content and confirms', async () => {
    const filePath = join(tmpDir, 'hello.txt');
    const tool = findTool('write_file')!;
    const result = await tool.handler({ path: filePath, content: 'hello world' });
    expect(result).toContain('wrote');
    expect(result).toContain(filePath);
  });

  test('written content is readable', async () => {
    const filePath = join(tmpDir, 'content.txt');
    const writeTool = findTool('write_file')!;
    const readTool = findTool('read_file')!;
    await writeTool.handler({ path: filePath, content: 'my content' });
    const result = await readTool.handler({ path: filePath });
    expect(result).toBe('my content');
  });
});

describe('read_file handler', () => {
  test('returns file contents', async () => {
    const filePath = join(tmpDir, 'test.txt');
    await Bun.write(filePath, 'some text here');
    const tool = findTool('read_file')!;
    const result = await tool.handler({ path: filePath });
    expect(result).toBe('some text here');
  });

  test('returns error string for missing file', async () => {
    const tool = findTool('read_file')!;
    const result = await tool.handler({ path: join(tmpDir, 'nonexistent.txt') });
    expect(result).toMatch(/error/i);
  });
});

describe('bash handler', () => {
  test('captures stdout', async () => {
    const tool = findTool('bash')!;
    const result = await tool.handler({ cmd: 'echo hello' });
    expect(result).toContain('hello');
    expect(result).toContain('exit: 0');
  });

  test('captures exit code on failure', async () => {
    const tool = findTool('bash')!;
    const result = await tool.handler({ cmd: 'exit 42' });
    expect(result).toContain('exit: 42');
  });

  test('output format includes stdout/stderr/exit labels', async () => {
    const tool = findTool('bash')!;
    const result = await tool.handler({ cmd: 'echo out; echo err >&2' });
    expect(result).toContain('stdout:');
    expect(result).toContain('stderr:');
    expect(result).toContain('exit:');
  });

  test('truncates very long output at the TAIL (last 8000 chars)', async () => {
    const tool = findTool('bash')!;
    // 20000 A's followed by 20000 Z's — total 40000 chars, well over 8000 cap.
    // The tail-8000 window will land entirely in the Z's section.
    const result = await tool.handler({
      cmd: "python3 -c \"print('A' * 20000 + 'Z' * 20000, end='')\"",
    });
    // Should show truncation marker
    expect(result).toContain('truncated');
    // Tail preserved: output ends with Z's (the last chars of the stream)
    expect(result.slice(-100)).toMatch(/Z+/);
    // Head (all A's) is gone — only the tail survives; 'AAAA' won't appear
    expect(result).not.toContain('AAAA');
  });

  test('timeout kills hung process and returns timeout message', async () => {
    const tool = findTool('bash')!;
    // Use a very short timeout to avoid slowing tests — 200ms
    const result = await tool.handler({ cmd: 'sleep 10', timeout_ms: 200 });
    expect(result).toMatch(/timed out/i);
    expect(result).toContain('200');
  });

  test('partial output on timeout is still capped', async () => {
    const tool = findTool('bash')!;
    // Flood stdout beyond the 8000-char cap, then hang until killed
    const result = await tool.handler({
      cmd: 'head -c 20000 /dev/zero | tr "\\0" "x"; sleep 10',
      timeout_ms: 500,
    });
    expect(result).toMatch(/timed out/i);
    expect(result.length).toBeLessThan(9000);
  });
});

