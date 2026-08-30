// ABOUTME: Tests for registry.ts — append, read, state derivation, and growth cap.
// ABOUTME: Uses real file I/O; no mocks.

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, existsSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  appendRecord,
  readRegistry,
  deriveAgentStates,
  diffAgentStates,
  type AgentRecord,
  type AgentState,
} from '../src/registry.ts';

let tmpDir: string;
let registryPath: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'ba-registry-test-'));
  registryPath = join(tmpDir, 'agents.jsonl');
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

// ── appendRecord ─────────────────────────────────────────────────────────────

describe('appendRecord', () => {
  test('creates agents.jsonl if not present', async () => {
    await appendRecord(registryPath, { event: 'agent_start', pid: 1, parent_pid: null, depth: 0, task: 'hi', cwd: '/tmp', ts: 't' });
    expect(existsSync(registryPath)).toBe(true);
  });

  test('appends valid JSONL lines', async () => {
    await appendRecord(registryPath, { event: 'agent_start', pid: 1, parent_pid: null, depth: 0, task: 'a', cwd: '/tmp', ts: 't1' });
    await appendRecord(registryPath, { event: 'agent_done', pid: 1, ts: 't2' });
    const lines = readFileSync(registryPath, 'utf8').trim().split('\n');
    expect(lines.length).toBe(2);
    const first = JSON.parse(lines[0]);
    expect(first.event).toBe('agent_start');
    const second = JSON.parse(lines[1]);
    expect(second.event).toBe('agent_done');
  });

  test('does not throw when dir is missing — best effort warns to stderr', async () => {
    const badPath = '/nonexistent/dir/agents.jsonl';
    // Should not throw
    await expect(appendRecord(badPath, { event: 'agent_done', pid: 9, ts: 'x' })).resolves.toBeUndefined();
  });
});

// ── readRegistry ─────────────────────────────────────────────────────────────

describe('readRegistry', () => {
  test('returns empty array for missing file', async () => {
    const records = await readRegistry(registryPath);
    expect(records).toEqual([]);
  });

  test('parses all valid JSONL records', async () => {
    writeFileSync(registryPath, JSON.stringify({ event: 'agent_start', pid: 100 }) + '\n' + JSON.stringify({ event: 'agent_done', pid: 100 }) + '\n');
    const records = await readRegistry(registryPath);
    expect(records.length).toBe(2);
  });

  test('skips blank lines', async () => {
    writeFileSync(registryPath, '\n' + JSON.stringify({ event: 'agent_done', pid: 2 }) + '\n\n');
    const records = await readRegistry(registryPath);
    expect(records.length).toBe(1);
  });

  test('skips malformed JSON lines without crashing', async () => {
    writeFileSync(registryPath, 'not-json\n' + JSON.stringify({ event: 'agent_done', pid: 3 }) + '\n');
    const records = await readRegistry(registryPath);
    expect(records.length).toBe(1);
    expect((records[0] as AgentRecord & { pid: number }).pid).toBe(3);
  });
});

// ── deriveAgentStates ─────────────────────────────────────────────────────────

