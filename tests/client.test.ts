// ABOUTME: Tests that client.ts reads env lazily and accepts a model override.
// ABOUTME: No real API calls — just verifies the config seam works.

import { describe, test, expect } from 'bun:test';
import { buildClientConfig } from '../src/client.ts';

describe('buildClientConfig', () => {
  test('uses override model when provided', () => {
    const cfg = buildClientConfig({ modelOverride: 'my-special-model' });
    expect(cfg.model).toBe('my-special-model');
  });

  test('falls back to env OPENAI_COMPATIBLE_MODEL when no override', () => {
    const original = process.env.OPENAI_COMPATIBLE_MODEL;
    process.env.OPENAI_COMPATIBLE_MODEL = 'env-model';
    const cfg = buildClientConfig({});
    process.env.OPENAI_COMPATIBLE_MODEL = original;
    expect(cfg.model).toBe('env-model');
  });

  test('falls back to default model string when env is unset', () => {
    const original = process.env.OPENAI_COMPATIBLE_MODEL;
    delete process.env.OPENAI_COMPATIBLE_MODEL;
    const cfg = buildClientConfig({});
    process.env.OPENAI_COMPATIBLE_MODEL = original;
    expect(typeof cfg.model).toBe('string');
    expect(cfg.model.length).toBeGreaterThan(0);
  });
});
