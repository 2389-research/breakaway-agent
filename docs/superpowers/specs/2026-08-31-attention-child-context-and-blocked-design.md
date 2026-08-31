# Design: long-run attention, child-context gather, and the `blocked` outcome

Date: 2026-08-31
Repo: break-away (tiny YOLO code agent, Bun/TS)
Status: design — approved in brainstorm, pending spec review

## Context

break-away runs unbounded by default (a run finishes when the model finishes, not
at a turn cap). Batch 1 — the honest completion contract (commit `fb1ba6c`) — closed
the false-success hole: a blank no-tool finish is no longer `done`. This spec covers
the next three pieces from Harper's list. They share one enemy: a long autonomous run
that drifts, forgets its own findings, lies about success, or loses the work its
children did.

The motivating failure: a real fleet-hunt run "saw disaster and then forgot its
importance" — unlimited tokens did not stop attention drift. A critical finding from
early turns scrolled out of the model's effective attention by turn 90.

Three mechanisms, one small outcome. They are independent and land as separate tasks.

## Global Constraints (bind every task)

These are standing rules for this repo. A change that breaks one is wrong even if tests pass.

- **stdout purity (one-shot):** stdout carries the final prose answer ONLY; all progress,
  stats, and new events go to stderr/transcript. No `console.log` in application code.
  A `blocked` run's reason rides out as the final assistant message on stdout, then exits nonzero.
- **Pure YOLO:** no permission prompts, no confirmation gates, no destructive-command
  denylists, no sandbox. Do not add any. The container/VM is the safety boundary.
- **Secrets:** `.env` holds a live key — never commit or print it. Secret redaction happens
  at one chokepoint before anything reaches the model or transcript. **Child `.out` content
  injected by the gather step MUST pass through `redactSecrets` too** — a child can print a
  secret, and its output now flows into the parent's context and transcript.
- **Tool errors are results** fed back to the model — never thrown.
- **Transcript completeness:** `allMessages` keeps every turn. Compaction changes only the
  model's *view* (`contextStrategy`'s output), never the stored record or `FinalState.messages`.
- **The loop stays subagent-agnostic:** `run(messages, tools, policy)` — nothing else enters
  the loop. Registry I/O for child-gather lives behind a policy seam, not in `agent.ts`.
- **Don't drop the load-bearing fact:** compaction keeps every checkpoint summary, so a fact
  ranked at turn 40 survives to turn 400 unless a later checkpoint consciously drops it.
- **The check is `bun test`** from repo root (includes live gateway tests). TDD throughout.

## Mechanism 1 — the strategy checkpoint (Batch 2: items 3 + 4, unified)

One mechanism does both the periodic strategy audit and the rolling evidence compaction.

**Trigger.** Every `strategyCheckpointEvery` turns (new policy knob, default 40; on by
default), the loop injects a checkpoint prompt as a `user` message at the top of the loop
(when `turns > 0 && turns % strategyCheckpointEvery === 0`), then lets the next chat call
answer it. It fires mid-run, so it never replaces the final answer (unlike the completion
audit, which fires at finish — this is why the checkpoint dodges the trivial-task stdout tax:
a short run never reaches turn 40). Injecting a `user` message here is not a new protocol
condition — multi-tool turns already append several `user`-role tool results in a row, and the
gateway is lenient about message shape.

The injected content is `STRATEGY_CHECKPOINT_MARKER` (a fixed, unique sentinel line — a module
constant, the detection anchor) followed by the reflection instructions, roughly:
> "STRATEGY CHECKPOINT — you are N turns in. Restate the goal in one line. Rank your evidence
> strongest-to-weakest. Name the dead leads you are dropping. State the single strongest lead
> you will pursue next."

The turn number `N` is interpolated for the model's benefit; detection keys off
`content.includes(STRATEGY_CHECKPOINT_MARKER)`, never string equality, so the varying number
never breaks it. (Contrast `COMPLETION_AUDIT_PROMPT`, a constant matched by equality — the
checkpoint needs a marker because its text varies.) The model's response is the **checkpoint
summary** — a dense, no-tool assistant message.

**Compaction.** `contextStrategy` (identity today, `policy.ts:11`) becomes a compactor. Given
the full `allMessages`, it returns a view:

```
[ system message(s),
  original task (first user message),
  every COMPLETED prior checkpoint's summary (each a no-tool assistant message),
  everything from the LAST COMPLETED checkpoint's prompt onward (verbatim) ]
```

Raw exploration turns before the last completed checkpoint are dropped from the view; the
ranked-evidence trail (every summary) is kept. `allMessages` is untouched → transcript and
`FinalState` lose nothing.

**"Completed" is the load-bearing word.** A checkpoint prompt injected this turn but not yet
answered is *pending*, not a boundary. This matters because the prompt is injected before
`contextStrategy` runs: if a pending prompt were the cut point, the model would try to "rank
your evidence" with the very evidence compacted away. Anchoring on the last *completed*
checkpoint keeps the pending prompt — and all the raw context it needs — in the verbatim tail.
One turn later, that checkpoint is completed, becomes the new boundary, and its pre-context
collapses. So the view grows with raw turns between checkpoints, then snaps back at each answer.

