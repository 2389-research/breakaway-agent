// ABOUTME: Default policy for the agent loop — max turns, error handling, context, and continuation.
// ABOUTME: Swap any field to change agent behavior without touching the loop itself.

import type { Policy, Message } from './types.ts';
import { STRATEGY_CHECKPOINT_MARKER } from './agent.ts';
import { gatherChildren } from './children.ts';
import { defaultTranscriptDir } from './transcript.ts';

// Rolling evidence compaction. The model's view collapses raw exploration before the last COMPLETED
// strategy checkpoint down to just the checkpoint summaries, keeping system + task + every prior
// summary + everything from the last completed checkpoint onward (verbatim). Pure: returns a VIEW,
// never mutates the caller's array, so the transcript and FinalState.messages keep every turn.
// Identity until the first checkpoint is answered.
export function compactByCheckpoints(messages: Message[]): Message[] {
  // A checkpoint is COMPLETED iff the message right after its prompt is a no-tool assistant summary.
  const completed: { promptIdx: number; summaryIdx: number }[] = [];
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    if (m.role === 'user' && (m.content ?? '').startsWith(STRATEGY_CHECKPOINT_MARKER)) { // startsWith, not includes: a real prompt opens with the marker; a child result only contains it mid-body.
      const next = messages[i + 1];
      if (next && next.role === 'assistant' && !next.tool_calls?.length) {
        completed.push({ promptIdx: i, summaryIdx: i + 1 });
      }
    }
  }

  if (completed.length === 0) return messages; // no completed checkpoint yet — identity

  const last = completed[completed.length - 1];
  const view: Message[] = [];
  for (const m of messages) if (m.role === 'system') view.push(m);
  const task = messages.find((m) => m.role === 'user');
  if (task) view.push(task);
  for (const cp of completed.slice(0, -1)) view.push(messages[cp.summaryIdx]);
  for (const m of messages.slice(last.promptIdx)) view.push(m);
  return view;
}

const POLICY_SOURCE_DIR = import.meta.dir;
// Bounded so a hung child can never wedge the parent's finish forever; generous enough for real work.
const CHILD_WAIT_MS = 300000; // 5 min
// Process-lifetime record of delivered child pids, so each child's result lands exactly once across
// repeated finishes. Owned here and injected into gatherChildren.
const deliveredChildPids = new Set<number>();

export const defaultPolicy: Policy = {
  // No turn limit by default: a run finishes when the model does, not at an arbitrary count.
  // `--max-turns N` sets an explicit safety/debug cap; hitting it is an incomplete (nonzero) exit.
  maxTurns: Infinity,
  onToolError: 'retry',
  contextStrategy: compactByCheckpoints,
  // A finish must be a real answer, an honest block, or a blank. A blank no-tool response is
  // 'empty' (never 'done'); a line beginning BLOCKED: is an honest terminal state.
  classifyFinish: (msg: Message): 'done' | 'blocked' | 'empty' => {
    if (msg.role !== 'assistant' || msg.tool_calls?.length) return 'empty';
    const content = (msg.content ?? '').trim();
    if (content === '') return 'empty';
    if (/^BLOCKED:/i.test(content)) return 'blocked';
    return 'done';
  },
  // Survival by default: retry transient gateway blips so a run finishes instead of dying at turn N.
  apiMaxAttempts: 3,
  apiRetryBaseMs: 750,
  // A blank finish gets this many nudges to recover before the run ends as 'error' (never a false done).
  maxEmptyRetries: 1,
  // On by default: never accept the model's first "looks done" without one enforced verify pass.
  completionAudit: true,
  // Re-focus + compaction anchor every 40 turns; a short run never reaches it, so trivial tasks pay nothing.
  strategyCheckpointEvery: 40,
  childWaitMs: CHILD_WAIT_MS,
  // Default finish hook: gather finished direct children into context before accepting a finish.
  // Overriding the wait means overriding onFinish too — this is the experiment surface.
  onFinish: (messages, emit) =>
    gatherChildren(messages, {
      selfPid: process.pid,
      transcriptDir: defaultTranscriptDir(POLICY_SOURCE_DIR),
      deliveredPids: deliveredChildPids,
      waitMs: CHILD_WAIT_MS,
      emit,
    }),
};

// The "I mean business" profile (--serious): extra blip-survival on top of the default. The
// completion audit is already baseline (on in defaultPolicy), so serious only needs to add more
// API-retry headroom. Like the default it runs unbounded (maxTurns inherited as Infinity).
export const seriousPolicy: Policy = {
  ...defaultPolicy,
  apiMaxAttempts: 5,
};

// Resolve CLI intent into a Policy. --serious picks the survival profile; an explicit --max-turns
// then imposes a turn cap on top, so `--serious --max-turns 120` keeps the serious survival
// settings but stops at 120 turns. No flags → the default policy (unbounded), by reference.
export function selectPolicy(opts: { serious: boolean; maxTurns: number | null }): Policy {
  const base = opts.serious ? seriousPolicy : defaultPolicy;
  return opts.maxTurns !== null ? { ...base, maxTurns: opts.maxTurns } : base;
}
