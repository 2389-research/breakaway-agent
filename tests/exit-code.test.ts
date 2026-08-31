// ABOUTME: Tests for exitCodeForStopReason — maps a run's terminal state to a shell exit code.
// ABOUTME: Only a real completion is success; every other outcome exits nonzero for callers/CI.

import { describe, test, expect } from 'bun:test';
import { exitCodeForStopReason } from '../src/index.ts';

describe('exitCodeForStopReason', () => {
  test('a completed run exits zero', () => {
    expect(exitCodeForStopReason('done')).toBe(0);
  });

  test('hitting the turn limit exits nonzero — the run is incomplete', () => {
    expect(exitCodeForStopReason('maxTurns')).not.toBe(0);
  });

  test('an errored run exits nonzero', () => {
    expect(exitCodeForStopReason('error')).not.toBe(0);
  });

  test('an aborted run exits nonzero', () => {
    expect(exitCodeForStopReason('aborted')).not.toBe(0);
  });
});