describe('deriveAgentStates', () => {
  test('agent with agent_done record is "done"', () => {
    const records: AgentRecord[] = [
      { event: 'agent_start', pid: 12345, parent_pid: null, depth: 0, task: 't', cwd: '/tmp', ts: new Date().toISOString() },
      { event: 'agent_done', pid: 12345, ts: new Date().toISOString() },
    ];
    const states = deriveAgentStates(records);
    expect(states.get(12345)?.state).toBe('done');
  });

  test('process.pid reports as running (self is alive)', () => {
    const records: AgentRecord[] = [
      { event: 'agent_start', pid: process.pid, parent_pid: null, depth: 0, task: 'self', cwd: '/tmp', ts: new Date().toISOString() },
    ];
    const states = deriveAgentStates(records);
    expect(states.get(process.pid)?.state).toBe('running');
  });

  test('dead pid reports as died', async () => {
    // Spawn a real process and wait for it to die
    const proc = Bun.spawn(['true'], { stdout: 'ignore', stderr: 'ignore' });
    const deadPid = proc.pid;
    await proc.exited;
    // Now it's dead — give OS a moment (already exited above)
    const records: AgentRecord[] = [
      { event: 'agent_start', pid: deadPid, parent_pid: null, depth: 0, task: 'dead', cwd: '/tmp', ts: new Date().toISOString() },
    ];
    const states = deriveAgentStates(records);
    // Process exited without agent_done → died
    expect(states.get(deadPid)?.state).toBe('died');
  });

  test('collects start timestamp from agent_start record', () => {
    const ts = '2026-01-01T00:00:00.000Z';
    const records: AgentRecord[] = [
      { event: 'agent_start', pid: process.pid, parent_pid: null, depth: 0, task: 'hi', cwd: '/tmp', ts },
    ];
    const states = deriveAgentStates(records);
    expect(states.get(process.pid)?.startTs).toBe(ts);
  });

  test('collects parent_pid from agent_start', () => {
    const records: AgentRecord[] = [
      { event: 'agent_start', pid: 999, parent_pid: 1, depth: 1, task: 'child', cwd: '/tmp', ts: 'x' },
    ];
    const states = deriveAgentStates(records);
    expect(states.get(999)?.parentPid).toBe(1);
  });

  test('agent without agent_start but with agent_spawn uses spawn metadata', () => {
    // Parent spawns child — child may not have written agent_start yet.
    const records: AgentRecord[] = [
      {
        event: 'agent_spawn',
        pid: 7777,
        parent_pid: process.pid,
        task: 'spawned',
        out: '/tmp/x.out',
        err: '/tmp/x.err',
        ts: new Date().toISOString(),
      },
    ];
    const states = deriveAgentStates(records);
    // Spawned but no start — alive-check will say died (pid 7777 doesn't exist)
    const s = states.get(7777);
    expect(s).toBeDefined();
    expect(s!.task).toBe('spawned');
    expect(s!.parentPid).toBe(process.pid);
  });
});

// ── diffAgentStates ──────────────────────────────────────────────────────────

describe('diffAgentStates', () => {
  const mk = (pid: number, state: AgentState['state'], parentPid: number): AgentState => ({
    pid,
    state,
    parentPid,
    task: 'task',
    startTs: new Date().toISOString(),
    errFile: undefined,
  });

  test('returns empty array when nothing changed', () => {
    const prev = new Map([[1, mk(1, 'running', 0)]]);
    const next = new Map([[1, mk(1, 'running', 0)]]);
    expect(diffAgentStates(prev, next, 0)).toEqual([]);
  });

  test('reports done transition for a direct child', () => {
    const prev = new Map([[5, mk(5, 'running', 0)]]);
    const next = new Map([[5, mk(5, 'done', 0)]]);
    const lines = diffAgentStates(prev, next, 0);
    expect(lines.length).toBe(1);
    expect(lines[0]).toContain('done');
    expect(lines[0]).toContain('5');
  });

  test('reports died transition for a direct child', () => {
    const prev = new Map([[6, mk(6, 'running', 0)]]);
    const next = new Map([[6, mk(6, 'died', 0)]]);
    const lines = diffAgentStates(prev, next, 0);
    expect(lines.length).toBe(1);
    expect(lines[0]).toContain('died');
  });

  test('ignores non-direct-children (different parentPid)', () => {
    const prev = new Map([[9, mk(9, 'running', 99)]]);
    const next = new Map([[9, mk(9, 'done', 99)]]);
    // Our pid is 0, child's parentPid is 99 — not a direct child
    const lines = diffAgentStates(prev, next, 0);
    expect(lines).toEqual([]);
  });

  test('reports multiple transitions in one pass', () => {
    const prev = new Map([
      [10, mk(10, 'running', 0)],
      [11, mk(11, 'running', 0)],
    ]);
    const next = new Map([
      [10, mk(10, 'done', 0)],
      [11, mk(11, 'died', 0)],
    ]);
    const lines = diffAgentStates(prev, next, 0);
    expect(lines.length).toBe(2);
  });
});