**Compactor algorithm (pure, unit-testable):**
1. Scan for checkpoint prompts (`user` messages whose content `includes` the marker). Pair each
   with the message immediately after it; a checkpoint is *completed* iff that next message is
   an assistant message with no `tool_calls` (its summary).
2. No *completed* checkpoint → return `messages` unchanged (identity until the first summary lands —
   covers both pre-first-checkpoint and a lone pending first checkpoint).
3. Let `P` = prompt index of the LAST completed checkpoint. `priorSummaries` = the summaries of
   completed checkpoints before `P`.
4. Return `[ ...systemMessages, originalTask, ...priorSummaries, ...messages.slice(P) ]`.

**No orphaned tool calls:** summaries are no-tool assistant messages (safe standalone);
`messages.slice(P)` starts at the last completed checkpoint's `user` prompt (a clean boundary)
and keeps every later tool sequence — and any trailing pending checkpoint — intact; system +
task are clean. A checkpoint whose response used a tool (unexpected — the prompt asks for prose)
never counts as completed, so it is never a boundary and its summary is never hoisted; it stays
raw inside whatever `slice(P)` region contains it.

**Event:** `strategy_checkpoint { event, turn }` (transcript-only; render.ts gets a one-line
`◆ strategy checkpoint (turn N)` for human visibility on long runs).

## Mechanism 2 — honest `blocked` outcome (rest of item 7)

**Seam change:** `isComplete(msg): boolean` → `classifyFinish(msg): 'done' | 'blocked' | 'empty'`.
This generalizes Batch 1's finish gate so one seam owns every finish state.

Default `classifyFinish` (called only on a no-tool assistant message at the finish point):
- empty trimmed content → `'empty'`
- content matching `/^\s*BLOCKED:/i` → `'blocked'`
- otherwise → `'done'`

**Loop routing** (the finish branch in `agent.ts`):
- `'blocked'` → return immediately with `stopReason: 'blocked'`. No completion audit, no
  child-gather — the parent has declared it cannot proceed.
- `'done'` → reset `emptyResponses`; run child-gather (Mechanism 3); then completion audit;
  then `stopReason: 'done'`.
- `'empty'` → `emptyResponses++`; nudge (`EMPTY_RESPONSE_NUDGE`) until `maxEmptyRetries`, then
  `stopReason: 'error'`. (Unchanged from Batch 1, just reached via the classifier.)

**Type:** `FinalState.stopReason` gains `'blocked'`. **Exit code:** `exitCodeForStopReason`
in `index.ts` maps `'blocked'` → nonzero (incomplete run, like `maxTurns`/`error`/`aborted`).

**system.txt:** teach the convention — "If you genuinely cannot proceed (missing
access/credentials, impossible request, no safe default), finish with a single line beginning
`BLOCKED:` and the reason. Never fake a result."

## Mechanism 3 — child results into parent context (Batch 3: item 5)

Children spawn detached and survive the parent's exit. Today the parent gets a `read_file
<outFile>` hint per child and must read each by hand. This makes the gather automatic and
blocks the parent from finishing while it still owes results to children it spawned.

**Seam:** new optional `onFinish(messages: Message[]) => Promise<Message[] | null>`. The loop
awaits it inside the `'done'` branch, before the completion audit:
- returns a non-empty `Message[]` → push them to `allMessages` and `continue` (the model
  incorporates the results, then tries to finish again).
- returns `null`/empty → proceed to the audit, then `done`.

Registry I/O lives in a **new `src/children.ts`**, keeping `agent.ts` subagent-agnostic.

`gatherChildren(messages, opts)` takes its dependencies as an injected options bag —
`deliveredPids: Set<number>`, `waitMs`, `transcriptDir`, `selfPid` — so tests drive it with a
temp registry, a pre-seeded delivered set, and a tiny `waitMs`; no hidden module globals, no
real wall-clock wait. The default `onFinish` in `policy.ts` owns the process-lifetime
`deliveredPids` set and passes it in. (children.ts is ordinary app code, so `Date.now`/`setTimeout`
for the poll are fine here — the no-`Date.now` rule is a workflow-script constraint, not ours.)

**Default `onFinish` (`gatherChildren`) steps:**
1. Read the registry (`agents.jsonl` under `transcriptDir`) and derive states.
2. Select `selfPid`'s **direct, non-detached** children (`parent_pid === selfPid`, record not
   marked `detached`) not in `deliveredPids`, so each child lands exactly once.
3. For any still `running`, wait — poll the registry up to `waitMs` total (`childWaitMs` knob,
   default 300000 ms / 5 min: generous enough for real child work, bounded so a hung child can
   never wedge the parent's finish forever). Emit `awaiting_children`.
4. For each newly-terminal child (done or died), read its `.out` capped at 8000 chars (the same
   `OUTPUT_CAP` tool output uses), pass through `redactSecrets`, and build a `user` message:
   `"Child agent <pid> (task: …) finished [<status>]:\n<result>"`. Emit `child_result`.
5. On timeout for a still-running child, inject `"child <pid> still running, proceeding
   without it"` once, add it to `deliveredPids`, and let the finish go through. Never hang forever.
