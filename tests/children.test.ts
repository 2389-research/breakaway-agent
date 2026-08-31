// ABOUTME: Tests for gatherChildren — reads a temp agent registry + .out files, injects results.
// ABOUTME: Uses real file I/O in a temp dir; process.pid is the reliably-alive "child" for wait paths.

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { appendRecord } from '../src/registry.ts';
import { gatherChildren } from '../src/children.ts';

let tmpDir: string;
let registryPath: string;
const SELF = 999999; // a parent pid that is not any real process here

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'ba-children-test-'));
  registryPath = join(tmpDir, 'agents.jsonl');
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

const noEmit = () => {};

function baseOpts(over: Partial<Parameters<typeof gatherChildren>[1]> = {}) {
  return {
    selfPid: SELF,
    transcriptDir: tmpDir,
    deliveredPids: new Set<number>(),
    waitMs: 1000,
    pollMs: 10,
    emit: noEmit,
    ...over,
  };
}

async function seedDoneChild(pid: number, outText: string) {
  const outFile = join(tmpDir, `spawn-${pid}.out`);
  writeFileSync(outFile, outText);
  await appendRecord(registryPath, {
    event: 'agent_spawn', pid, parent_pid: SELF, task: `task-${pid}`, out: outFile, err: join(tmpDir, `spawn-${pid}.err`), ts: 't',
  });
  await appendRecord(registryPath, { event: 'agent_done', pid, ts: 't2', status: 'ok', stop_reason: 'done' });
}

describe('gatherChildren', () => {
  test('returns null when there are no children', async () => {
    expect(await gatherChildren([], baseOpts())).toBeNull();
  });

  test('delivers a finished child output as a user message', async () => {
    await seedDoneChild(424242, 'the child found the bug in foo.ts');
    const result = await gatherChildren([], baseOpts());
    expect(result).not.toBeNull();
    expect(result!.length).toBe(1);
    expect(result![0].role).toBe('user');
    expect(result![0].content).toContain('Child agent 424242');
    expect(result![0].content).toContain('[done]');
    expect(result![0].content).toContain('the child found the bug in foo.ts');
  });

  test('redacts secrets in child output before injecting', async () => {
    await seedDoneChild(424243, 'found key sk-abcdef0123456789ABCDEF in config');
    const result = await gatherChildren([], baseOpts());
    expect(result![0].content).toContain('[REDACTED]');
    expect(result![0].content).not.toContain('sk-abcdef0123456789ABCDEF');
  });

  test('delivers each child only once — a second gather returns null', async () => {
    await seedDoneChild(424244, 'result');
    const delivered = new Set<number>();
    expect(await gatherChildren([], baseOpts({ deliveredPids: delivered }))).not.toBeNull();
    expect(await gatherChildren([], baseOpts({ deliveredPids: delivered }))).toBeNull();
  });

  test('ignores a detached child', async () => {
    const outFile = join(tmpDir, 'spawn-d.out');
    writeFileSync(outFile, 'detached result');
    await appendRecord(registryPath, {
      event: 'agent_spawn', pid: 424245, parent_pid: SELF, task: 't', out: outFile, err: 'e', ts: 't', detached: true,
    });
    await appendRecord(registryPath, { event: 'agent_done', pid: 424245, ts: 't2', status: 'ok', stop_reason: 'done' });
    expect(await gatherChildren([], baseOpts())).toBeNull();
  });

  test('times out on a still-running child and proceeds without it', async () => {
    // process.pid is guaranteed alive → the child reads as 'running'.
    await appendRecord(registryPath, {
      event: 'agent_spawn', pid: process.pid, parent_pid: SELF, task: 'slow', out: join(tmpDir, 'x.out'), err: 'e', ts: 't',
    });
    const result = await gatherChildren([], baseOpts({ waitMs: 40, pollMs: 10 }));
    expect(result).not.toBeNull();
    expect(result![0].content).toContain('still running');
  });

  test('waits for a running child, then delivers once it finishes', async () => {
    const outFile = join(tmpDir, 'wait.out');
    await appendRecord(registryPath, {
      event: 'agent_spawn', pid: process.pid, parent_pid: SELF, task: 'work', out: outFile, err: 'e', ts: 't',
    });
    const gather = gatherChildren([], baseOpts({ waitMs: 3000, pollMs: 15 }));
    await Bun.sleep(60);
    writeFileSync(outFile, 'finished work product');
    await appendRecord(registryPath, { event: 'agent_done', pid: process.pid, ts: 't2', status: 'ok', stop_reason: 'done' });
    const result = await gather;
    expect(result).not.toBeNull();
    expect(result![0].content).toContain('finished work product');
    expect(result![0].content).toContain('[done]');
  });
});
