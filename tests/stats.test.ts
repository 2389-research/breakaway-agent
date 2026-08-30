// ABOUTME: Tests for the formatStats pure function — no I/O, just string output shape.
// ABOUTME: Covers normal runs, zero-token edge cases, and rounding of elapsed time.

import { describe, test, expect } from 'bun:test';
import { formatStats } from '../src/index.ts';
import type { FinalState } from '../src/types.ts';

function makeState(overrides: Partial<FinalState> = {}): FinalState {
  return {
    messages: [],
    turns: 3,
    usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 },
    elapsed: 4200,
    stopReason: 'done',
    ...overrides,
  };
}

describe('formatStats', () => {
  test('formats a normal run', () => {
    const line = formatStats(makeState());
    expect(line).toBe('done in 3 turns, 150 tokens (prompt: 100 / completion: 50), 4.2s');
  });

  test('rounds elapsed to one decimal', () => {
    const line = formatStats(makeState({ elapsed: 1999 }));
    expect(line).toBe('done in 3 turns, 150 tokens (prompt: 100 / completion: 50), 2.0s');
  });

  test('handles zero turns and tokens', () => {
    const line = formatStats(
      makeState({ turns: 0, usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 }, elapsed: 500 }),
    );
    expect(line).toBe('done in 0 turns, 0 tokens (prompt: 0 / completion: 0), 0.5s');
  });

  test('formats large token counts without commas', () => {
    const line = formatStats(
      makeState({ usage: { prompt_tokens: 10000, completion_tokens: 2000, total_tokens: 12000 } }),
    );
    expect(line).toContain('12000 tokens');
    expect(line).toContain('prompt: 10000');
    expect(line).toContain('completion: 2000');
  });

  test('formats single-turn run', () => {
    const line = formatStats(makeState({ turns: 1, elapsed: 1000 }));
    expect(line).toMatch(/^done in 1 turns/);
  });
});