6. Return the collected messages, or `null` when nothing is pending or new.

**Ordering at finish:** gather children → model re-finishes → completion audit → done. The
audit sees the children's results. `onFinish` returning `null` on the second pass (children
already delivered) prevents an infinite gather loop.

**spawn_agent default = awaited.** New optional `detach: boolean` param (default false). When
true, the spawn record is marked `detached` and `onFinish` ignores that child (true
fire-and-forget). `registry.ts` `AgentSpawnRecord` gains `detached?: boolean`.

**system.txt:** "Children you spawn are gathered automatically when you finish — their results
appear in your context before you complete; you do not need to read their `.out` files by
hand. Use `spawn_agent(detach: true)` only for fire-and-forget work whose result you will not use."

## Type / seam summary

`src/types.ts`:
- `Policy`: remove `isComplete`; add `classifyFinish: (msg: Message) => 'done' | 'blocked' | 'empty'`;
  add `strategyCheckpointEvery?: number`; add `onFinish?: (messages: Message[]) => Promise<Message[] | null>`;
  add `childWaitMs?: number`. `contextStrategy` stays (default becomes the compactor).
- `FinalState.stopReason`: add `'blocked'`.

`src/policy.ts`: default `classifyFinish`; default `contextStrategy` = compactor;
`strategyCheckpointEvery: 40`; `childWaitMs: 300000`; `onFinish` wired to `gatherChildren` and
owning the process-lifetime `deliveredPids` set it passes in.

`src/registry.ts`: `AgentSpawnRecord` gains `detached?: boolean`.

New `src/children.ts`: `gatherChildren(messages, opts)` with all state injected via `opts`
(no module globals).

`src/agent.ts`: `STRATEGY_CHECKPOINT_MARKER` + checkpoint prompt builder; top-of-loop
checkpoint injection; finish branch uses `classifyFinish` + awaits `onFinish` before the audit.

`src/tools.ts`: `spawn_agent` `detach` param → `detached` on the spawn record.

`src/index.ts`: `exitCodeForStopReason('blocked')` → nonzero.

`src/render.ts`: minimal cases for `strategy_checkpoint` and `child_result`.

`system.txt`: BLOCKED convention + children-are-gathered note.

## Testing strategy (TDD; `bun test`)

- **Compactor (pure, `policy.test.ts`):** no checkpoint → identity; a lone *pending* checkpoint
  (prompt, no summary yet) → identity (the raw context it must answer with is preserved); one
  completed checkpoint → drops raw pre-checkpoint turns, keeps system+task+summary+tail; a
  completed checkpoint followed by a fresh pending one → keeps everything from the completed one
  onward (pending prompt + its context intact); multiple completed → keeps every summary; a kept
  region never orphans a `tool_call` from its result.
- **classifyFinish (`policy.test.ts`):** done/blocked/empty for the right inputs incl. `BLOCKED:` prefix, leading whitespace, case.
- **Loop (`agent.test.ts`, fake-client injection):** checkpoint injected at turn N with a small
  `strategyCheckpointEvery` + `strategy_checkpoint` event; a `BLOCKED:` finish → `stopReason
  'blocked'`, no audit turn; `onFinish` returning a message once → inject + continue + then done
  (gather-before-audit ordering); `onFinish` null → straight through.
- **children.ts (new `children.test.ts`):** temp registry + `.out` files → returns results as
  messages; waits for a running child then delivers; timeout path; delivered-once (second call
  → null); a `.out` containing a secret is redacted before injection.
- **exit code:** `exitCodeForStopReason('blocked')` is nonzero.
- Existing live gateway e2e tests stay green. A real spawn→gather integration test (trivial
  fast child) is desirable; keep it timing-tolerant.

## Task decomposition (for writing-plans)

Order matters where the finish branch is shared.

1. **`blocked` + `classifyFinish`** — replace `isComplete`, route the finish branch, add
   `stopReason`/exit code, system.txt BLOCKED line. Foundational: the finish-branch restructure
   that Mechanism 3 builds on. Update Batch 1's tests that reference `isComplete`.
2. **Strategy checkpoint + compaction** — prompt, top-of-loop injection, `strategyCheckpointEvery`,
   compactor `contextStrategy`, event, render. Mostly independent (top-of-loop + contextStrategy).
3. **Child gather** — `children.ts`, `onFinish` seam in the done-branch, `spawn_agent` `detach`
   + registry field, `childWaitMs`, `child_result` event, redaction, system.txt note, render.

Each task: TDD, green suite, its own conventional commit, on branch `feat/attention-and-child-context`.

## Out of scope (rejected or deferred, on purpose)

- No `pin_finding` tool (compaction keeps all summaries instead).
- No `wait_for_agents` tool and no poller-based auto-injection — gather is automatic via `onFinish`.
  The 2-second lifecycle poller stays stderr-only for human visibility.
- No backward-compat shims: `isComplete` is replaced by `classifyFinish`, not dual-pathed.
- Still deferred (pre-existing): Retry-After header honoring, `onToolError: 'nudge'` for `--serious`.
