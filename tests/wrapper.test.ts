// ABOUTME: Tests for bin/break-away-loop wrapper script.
// ABOUTME: Uses BREAK_AWAY_CMD and BREAK_AWAY_MAX_RESTARTS env vars to stub the agent.

import { describe, test, expect } from 'bun:test';
import { mkdtempSync, writeFileSync, chmodSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const WRAPPER = new URL('../bin/break-away-loop', import.meta.url).pathname;

function makeStub(dir: string, name: string, script: string): string {
  const p = join(dir, name);
  writeFileSync(p, `#!/usr/bin/env bash\n${script}\n`);
  chmodSync(p, 0o755);
  return p;
}

describe('break-away-loop wrapper', () => {
  test('passes through exit code 0', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ba-wrapper-'));
    try {
      const stub = makeStub(dir, 'stub.sh', 'exit 0');
      const result = Bun.spawnSync(['bash', WRAPPER], {
        env: { ...process.env, BREAK_AWAY_CMD: stub, BREAK_AWAY_MAX_RESTARTS: '5' },
      });
      expect(result.exitCode).toBe(0);
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  test('restarts on exit 42, exits 0 when agent returns 0', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ba-wrapper-'));
    try {
      const counter = join(dir, 'count');
      writeFileSync(counter, '0');
      const stub = makeStub(dir, 'stub.sh', `
COUNT=$(cat "${counter}")
COUNT=$((COUNT + 1))
echo "$COUNT" > "${counter}"
if [ "$COUNT" -lt 3 ]; then
  exit 42
fi
exit 0
`);
      const result = Bun.spawnSync(['bash', WRAPPER], {
        env: { ...process.env, BREAK_AWAY_CMD: stub, BREAK_AWAY_MAX_RESTARTS: '5' },
      });
      expect(result.exitCode).toBe(0);
      const count = parseInt(require('fs').readFileSync(counter, 'utf8').trim());
      expect(count).toBe(3);
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  test('hits restart cap and exits 1 when agent always returns 42', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ba-wrapper-'));
    try {
      const stub = makeStub(dir, 'stub.sh', 'exit 42');
      const result = Bun.spawnSync(['bash', WRAPPER], {
        env: { ...process.env, BREAK_AWAY_CMD: stub, BREAK_AWAY_MAX_RESTARTS: '3' },
      });
      expect(result.exitCode).toBe(1);
      const stderr = new TextDecoder().decode(result.stderr);
      expect(stderr).toContain('restart cap reached');
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  test('passes through non-42 non-zero exit codes', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ba-wrapper-'));
    try {
      const stub = makeStub(dir, 'stub.sh', 'exit 7');
      const result = Bun.spawnSync(['bash', WRAPPER], {
        env: { ...process.env, BREAK_AWAY_CMD: stub, BREAK_AWAY_MAX_RESTARTS: '5' },
      });
      expect(result.exitCode).toBe(7);
    } finally {
      rmSync(dir, { recursive: true });
    }
  });
});
