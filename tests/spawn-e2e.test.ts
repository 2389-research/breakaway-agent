// ABOUTME: E2e test for spawn_agent tool — verifies a child agent survives parent exit.
// ABOUTME: Uses real gateway; polls for child output file up to 30s.

import { describe, test, expect } from 'bun:test';
import { mkdtempSync, existsSync, readFileSync, rmSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const INDEX = new URL('../src/index.ts', import.meta.url).pathname;

describe('spawn_agent survival', () => {
  test(
    'child agent survives parent exit and writes output',
    async () => {
      const tmpDir = mkdtempSync(join(tmpdir(), 'ba-spawn-e2e-'));
      const flagFile = join(tmpDir, 'flag.txt');

      try {
        // Run the parent agent; it spawns a child that writes flagFile.
        const parentResult = Bun.spawnSync(
          [
            'bun',
            INDEX,
            `Use spawn_agent to start a child agent whose task is: write the text 'child-alive' to ${flagFile} using bash`,
          ],
          {
            env: {
              ...process.env,
              BREAK_AWAY_TRANSCRIPT_DIR: tmpDir,
              BREAK_AWAY_MAX_TURNS: '10',
            },
            timeout: 60000,
          },
        );

        // Parent must exit cleanly (the actual exit code may be 0 or 1; just wait for it)
        // The key assertion is that the child eventually writes the flag file.

        // Poll up to 30s for the flag file
        const deadline = Date.now() + 30000;
        let flagContent = '';
        while (Date.now() < deadline) {
          if (existsSync(flagFile)) {
            flagContent = readFileSync(flagFile, 'utf8').trim();
            if (flagContent.includes('child-alive')) break;
          }
          await Bun.sleep(500);
        }

        expect(flagContent).toContain('child-alive');

        // A spawn-*.out file should exist in the transcript dir
        const spawnOuts = readdirSync(tmpDir).filter((f) => f.startsWith('spawn-') && f.endsWith('.out'));
        expect(spawnOuts.length).toBeGreaterThan(0);
      } finally {
        rmSync(tmpDir, { recursive: true, force: true });
      }
    },
    35000,
  );
});
