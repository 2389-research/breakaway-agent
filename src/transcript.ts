// ABOUTME: Per-run JSONL transcript writer — creates run-<ISO8601>.jsonl files in a configurable dir.
// ABOUTME: Best-effort: write failures warn on stderr but never crash the run.

import { mkdirSync, createWriteStream } from 'node:fs';
import type { WriteStream } from 'node:fs';
import { join } from 'node:path';

export type TranscriptHandle = WriteStream | null;

export async function openTranscript(dir: string): Promise<TranscriptHandle> {
  try {
    mkdirSync(dir, { recursive: true });
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    const filePath = join(dir, `run-${ts}.jsonl`);
    return createWriteStream(filePath, { flags: 'a' });
  } catch (err) {
    process.stderr.write(`[transcript] could not open transcript dir: ${err}\n`);
    return null;
  }
}

export async function writeEvent(handle: TranscriptHandle, event: Record<string, unknown>): Promise<void> {
  if (!handle) return;
  try {
    handle.write(JSON.stringify({ ts: new Date().toISOString(), ...event }) + '\n');
  } catch {
    // best-effort — swallow
  }
}

export async function closeTranscript(handle: TranscriptHandle): Promise<void> {
  if (!handle) return;
  return new Promise((resolve) => handle.end(resolve));
}
