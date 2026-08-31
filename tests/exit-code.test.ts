// ABOUTME: Tests for exitCodeForStopReason — maps a run's terminal state to a shell exit code.
// ABOUTME: Only a real completion is success; every other outcome exits nonzero for callers/CI.

import { describe, test, expect } from 'bun:test';
import { exitCodeForStopReason, statusForStopReason } from '../src/index.ts';

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

  test('a blocked run exits nonzero — the agent declared it could not proceed', () => {
    expect(exitCodeForStopReason('blocked')).not.toBe(0);
  });
});

describe('statusForStopReason', () => {
  test('a completed run is ok', () => {
    expect(statusForStopReason('done')).toBe('ok');
  });
  test('a blocked run is error — not a green success', () => {
    expect(statusForStopReason('blocked')).toBe('error');
  });
  test('an errored run is error', () => {
    expect(statusForStopReason('error')).toBe('error');
  });
  test('an aborted run is error', () => {
    expect(statusForStopReason('aborted')).toBe('error');
  });
  test('hitting the turn cap records ok status — incomplete but not a crash', () => {
    expect(statusForStopReason('maxTurns')).toBe('ok');
  });
});
