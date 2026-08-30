// ABOUTME: Append-only JSONL agent registry — tracks spawn/start/done records.
// ABOUTME: Best-effort: failures warn on stderr, never crash. Pure state derivation.

import { appendFileSync, readFileSync, writeFileSync, existsSync, mkdirSync, statSync } from 'node:fs';
import { dirname } from 'node:path';

// ── Record types ──────────────────────────────────────────────────────────────

export type AgentSpawnRecord = {
  event: 'agent_spawn';
  pid: number;
  parent_pid: number;
  task: string;
  out: string;
  err: string;
  ts: string;
};

export type AgentStartRecord = {
  event: 'agent_start';
  pid: number;
  parent_pid: number | null;
  depth: number;
  task: string;
  cwd: string;
  ts: string;
};

export type AgentDoneRecord = {
  event: 'agent_done';
  pid: number;
  ts: string;
};

export type AgentRecord = AgentSpawnRecord | AgentStartRecord | AgentDoneRecord;

// ── Derived state ─────────────────────────────────────────────────────────────

export type AgentState = {
  pid: number;
  state: 'running' | 'done' | 'died';
  parentPid: number | null;
  task: string;
  startTs: string;
  errFile: string | undefined;
};

// ── Growth cap ────────────────────────────────────────────────────────────────

const MAX_REGISTRY_BYTES = 512 * 1024; // 512 KB
const MAX_REGISTRY_LINES = 500;

function pruneIfNeeded(path: string): void {
  try {
    if (!existsSync(path)) return;
    const st = statSync(path);
    if (st.size <= MAX_REGISTRY_BYTES) return;
    const content = readFileSync(path, 'utf8');
    const lines = content.split('\n').filter((l) => l.trim());
    if (lines.length <= MAX_REGISTRY_LINES) return;
    const kept = lines.slice(-MAX_REGISTRY_LINES).join('\n') + '\n';
    writeFileSync(path, kept, 'utf8');
  } catch (err) {
    process.stderr.write(`[registry] prune failed: ${err}\n`);
  }
}

// ── I/O ───────────────────────────────────────────────────────────────────────

export async function appendRecord(path: string, record: Omit<AgentRecord, never>): Promise<void> {
  try {
    mkdirSync(dirname(path), { recursive: true });
    pruneIfNeeded(path);
    const line = JSON.stringify(record) + '\n';
    appendFileSync(path, line, 'utf8');
  } catch (err) {
    process.stderr.write(`[registry] append failed: ${err}\n`);
  }
}

export async function readRegistry(path: string): Promise<AgentRecord[]> {
  try {
    if (!existsSync(path)) return [];
    const content = readFileSync(path, 'utf8');
    const records: AgentRecord[] = [];
    for (const line of content.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        records.push(JSON.parse(trimmed) as AgentRecord);
      } catch {
        // skip malformed lines
      }
    }
    return records;
  } catch (err) {
    process.stderr.write(`[registry] read failed: ${err}\n`);
    return [];
  }
}

// ── State derivation (pure except for process.kill signal check) ──────────────

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function deriveAgentStates(records: AgentRecord[]): Map<number, AgentState> {
  // Build per-pid metadata from records in order.
  const meta = new Map<number, { parentPid: number | null; task: string; startTs: string; errFile: string | undefined; done: boolean }>();

  for (const r of records) {
    if (r.event === 'agent_spawn') {
      // Parent's record about a child — fills in the child entry.
      const prev = meta.get(r.pid);
      meta.set(r.pid, {
        parentPid: r.parent_pid,
        task: r.task,
        startTs: r.ts,
        errFile: r.err,
        done: prev?.done ?? false,
      });
    } else if (r.event === 'agent_start') {
      // Process's own boot record — more authoritative on parentPid/task.
      const prev = meta.get(r.pid);
      meta.set(r.pid, {
        parentPid: r.parent_pid,
        task: r.task,
        startTs: r.ts,
        errFile: prev?.errFile,
        done: prev?.done ?? false,
      });
    } else if (r.event === 'agent_done') {
      const prev = meta.get(r.pid);
      meta.set(r.pid, {
        parentPid: prev?.parentPid ?? null,
        task: prev?.task ?? '',
        startTs: prev?.startTs ?? r.ts,
        errFile: prev?.errFile,
        done: true,
      });
    }
  }

  const states = new Map<number, AgentState>();
  for (const [pid, m] of meta) {
    let state: AgentState['state'];
    if (m.done) {
      state = 'done';
    } else if (isPidAlive(pid)) {
      state = 'running';
    } else {
      state = 'died';
    }
    states.set(pid, {
      pid,
      state,
      parentPid: m.parentPid,
      task: m.task,
      startTs: m.startTs,
      errFile: m.errFile,
    });
  }
  return states;
}

// ── Poller diff (pure) ────────────────────────────────────────────────────────

export function diffAgentStates(
  prev: Map<number, AgentState>,
  next: Map<number, AgentState>,
  ourPid: number,
): string[] {
  const lines: string[] = [];
  for (const [pid, nextState] of next) {
    if (nextState.parentPid !== ourPid) continue; // only direct children
    const prevState = prev.get(pid);
    const prevStateName = prevState?.state ?? 'running';
    if (prevStateName === nextState.state) continue;

    // Compute age in seconds from startTs
    const ageMs = Date.now() - new Date(nextState.startTs).getTime();
    const ageSecs = Math.round(ageMs / 1000);

    if (nextState.state === 'done') {
      lines.push(`◆ agent ${pid} done (${ageSecs}s)`);
    } else if (nextState.state === 'died') {
      lines.push(`✗ agent ${pid} died (${ageSecs}s)`);
    }
  }
  return lines;
}
