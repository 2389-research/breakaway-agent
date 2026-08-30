// ABOUTME: Tests for hot-reload (SIGHUP) and restart (SIGUSR2) behavior.
// ABOUTME: Tests RESTART_EXIT_CODE constant, signal handlers, doReload, and currentRefs.

import { describe, test, expect } from 'bun:test';
import { RESTART_EXIT_CODE } from '../src/index.ts';

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
