// ABOUTME: Tests for hot-reload (SIGHUP) and restart (SIGUSR2) behavior.
// ABOUTME: Tests RESTART_EXIT_CODE constant, signal handlers, doReload, and currentRefs.

import { describe, test, expect } from 'bun:test';
import { resolve } from 'node:path';
import { RESTART_EXIT_CODE, doReload, currentRefs } from '../src/index.ts';

const SOURCE_DIR = resolve(new URL('../src', import.meta.url).pathname);

describe('RESTART_EXIT_CODE', () => {
  test('is 42', () => {
    expect(RESTART_EXIT_CODE).toBe(42);
  });
});

describe('SIGUSR2 handler', () => {
  test('is registered', () => {
    expect(process.listeners('SIGUSR2').length).toBeGreaterThan(0);
  });
});

describe('SIGHUP handler', () => {
  test('is registered', () => {
    expect(process.listeners('SIGHUP').length).toBeGreaterThan(0);
  });
});

describe('doReload', () => {
  test('returns false and leaves refs unchanged when paths do not exist', async () => {
    const prevTools = currentRefs.tools;
    const prevPolicy = currentRefs.policy;
    const result = await doReload('/nonexistent/tools.ts', '/nonexistent/policy.ts', '/nonexistent/system.txt');
    expect(result).toBe(false);
    expect(currentRefs.tools).toBe(prevTools);
    expect(currentRefs.policy).toBe(prevPolicy);
  });

  test('returns true and updates refs when given real paths', async () => {
    const toolsPath = resolve(SOURCE_DIR, 'tools.ts');
    const policyPath = resolve(SOURCE_DIR, 'policy.ts');
    const systemPath = resolve(SOURCE_DIR, '../system.txt');
    const result = await doReload(toolsPath, policyPath, systemPath);
    expect(result).toBe(true);
    expect(Array.isArray(currentRefs.tools)).toBe(true);
    expect(currentRefs.tools.length).toBeGreaterThan(0);
  });
});
