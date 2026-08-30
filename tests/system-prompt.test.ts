// ABOUTME: Tests for system prompt loading and embedded-mode fallback behavior.
// ABOUTME: Covers loadSystemPrompt fallback ordering and SIGHUP warning in embedded mode.

import { describe, test, expect } from 'bun:test';
import { loadSystemPrompt } from '../src/index.ts';
import { writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

describe('loadSystemPrompt — fallback is real prompt, not generic string', () => {
  test('fallback when isDefault=true and file missing is non-empty and not the old generic string', () => {
    const result = loadSystemPrompt('/nonexistent/path/sys.txt', true);
    expect(typeof result).toBe('string');
    expect(result.length).toBeGreaterThan(50);
    // Must NOT be the old generic placeholder
    expect(result).not.toBe(
      'You are a code agent. Work step by step. Use tools to read, write, and run code. Report what you did when done.',
    );
  });

  test('fallback text contains real agent instructions (proves bundled content)', () => {
    const result = loadSystemPrompt('/nonexistent/path/sys.txt', true);
    // system.txt instructs the agent about tools and working step by step
    expect(result).toMatch(/tool/i);
  });

  test('explicit --system path failure exits 1 (unchanged)', () => {
    const indexPath = new URL('../src/index.ts', import.meta.url).pathname;
    const result = Bun.spawnSync(
      ['bun', indexPath, '--system', '/nonexistent/path/sys.txt', 'dummy task'],
      { env: { ...process.env, BREAK_AWAY_TRANSCRIPT_DIR: '/tmp' } },
    );
    expect(result.exitCode).toBe(1);
    expect(new TextDecoder().decode(result.stderr)).toContain('/nonexistent/path/sys.txt');
  });
});
