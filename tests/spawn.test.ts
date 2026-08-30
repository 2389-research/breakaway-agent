// ABOUTME: Unit tests for buildSpawnArgs — depth guard, file paths, command shape.
// ABOUTME: No network, no real spawning.

import { describe, test, expect } from 'bun:test';
import { buildSpawnArgs } from '../src/tools.ts';

const BASE_PARAMS = {
  task: 'do something',
  cwd: '/tmp/work',
  transcriptDir: '/tmp/transcripts',
  depth: 0,
  maxDepth: 3,
  ts: '2025-01-01T00:00:00.000Z',
  indexPath: '/usr/local/src/break-away/src/index.ts',
};

describe('buildSpawnArgs', () => {
  test('returns error when depth >= maxDepth', () => {
    const result = buildSpawnArgs({ ...BASE_PARAMS, depth: 3, maxDepth: 3 });
    expect('error' in result).toBe(true);
    if ('error' in result) {
      expect(result.error).toContain('max agent depth');
    }
  });

  test('returns error when depth > maxDepth', () => {
    const result = buildSpawnArgs({ ...BASE_PARAMS, depth: 5, maxDepth: 3 });
    expect('error' in result).toBe(true);
  });

  test('returns cmd/outFile/errFile when depth < maxDepth', () => {
    const result = buildSpawnArgs({ ...BASE_PARAMS, depth: 0, maxDepth: 3 });
    expect('error' in result).toBe(false);
    if (!('error' in result)) {
      expect(typeof result.cmd).toBe('string');
      expect(typeof result.outFile).toBe('string');
      expect(typeof result.errFile).toBe('string');
    }
  });

  test('outFile is anchored to transcriptDir', () => {
    const result = buildSpawnArgs({ ...BASE_PARAMS });
    if ('error' in result) throw new Error(result.error);
    expect(result.outFile.startsWith('/tmp/transcripts/')).toBe(true);
  });

  test('errFile is anchored to transcriptDir', () => {
    const result = buildSpawnArgs({ ...BASE_PARAMS });
    if ('error' in result) throw new Error(result.error);
    expect(result.errFile.startsWith('/tmp/transcripts/')).toBe(true);
  });

  test('cmd includes indexPath', () => {
    const result = buildSpawnArgs({ ...BASE_PARAMS });
    if ('error' in result) throw new Error(result.error);
    expect(result.cmd).toContain('/usr/local/src/break-away/src/index.ts');
  });

  test('cmd includes --cwd flag', () => {
    const result = buildSpawnArgs({ ...BASE_PARAMS });
    if ('error' in result) throw new Error(result.error);
    expect(result.cmd).toContain('--cwd');
    expect(result.cmd).toContain('/tmp/work');
  });

  test('depth 2 is allowed when maxDepth is 3', () => {
    const result = buildSpawnArgs({ ...BASE_PARAMS, depth: 2, maxDepth: 3 });
    expect('error' in result).toBe(false);
  });
});
