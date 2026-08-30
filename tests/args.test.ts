// ABOUTME: Tests for CLI arg parsing — flags --cwd, --model, --system, --verbose, --help.
// ABOUTME: Tests parseArgs exported from index.ts; no I/O, no network.

import { describe, test, expect } from 'bun:test';
import { parseArgs } from '../src/index.ts';

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
