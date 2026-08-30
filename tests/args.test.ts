// ABOUTME: Tests for CLI arg parsing — flags --cwd, --model, --system, --verbose, --help.
// ABOUTME: Tests parseArgs exported from index.ts; no I/O, no network.

import { describe, test, expect } from 'bun:test';
import { parseArgs, loadSystemPrompt, isEmbedded } from '../src/index.ts';
import { writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// parseArgs receives process.argv-style array: ['bun', 'src/index.ts', ...rest]
function args(...rest: string[]): string[] {
  return ['bun', 'src/index.ts', ...rest];
}

describe('parseArgs — basic flags', () => {
  test('no args: task is null, defaults apply', () => {
    const result = parseArgs(args());
    expect(result.task).toBeNull();
    expect(result.verbose).toBe(false);
  });

  test('positional arg becomes task', () => {
    const result = parseArgs(args('hello world task'));
    expect(result.task).toBe('hello world task');
  });

  test('--verbose sets verbose', () => {
    const result = parseArgs(args('--verbose', 'do the thing'));
    expect(result.verbose).toBe(true);
    expect(result.task).toBe('do the thing');
  });

  test('--system sets systemPath', () => {
    const result = parseArgs(args('--system', '/tmp/my-system.txt'));
    expect(result.systemPath).toBe('/tmp/my-system.txt');
  });
});

describe('parseArgs — --model flag', () => {
  test('--model sets model', () => {
    const result = parseArgs(args('--model', 'gpt-4o-mini', 'my task'));
    expect(result.model).toBe('gpt-4o-mini');
    expect(result.task).toBe('my task');
  });

  test('no --model: model is null', () => {
    const result = parseArgs(args('my task'));
    expect(result.model).toBeNull();
  });
});

describe('parseArgs — --cwd flag', () => {
  test('--cwd sets cwd', () => {
    const result = parseArgs(args('--cwd', '/tmp/mydir', 'task'));
    expect(result.cwd).toBe('/tmp/mydir');
    expect(result.task).toBe('task');
  });

  test('no --cwd: cwd is null', () => {
    const result = parseArgs(args('task'));
    expect(result.cwd).toBeNull();
  });
});

describe('parseArgs — --help and unknown flags', () => {
  test('--help sets help=true', () => {
    const result = parseArgs(args('--help'));
    expect(result.help).toBe(true);
  });

  test('unknown flag sets unknownFlag', () => {
    const result = parseArgs(args('--blorp'));
    expect(result.unknownFlag).toBe('--blorp');
  });
});

describe('parseArgs — --max-turns', () => {
  test('parses a valid integer', () => {
    const result = parseArgs(args('--max-turns', '7', 'task'));
    expect(result.maxTurns).toBe(7);
    expect(result.task).toBe('task');
  });

  test('defaults to null when flag absent', () => {
    const result = parseArgs(args('task'));
    expect(result.maxTurns).toBeNull();
  });

  test('rejects non-integer values as unknownFlag', () => {
    const result = parseArgs(args('--max-turns', 'abc'));
    expect(result.maxTurns).toBeNull();
    expect(result.unknownFlag).toMatch(/max-turns/);
  });

  test('rejects zero and negatives as unknownFlag', () => {
    expect(parseArgs(args('--max-turns', '0')).unknownFlag).toMatch(/max-turns/);
    expect(parseArgs(args('--max-turns', '-3')).unknownFlag).toMatch(/max-turns/);
  });
});

describe('loadSystemPrompt', () => {
  test('returns file content when the file exists', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ba-lsp-'));
    const p = join(dir, 'sys.txt');
    writeFileSync(p, 'hello system');
    try {
      const result = loadSystemPrompt(p, false);
      expect(result).toBe('hello system');
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  test('isDefault=true + missing file returns fallback string', () => {
    const result = loadSystemPrompt('/nonexistent/path/sys.txt', true);
    expect(result).toBeTruthy();
    expect(typeof result).toBe('string');
    expect(result.length).toBeGreaterThan(0);
  });

  test('isDefault=false + missing file exits with code 1', () => {
    const indexPath = new URL('../src/index.ts', import.meta.url).pathname;
    const result = Bun.spawnSync(
      ['bun', indexPath, '--system', '/nonexistent/path/sys.txt', 'dummy task'],
      { env: { ...process.env, BREAK_AWAY_TRANSCRIPT_DIR: '/tmp' } },
    );
    expect(result.exitCode).toBe(1);
    expect(new TextDecoder().decode(result.stderr)).toContain('/nonexistent/path/sys.txt');
  });
});

describe('isEmbedded', () => {
  test('returns false when running from source', () => {
    // In bun test, import.meta.dir is a real filesystem path
    expect(isEmbedded()).toBe(false);
  });
});
