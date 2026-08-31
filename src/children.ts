// ABOUTME: Gathers finished child-agent results into the parent's context at finish time.
// ABOUTME: No module globals — delivered pids, wait budget, and dirs are injected via opts.

import { join } from 'node:path';
import { readFileSync, existsSync } from 'node:fs';
import type { Message } from './types.ts';
import { readRegistry, deriveAgentStates, type AgentSpawnRecord } from './registry.ts';
import { redactSecrets } from './redact.ts';

// Child .out is capped exactly like tool output (mirrors OUTPUT_CAP in tools.ts). Kept local so
// children.ts does not depend on the tool registry.
const OUTPUT_CAP = 8000;

function capOutput(output: string): string {
  if (output.length <= OUTPUT_CAP) return output;
  return `[truncated: showing last ${OUTPUT_CAP} of ${output.length} chars]\n` + output.slice(-OUTPUT_CAP);
}

function readOut(path: string): string {
  try {
    if (!existsSync(path)) return '';
    return readFileSync(path, 'utf8');
  } catch {
    return '';
  }
}

export type GatherOpts = {
  selfPid: number;
  transcriptDir: string;
  deliveredPids: Set<number>;
  waitMs: number;
  emit: (event: Record<string, unknown>) => void;
  pollMs?: number; // poll cadence while waiting for a running child (default 1000)
};

// Gather results from this process's direct, non-detached children that have not been delivered yet.
// Returns user messages to inject (one per newly-terminal child, plus a note per timed-out child), or
// null when nothing is pending/new. Never waits longer than waitMs total.
export async function gatherChildren(messages: Message[], opts: GatherOpts): Promise<Message[] | null> {
  const registryPath = join(opts.transcriptDir, 'agents.jsonl');
  const pollMs = opts.pollMs ?? 1000;

  const records = await readRegistry(registryPath);
  const detached = new Set<number>();
  const spawnByPid = new Map<number, AgentSpawnRecord>();
  for (const r of records) {
    if (r.event === 'agent_spawn') {
      spawnByPid.set(r.pid, r);
      if (r.detached) detached.add(r.pid);
    }
  }

  const isOurs = (pid: number, parentPid: number | null) =>
    parentPid === opts.selfPid && !detached.has(pid) && !opts.deliveredPids.has(pid);

  let states = deriveAgentStates(records);
  const pending = [...states.values()].filter((s) => isOurs(s.pid, s.parentPid)).map((s) => s.pid);
  if (pending.length === 0) return null;

  const out: Message[] = [];
  const deadline = Date.now() + Math.max(0, opts.waitMs);
  let awaitedEmitted = false;

  for (;;) {
    states = deriveAgentStates(await readRegistry(registryPath));

    // Deliver any pending child that is now terminal (done or died).
    for (const pid of pending) {
      if (opts.deliveredPids.has(pid)) continue;
      const st = states.get(pid);
      if (!st || st.state === 'running') continue;
      const spawn = spawnByPid.get(pid);
      const task = st.task || spawn?.task || '';
      const status = st.stopReason ?? st.state; // 'done' | 'blocked' | ... | 'died'
      const body = redactSecrets(capOutput(spawn ? readOut(spawn.out) : ''));
      out.push({ role: 'user', content: `Child agent ${pid} (task: ${task}) finished [${status}]:\n${body}` });
      opts.deliveredPids.add(pid);
      opts.emit({ event: 'child_result', pid, task, status });
    }

    const remaining = pending.filter((pid) => !opts.deliveredPids.has(pid));
    if (remaining.length === 0) break;

    if (Date.now() >= deadline) {
      // Timed out waiting for still-running children: note them once and let the finish proceed.
      for (const pid of remaining) {
        out.push({ role: 'user', content: `Child agent ${pid} still running, proceeding without it.` });
        opts.deliveredPids.add(pid);
      }
      break;
    }

    if (!awaitedEmitted) {
      opts.emit({ event: 'awaiting_children', pids: remaining });
      awaitedEmitted = true;
    }
    await Bun.sleep(Math.max(1, Math.min(pollMs, deadline - Date.now())));
  }

  return out.length > 0 ? out : null;
}
