// ABOUTME: Tests for new parseArgs flags — --quiet and --debug (mutually exclusive).
// ABOUTME: Also covers stdout purity in one-shot mode via subprocess.

import { describe, test, expect } from 'bun:test';
import { parseArgs } from '../src/index.ts';

function args(...rest: string[]): string[] {
  return ['bun', 'src/index.ts', ...rest];
}

describe('parseArgs — --quiet flag', () => {
  test('--quiet sets tier to quiet', () => {
    const result = parseArgs(args('--quiet', 'do the thing'));
    expect(result.tier).toBe('quiet');
    expect(result.task).toBe('do the thing');
  });

  test('no tier flag: tier is rich (default)', () => {
    const result = parseArgs(args('do the thing'));
    expect(result.tier).toBe('rich');
  });
});

describe('parseArgs — --debug flag', () => {
  test('--debug sets tier to debug', () => {
    const result = parseArgs(args('--debug', 'do the thing'));
    expect(result.tier).toBe('debug');
    expect(result.task).toBe('do the thing');
  });
});

describe('parseArgs — mutual exclusion', () => {
  test('--quiet and --debug together sets unknownFlag error', () => {
    const result = parseArgs(args('--quiet', '--debug', 'task'));
    expect(result.unknownFlag).toMatch(/quiet.*debug|debug.*quiet/i);
  });

  test('--debug and --quiet together sets unknownFlag error (order reversed)', () => {
    const result = parseArgs(args('--debug', '--quiet', 'task'));
    expect(result.unknownFlag).toMatch(/quiet.*debug|debug.*quiet/i);
  });
});

describe('parseArgs — --verbose backward compatibility', () => {
  test('--verbose is now an unknown flag (replaced by --debug)', () => {
    const result = parseArgs(args('--verbose'));
    expect(result.unknownFlag).toBe('--verbose');
  });
});

describe('stdout purity — one-shot mode', () => {
  // This test spawns a real subprocess against the real gateway — it is slow
  // but it's the only way to assert stdout isolation end-to-end.
  // We use a task that produces a short, predictable answer.
  test('stdout contains only prose, no progress markers', async () => {
    const indexPath = new URL('../src/index.ts', import.meta.url).pathname;
    const repoRoot = new URL('..', import.meta.url).pathname.replace(/\/$/, '');

    const proc = Bun.spawn(
      ['bun', indexPath, '--quiet', '--max-turns', '1', 'say exactly: PURITY_OK'],
      {
        cwd: repoRoot,
        env: { ...process.env },
        stdout: 'pipe',
        stderr: 'pipe',
      },
    );

    const [stdoutBuf, stderrBuf] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);

    await proc.exited;

    // stdout must not contain any progress markers
    expect(stdoutBuf).not.toMatch(/\[tool\]/);
    expect(stdoutBuf).not.toMatch(/\[reasoning\]/);
    expect(stdoutBuf).not.toMatch(/run_start/);

    // stderr should have something (stats line at minimum)
    expect(stderrBuf.length).toBeGreaterThan(0);
  });
});
