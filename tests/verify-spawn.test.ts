// ABOUTME: Unit tests for the verifySpawn seam in tools.ts.
// ABOUTME: Uses real pids — dead from Bun.spawn(['true']), live from process.pid.

import { describe, test, expect, afterEach } from 'bun:test';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { verifySpawn } from '../src/tools.ts';

let tmpDir: string;

afterEach(() => {
  if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
});

describe('verifySpawn', () => {
  test('live pid returns ok:true', async () => {
    // process.pid is definitely alive
    const result = await verifySpawn(process.pid, '/nonexistent/err.txt', 50);
    expect(result.ok).toBe(true);
  });

  test('dead pid with readable errFile returns ok:false with errHead', async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'ba-verify-spawn-'));
    const errFile = join(tmpDir, 'err.txt');
    writeFileSync(errFile, 'boom: something went wrong\nsecond line\n');

    const proc = Bun.spawn(['true'], { stdout: 'ignore', stderr: 'ignore' });
    await proc.exited;
    const deadPid = proc.pid;

    const result = await verifySpawn(deadPid, errFile, 50);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errHead).toContain('boom');
    }
  });

  test('dead pid with unreadable errFile returns ok:false with empty errHead', async () => {
    const proc = Bun.spawn(['true'], { stdout: 'ignore', stderr: 'ignore' });
    await proc.exited;
    const deadPid = proc.pid;

    const result = await verifySpawn(deadPid, '/nonexistent/no-such-file.txt', 50);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errHead).toBe('');
    }
  });

  test('errHead is capped at 500 chars or 8 lines', async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'ba-verify-spawn-'));
    const errFile = join(tmpDir, 'err.txt');
    // Write 20 lines of content
    const content = Array.from({ length: 20 }, (_, i) => `line ${i + 1}`).join('\n') + '\n';
    writeFileSync(errFile, content);

    const proc = Bun.spawn(['true'], { stdout: 'ignore', stderr: 'ignore' });
    await proc.exited;
    const deadPid = proc.pid;

    const result = await verifySpawn(deadPid, errFile, 50);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      const lines = result.errHead.split('\n').filter((l) => l.length > 0);
      expect(lines.length).toBeLessThanOrEqual(8);
      expect(result.errHead.length).toBeLessThanOrEqual(500);
    }
  });
});
