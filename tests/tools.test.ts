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

  test('timeout kills the whole process group, not just the bash process', async () => {
    const tool = findTool('bash')!;
    const pidFile = join(tmpDir, 'child.pid');
    // Fork a child that would outlive bash, record its pid, then hang until killed.
    // This is the orphaned-nmap scenario: killing only bash leaves the child running.
    const result = await tool.handler({
      cmd: `sleep 30 & echo $! > '${pidFile}'; sleep 30`,
      timeout_ms: 400,
    });
    expect(result).toMatch(/timed out/i);

    await Bun.sleep(300); // let the group kill propagate
    const childPid = parseInt((await Bun.file(pidFile).text()).trim(), 10);
    expect(childPid).toBeGreaterThan(0);

    let alive = false;
    try {
      process.kill(childPid, 0);
      alive = true;
    } catch {
      // ESRCH — child is gone, which is what we want
    }
    if (alive) {
      try { process.kill(childPid, 9); } catch { /* cleanup */ } // don't leak a real process
    }
    expect(alive).toBe(false);
  });
});

describe('edit_file handler', () => {
  test('has edit_file tool', () => {
    expect(findTool('edit_file')).toBeDefined();
  });

  test('one exact match changes only that occurrence', async () => {
    const filePath = join(tmpDir, 'edit.txt');
    await Bun.write(filePath, 'alpha\nbeta\ngamma\n');
    const result = await findTool('edit_file')!.handler({ path: filePath, old_text: 'beta', new_text: 'BETA' });
    expect(result).toMatch(/replaced 1/i);
    expect(result).toMatch(/lines 2-2/);
    expect(await Bun.file(filePath).text()).toBe('alpha\nBETA\ngamma\n');
  });

  test('zero matches returns an actionable error and leaves the file unchanged', async () => {
    const filePath = join(tmpDir, 'edit.txt');
    await Bun.write(filePath, 'alpha\nbeta\n');
    const result = await findTool('edit_file')!.handler({ path: filePath, old_text: 'zeta', new_text: 'X' });
    expect(result).toMatch(/error/i);
    expect(result).toMatch(/no match|not found/i);
    expect(await Bun.file(filePath).text()).toBe('alpha\nbeta\n');
  });

  test('multiple matches returns an ambiguity error and leaves the file unchanged', async () => {
    const filePath = join(tmpDir, 'edit.txt');
    await Bun.write(filePath, 'x\nx\nx\n');
    const result = await findTool('edit_file')!.handler({ path: filePath, old_text: 'x', new_text: 'y' });
    expect(result).toMatch(/error/i);
    expect(result).toMatch(/3 match|ambiguous/i);
    expect(await Bun.file(filePath).text()).toBe('x\nx\nx\n');
  });

  test('replacement works with multiline text', async () => {
    const filePath = join(tmpDir, 'edit.txt');
    await Bun.write(filePath, 'a\nOLD1\nOLD2\nb\n');
    await findTool('edit_file')!.handler({ path: filePath, old_text: 'OLD1\nOLD2', new_text: 'NEW' });
    expect(await Bun.file(filePath).text()).toBe('a\nNEW\nb\n');
  });

  test('preserves unrelated content byte-for-byte and treats $-sequences in new_text literally', async () => {
    const filePath = join(tmpDir, 'edit.txt');
    // The `$1` in unrelated content and the `$&`/`$1` in new_text must survive verbatim —
    // this is why the replace is done by index, not String.prototype.replace.
    await Bun.write(filePath, 'keep $1 this\ntarget\nkeep {braces} too\n');
    await findTool('edit_file')!.handler({ path: filePath, old_text: 'target', new_text: '$& and $1' });
    expect(await Bun.file(filePath).text()).toBe('keep $1 this\n$& and $1\nkeep {braces} too\n');
  });

  test('deletes text when new_text is empty', async () => {
    const filePath = join(tmpDir, 'edit.txt');
    await Bun.write(filePath, 'aXb');
    const result = await findTool('edit_file')!.handler({ path: filePath, old_text: 'X', new_text: '' });
    expect(result).toMatch(/replaced 1/i);
    expect(await Bun.file(filePath).text()).toBe('ab');
  });

  test('rejects missing/empty args before touching the file', async () => {
    const filePath = join(tmpDir, 'edit.txt');
    expect(await findTool('edit_file')!.handler({ old_text: 'a', new_text: 'b' })).toContain('missing required field: path');
    expect(await findTool('edit_file')!.handler({ path: filePath, new_text: 'b' })).toContain('missing required field: old_text');
    expect(await findTool('edit_file')!.handler({ path: filePath, old_text: '', new_text: 'b' })).toContain('missing required field: old_text');
    expect(await findTool('edit_file')!.handler({ path: filePath, old_text: 'a' })).toContain('missing required field: new_text');
  });
});

describe('tool argument validation', () => {
  test('bash rejects the wrong argument key without executing', async () => {
    const tool = findTool('bash')!;
    // Model sent {command} instead of {cmd} — must not execute `undefined`.
    const result = await tool.handler({ command: 'echo LEAK' });
    expect(result).toContain('missing required field: cmd');
    expect(result).not.toContain('exit:'); // never reached the shell
    expect(result).not.toContain('LEAK');
  });

  test('bash rejects a missing cmd', async () => {
    const result = await findTool('bash')!.handler({});
    expect(result).toContain('missing required field: cmd');
  });

  test('bash rejects a non-string cmd', async () => {
    const result = await findTool('bash')!.handler({ cmd: 123 });
    expect(result).toContain('missing required field: cmd');
  });

  test('read_file rejects a missing path', async () => {
    const result = await findTool('read_file')!.handler({});
    expect(result).toContain('missing required field: path');
  });

  test('write_file rejects a missing content', async () => {
    const result = await findTool('write_file')!.handler({ path: join(tmpDir, 'x.txt') });
    expect(result).toContain('missing required field: content');
  });

  test('spawn_agent rejects a missing task without spawning', async () => {
    const result = await findTool('spawn_agent')!.handler({});
    expect(result).toContain('missing required field: task');
  });
});

