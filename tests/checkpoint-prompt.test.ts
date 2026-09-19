// ABOUTME: Tests for checkpoint prompt loading, {turn} interpolation, and embedded fallback.
// ABOUTME: The marker stays a code constant; the editable prompt body lives in checkpoint.txt.

import { describe, test, expect } from 'bun:test';
import {
  strategyCheckpointPrompt,
  loadCheckpointTemplate,
  STRATEGY_CHECKPOINT_MARKER,
} from '../src/agent.ts';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

describe('strategyCheckpointPrompt — file-driven with {turn} interpolation', () => {
  test('interpolates the turn number into the prompt', () => {
    const prompt = strategyCheckpointPrompt(7);
    expect(prompt).toContain('7 turns');
    // The placeholder must be fully substituted — no literal {turn} leaks to the model.
    expect(prompt).not.toContain('{turn}');
  });

  test('opens with the marker so the compactor can detect it', () => {
    // Drift guard: the marker is a code constant shared with policy.ts (startsWith detection).
    // If checkpoint.txt's first line is edited away from the constant, this fails loudly.
    expect(strategyCheckpointPrompt(1).startsWith(STRATEGY_CHECKPOINT_MARKER)).toBe(true);
  });

  test('carries the reflection instructions (proves the file body loaded)', () => {
    expect(strategyCheckpointPrompt(3)).toMatch(/rank your evidence/i);
  });
});

describe('loadCheckpointTemplate — disk primary, embedded fallback', () => {
  test('reads the template from a given path without interpolating', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cp-'));
    const path = join(dir, 'checkpoint.txt');
    writeFileSync(path, `${STRATEGY_CHECKPOINT_MARKER}\nTurn {turn} custom body.`);
    const tpl = loadCheckpointTemplate(path);
    expect(tpl).toContain('custom body');
    // The loader returns the raw template; interpolation is strategyCheckpointPrompt's job.
    expect(tpl).toContain('{turn}');
  });

  test('falls back to the embedded default when the file is missing', () => {
    // The compiled binary has no checkpoint.txt on disk — this fallback is what keeps it working.
    const tpl = loadCheckpointTemplate('/nonexistent/checkpoint.txt');
    expect(tpl.length).toBeGreaterThan(50);
    expect(tpl.startsWith(STRATEGY_CHECKPOINT_MARKER)).toBe(true);
    expect(tpl).toMatch(/rank your evidence/i);
  });
});
