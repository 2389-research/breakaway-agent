# Long-Run Attention, Child-Context Gather, and the `blocked` Outcome — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fight attention drift on long autonomous runs and close the child-context gap, while giving the agent an honest way to say it is stuck — without touching break-away's tiny, policy-blind loop design.

**Architecture:** Three independent mechanisms, each landing behind an existing or new policy seam so `run(messages, tools, policy)` stays subagent-agnostic. (1) A periodic **strategy checkpoint** injected at the top of the loop, paired with a **rolling-compaction** `contextStrategy` that collapses raw exploration between checkpoints while keeping every checkpoint summary. (2) The `isComplete` finish gate becomes `classifyFinish` returning `'done' | 'blocked' | 'empty'`, so a self-declared `BLOCKED:` finish is an honest nonzero-exit terminal state. (3) A new `onFinish` seam, defaulting to `gatherChildren` in a new `src/children.ts`, pulls finished child-agent results into the parent's context before the parent accepts a finish.

**Tech Stack:** TypeScript on Bun. LLM over an OpenAI-compatible client (`src/client.ts`, lazy env at call time). Tests: `bun test` (Bun's built-in runner, `bun:test`). No new dependencies.

**Spec:** `docs/superpowers/specs/2026-08-31-attention-child-context-and-blocked-design.md` — the plan argues from this spec; executors read both. Two correctness refinements were added to the spec *after* Harper's approval and are called out in the handoff note at the end of this plan.

## Global Constraints

Copied verbatim from the spec's "Global Constraints (bind every task)" section. Every task's requirements implicitly include these. A change that breaks one is wrong even if tests pass.

- **stdout purity (one-shot):** stdout carries the final prose answer ONLY; all progress, stats, and new events go to stderr/transcript. No `console.log` in application code. A `blocked` run's reason rides out as the final assistant message on stdout, then exits nonzero.
- **Pure YOLO:** no permission prompts, no confirmation gates, no destructive-command denylists, no sandbox. Do not add any. The container/VM is the safety boundary.
- **Secrets:** `.env` holds a live key — never commit or print it. Secret redaction happens at one chokepoint before anything reaches the model or transcript. **Child `.out` content injected by the gather step MUST pass through `redactSecrets` too** — a child can print a secret, and its output now flows into the parent's context and transcript.
- **Tool errors are results** fed back to the model — never thrown.
- **Transcript completeness:** `allMessages` keeps every turn. Compaction changes only the model's *view* (`contextStrategy`'s output), never the stored record or `FinalState.messages`.
- **The loop stays subagent-agnostic:** `run(messages, tools, policy)` — nothing else enters the loop. Registry I/O for child-gather lives behind a policy seam, not in `agent.ts`.
- **Don't drop the load-bearing fact:** compaction keeps every checkpoint summary, so a fact ranked at turn 40 survives to turn 400 unless a later checkpoint consciously drops it.
- **The check is `bun test`** from repo root (includes live gateway tests). TDD throughout.

**Branch:** all three tasks commit to `feat/attention-and-child-context` (already checked out). Each task is one conventional commit. Never `git add -A`; run `git status` first, then add the explicit files.

---

## Task 1: `blocked` outcome + `classifyFinish` seam

Replace the boolean `isComplete` finish gate with a tri-state `classifyFinish` returning `'done' | 'blocked' | 'empty'`, route the finish branch on it, add the `'blocked'` stop reason and its nonzero exit, teach the model the `BLOCKED:` convention, and update Batch 1's tests and docs that reference `isComplete`. This is foundational: it restructures the finish branch that Task 3 extends.

**Files:**
- Modify: `src/types.ts` (Policy: replace `isComplete` with `classifyFinish`; `FinalState.stopReason`: add `'blocked'`)
- Modify: `src/policy.ts:12-15` (replace the `isComplete` default with `classifyFinish`)
- Modify: `src/agent.ts:226-269` (replace the finish branch with tri-state routing)
- Modify: `src/index.ts:80-82` and `src/index.ts:331` (add `statusForStopReason`, use it)
- Modify: `system.txt` (add the `BLOCKED:` convention to Failure Handling)
- Modify: `AGENTS.md:26` and `gotchas.md:39-40` (rename-safety + a new gotcha)
- Test: `tests/policy.test.ts` (rewrite the six `isComplete` tests as `classifyFinish` tests; fix line 91)
- Test: `tests/agent.test.ts` (add a blocked-finish describe block)
- Test: `tests/exit-code.test.ts` (add blocked exit + `statusForStopReason` block)

**Interfaces:**
- Consumes: `Message`, `FinalState` (from `src/types.ts`); the existing loop structure in `src/agent.ts`.
- Produces:
  - `Policy.classifyFinish: (lastMessage: Message) => 'done' | 'blocked' | 'empty'` (replaces `Policy.isComplete`)
  - `FinalState.stopReason` union now includes `'blocked'`
  - `statusForStopReason(stopReason: FinalState['stopReason']) => 'ok' | 'error'` exported from `src/index.ts`
  - Loop contract: a no-tool assistant message whose content starts with `BLOCKED:` ends the run with `stopReason: 'blocked'`, no completion audit.

- [ ] **Step 1: Write the failing `classifyFinish` policy tests**

In `tests/policy.test.ts`, replace the existing six `isComplete` tests (the `test('...isComplete...')` cases) with this block:

```typescript
  test('classifyFinish returns done for a real finish — assistant, content, no tool calls', () => {
    const msg: Message = { role: 'assistant', content: 'here is the answer' };
    expect(defaultPolicy.classifyFinish(msg)).toBe('done');
  });

  test('classifyFinish returns empty for a blank finish — whitespace is not an answer', () => {
    const msg: Message = { role: 'assistant', content: '   ' };
    expect(defaultPolicy.classifyFinish(msg)).toBe('empty');
  });

  test('classifyFinish returns empty when tool calls are still pending', () => {
    const msg: Message = {
      role: 'assistant',
      content: '',
      tool_calls: [{ id: 'tc1', type: 'function', function: { name: 'bash', arguments: '{}' } }],
    };
    expect(defaultPolicy.classifyFinish(msg)).toBe('empty');
  });

  test('classifyFinish returns empty for a non-assistant message', () => {
    const msg: Message = { role: 'user', content: 'hi' };
    expect(defaultPolicy.classifyFinish(msg)).toBe('empty');
  });

  test('classifyFinish returns done with an empty tool_calls array when content is present', () => {
    const msg: Message = { role: 'assistant', content: 'done', tool_calls: [] };
    expect(defaultPolicy.classifyFinish(msg)).toBe('done');
  });

  test('classifyFinish returns blocked for a BLOCKED: line', () => {
    const msg: Message = { role: 'assistant', content: 'BLOCKED: no AWS credentials in this environment' };
    expect(defaultPolicy.classifyFinish(msg)).toBe('blocked');
  });

  test('classifyFinish detects BLOCKED case-insensitively and after leading whitespace', () => {
    const msg: Message = { role: 'assistant', content: '   blocked: cannot reach the database' };
    expect(defaultPolicy.classifyFinish(msg)).toBe('blocked');
  });
```

Also update the inheritance assertion (currently `expect(seriousPolicy.isComplete).toBe(defaultPolicy.isComplete)`, around line 91) to:

```typescript
    expect(seriousPolicy.classifyFinish).toBe(defaultPolicy.classifyFinish);
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun test tests/policy.test.ts -t "classifyFinish"`
Expected: FAIL — `defaultPolicy.classifyFinish is not a function` (the seam does not exist yet).

- [ ] **Step 3: Add `classifyFinish` to the Policy type and drop `isComplete`**

In `src/types.ts`, replace the `isComplete` field (lines 39-41):

```typescript
  // Accept this no-tool message as a finished run? Default: assistant role, no tool calls, and
  // non-empty content. A blank finish fails the gate, so "no tool calls" alone never means done.
  isComplete: (lastMessage: Message) => boolean;
```

with:

```typescript
  // Classify a no-tool finish attempt: 'done' = a real answer; 'blocked' = the model declared it
  // cannot proceed (a line beginning BLOCKED:); 'empty' = a blank turn that is not an answer.
  // One seam owns every finish state — "no tool calls" alone never means done.
  classifyFinish: (lastMessage: Message) => 'done' | 'blocked' | 'empty';
```

- [ ] **Step 4: Add `'blocked'` to the `FinalState.stopReason` union**

In `src/types.ts`, change line 60:

```typescript
  stopReason: 'done' | 'maxTurns' | 'aborted' | 'error';
```

to:

```typescript
  stopReason: 'done' | 'maxTurns' | 'aborted' | 'error' | 'blocked';
```

- [ ] **Step 5: Implement the default `classifyFinish` in policy.ts**

In `src/policy.ts`, replace the `isComplete` default (lines 12-15):

```typescript
  // A finish must be a real answer: assistant role, no pending tool calls, non-empty content.
  // A blank no-tool response fails this gate, so it can never be mistaken for a completed run.
  isComplete: (msg: Message) =>
    msg.role === 'assistant' && !msg.tool_calls?.length && (msg.content ?? '').trim() !== '',
```

with:

```typescript
  // A finish must be a real answer, an honest block, or a blank. A blank no-tool response is
  // 'empty' (never 'done'); a line beginning BLOCKED: is an honest terminal state.
  classifyFinish: (msg: Message): 'done' | 'blocked' | 'empty' => {
    if (msg.role !== 'assistant' || msg.tool_calls?.length) return 'empty';
    const content = (msg.content ?? '').trim();
    if (content === '') return 'empty';
    if (/^BLOCKED:/i.test(content)) return 'blocked';
    return 'done';
  },
```

- [ ] **Step 6: Run the policy tests to verify they pass**

Run: `bun test tests/policy.test.ts`
Expected: PASS (all `classifyFinish` cases green; the existing `contextStrategy` and `selectPolicy` tests still green).

- [ ] **Step 7: Write the failing blocked-finish loop test**

In `tests/agent.test.ts`, add this describe block:

```typescript
describe('agent run — blocked finish', () => {
  test('a BLOCKED: finish returns stopReason blocked with no audit turn', async () => {
    mockChat.mockResolvedValueOnce({
      message: { role: 'assistant', content: 'BLOCKED: missing database credentials' },
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      finish_reason: 'stop',
    });

    // completionAudit ON to prove a block short-circuits it — there must be no second chat call.
    const state = await run(initialMessages(), [], makePolicy({ completionAudit: true }));
    expect(state.stopReason).toBe('blocked');
    expect(state.turns).toBe(1);
    expect(mockChat).toHaveBeenCalledTimes(1);
  });
});
```

- [ ] **Step 8: Run the loop test to verify it fails**

Run: `bun test tests/agent.test.ts -t "blocked finish"`
Expected: FAIL — the loop still calls `policy.isComplete` (now undefined) and does not know `'blocked'`. It may throw or return the wrong stop reason.

- [ ] **Step 9: Rewrite the finish branch in agent.ts to route on `classifyFinish`**

In `src/agent.ts`, replace the whole finish section (lines 226-269, from the `// No tool calls` comment through the final `continue;` before the loop's closing brace) with:

```typescript
    // No tool calls — the model is trying to finish. Classify the finish state.
    const finish = policy.classifyFinish(response.message);

    if (finish === 'blocked') {
      // The model has declared it cannot proceed. Honest terminal state: no audit, no gather —
      // the single BLOCKED: line rides out as the final assistant message and the run exits nonzero.
      return {
        messages: allMessages,
        turns,
        usage,
        elapsed: Date.now() - start,
        stopReason: 'blocked',
      };
    }

    if (finish === 'done') {
      // A real answer clears any prior blank streak.
      emptyResponses = 0;
      // Completion audit: give the model exactly one enforced chance to verify before we accept
      // a no-tool finish as done. Only fire when at least one more turn of budget remains
      // (turns < maxTurns - 1) so the injected audit turn can actually run; at an explicit
      // ceiling we accept the finish instead of injecting a prompt no turn would answer.
      // With no turn limit (the default) maxTurns is Infinity, so this always fires once.
      if (
        policy.completionAudit &&
        !completionAuditTriggered &&
        turns < policy.maxTurns - 1
      ) {
        completionAuditTriggered = true;
        emitEvent(policy, { event: 'completion_audit', turn: turns });
        allMessages.push({ role: 'user', content: COMPLETION_AUDIT_PROMPT });
        continue;
      }
      return {
        messages: allMessages,
        turns,
        usage,
        elapsed: Date.now() - start,
        stopReason: 'done',
      };
    }

    // finish === 'empty': a blank response — no tool calls and empty content. "No tool calls"
    // alone must never count as success. Nudge the model to act or give a real answer; after
    // maxEmptyRetries consecutive blanks, end honestly with 'error' instead of a false 'done'.
    emptyResponses++;
    if (emptyResponses > (policy.maxEmptyRetries ?? 1)) {
      return {
        messages: allMessages,
        turns,
        usage,
        elapsed: Date.now() - start,
        stopReason: 'error',
      };
    }
    emitEvent(policy, { event: 'empty_response', turn: turns, attempt: emptyResponses });
    allMessages.push({ role: 'user', content: EMPTY_RESPONSE_NUDGE });
    continue;
```

- [ ] **Step 10: Run the loop tests to verify they pass**

Run: `bun test tests/agent.test.ts`
Expected: PASS — the blocked-finish test is green, and the existing completion-audit / empty-response / done tests still pass (the routing preserves their behavior).

- [ ] **Step 11: Write the failing exit-code and status tests**

In `tests/exit-code.test.ts`, update the import to include `statusForStopReason`:

```typescript
import { exitCodeForStopReason, statusForStopReason } from '../src/index.ts';
```

Add a blocked exit-code case to the existing describe, and a new describe for `statusForStopReason`:

```typescript
  test('a blocked run exits nonzero — the agent declared it could not proceed', () => {
    expect(exitCodeForStopReason('blocked')).not.toBe(0);
  });

describe('statusForStopReason', () => {
  test('a completed run is ok', () => {
    expect(statusForStopReason('done')).toBe('ok');
  });
  test('a blocked run is error — not a green success', () => {
    expect(statusForStopReason('blocked')).toBe('error');
  });
  test('an errored run is error', () => {
    expect(statusForStopReason('error')).toBe('error');
  });
  test('an aborted run is error', () => {
    expect(statusForStopReason('aborted')).toBe('error');
  });
  test('hitting the turn cap records ok status — incomplete but not a crash', () => {
    expect(statusForStopReason('maxTurns')).toBe('ok');
  });
});
```

(The `describe` line closing brace: place the new `describe` after the existing one's closing `});`. The single blocked exit-code `test` goes inside the existing `describe('exitCodeForStopReason', ...)` block.)

- [ ] **Step 12: Run the exit-code tests to verify they fail**

Run: `bun test tests/exit-code.test.ts`
Expected: FAIL — `statusForStopReason` is not exported yet.

- [ ] **Step 13: Add `statusForStopReason` in index.ts and use it**

In `src/index.ts`, add this function directly after `exitCodeForStopReason` (after line 82):

```typescript
// Map a stop reason to the coarse ok/error status recorded in the registry. Only a clean finish
// and an incomplete-but-not-crashed cap are 'ok'; error, abort, and a self-declared block are
// 'error'. Ruling: 'blocked' is 'error' here — a blocked child must never read as green to its
// parent, even though the full stop_reason is recorded alongside for the honest detail.
export function statusForStopReason(stopReason: FinalState['stopReason']): 'ok' | 'error' {
  return stopReason === 'error' || stopReason === 'aborted' || stopReason === 'blocked'
    ? 'error'
    : 'ok';
}
```

Then replace the inline derivation at line 331:

```typescript
  const agentDoneStatus: 'ok' | 'error' = (state.stopReason === 'error' || state.stopReason === 'aborted') ? 'error' : 'ok';
```

with:

```typescript
  const agentDoneStatus = statusForStopReason(state.stopReason);
```

- [ ] **Step 14: Run the exit-code tests to verify they pass**

Run: `bun test tests/exit-code.test.ts`
Expected: PASS.

- [ ] **Step 15: Teach the `BLOCKED:` convention in system.txt**

In `system.txt`, in the "Failure Handling" section, after the existing line that ends `If blocked by something genuinely outside the machine…` (around line 335), add a new paragraph:

```
When you genuinely cannot proceed — missing access or credentials, an impossible
request, no safe default — finish with a single line that begins `BLOCKED:` followed
by the reason. This ends the run honestly with a nonzero exit. Never fake a result or
report success you did not achieve. A `BLOCKED:` line is only for a true dead end, not
a hard step you have not tried yet.
```

- [ ] **Step 16: Update `isComplete` references in AGENTS.md and gotchas.md (rename safety)**

In `AGENTS.md`, line 26, replace:

```
  `contextStrategy`, `isComplete` (is this no-tool message a real finish? default:
```

with:

```
  `contextStrategy`, `classifyFinish` (is this no-tool message `done`, `blocked`, or
  `empty`? default:
```

In `gotchas.md`, line 39, replace `non-empty content — \`isComplete\` true)` with `non-empty content — \`classifyFinish\` returns \`'done'\`)`.

In `gotchas.md`, line 40, replace the two `isComplete` mentions:
- `the \`isComplete\` seam gates completion` → `the \`classifyFinish\` seam gates completion`
- `only when \`policy.isComplete(msg)\` is true; \`defaultPolicy.isComplete\` is \`assistant role && no tool_calls && content.trim() !== ''\`` → `only when \`policy.classifyFinish(msg)\` returns \`'done'\`; \`defaultPolicy.classifyFinish\` returns \`'done'\` for \`assistant role && no tool_calls && content.trim() !== ''\``
- `\`isComplete\` replaced the old \`shouldContinue\` seam` → `\`classifyFinish\` (which replaced \`isComplete\`, itself replacing the old dead \`shouldContinue\` seam)`

Then add a new gotcha entry at the end of `gotchas.md`:

```
- **A self-declared `BLOCKED:` finish is an honest nonzero terminal state.** The finish gate is `classifyFinish(msg): 'done' | 'blocked' | 'empty'` (it replaced the boolean `isComplete`). A no-tool assistant message whose trimmed content starts with `BLOCKED:` (case-insensitive) returns `stopReason: 'blocked'` immediately — no completion audit, no child-gather — so the reason rides out on stdout and the process exits nonzero. `statusForStopReason` in `index.ts` maps `blocked` (and `error`/`aborted`) to registry status `error`, so a blocked child never reads as green to its parent; the full `stop_reason` is still recorded alongside. `system.txt` teaches the convention. The point: give the model an honest exit so it stops faking success on a true dead end.
```

- [ ] **Step 17: Run the full suite**

Run: `bun test`
Expected: PASS — full green suite. If any Batch 1 test still references `isComplete`, fix it to `classifyFinish` (the grep in the next step catches stragglers).

- [ ] **Step 18: Confirm no stray `isComplete` references remain in code**

Run: `grep -rn "isComplete" src tests`
Expected: no output. (Doc mentions in `AGENTS.md`/`gotchas.md` are already updated; a lingering match in `src` or `tests` is a miss — fix it.)

- [ ] **Step 19: Commit**

```bash
git status
git add src/types.ts src/policy.ts src/agent.ts src/index.ts system.txt AGENTS.md gotchas.md tests/policy.test.ts tests/agent.test.ts tests/exit-code.test.ts
git commit -m "feat(agent): honest blocked outcome via classifyFinish seam"
```

---

## Task 2: strategy checkpoint + rolling evidence compaction

Inject a reflection prompt every `strategyCheckpointEvery` turns (default 40) at the top of the loop, skip the finish classifier for the checkpoint answer, and make the default `contextStrategy` a compactor that collapses raw exploration before the last completed checkpoint while keeping every checkpoint summary. Add the `strategy_checkpoint` event and its render line.

**Files:**
- Modify: `src/agent.ts` (add `STRATEGY_CHECKPOINT_MARKER` + `strategyCheckpointPrompt`; top-of-loop injection; skip-finish guard)
- Modify: `src/types.ts` (Policy: add `strategyCheckpointEvery?`)
- Modify: `src/policy.ts` (import the marker; add `compactByCheckpoints`; set defaults)
- Modify: `src/render.ts` (add a `strategy_checkpoint` case)
- Modify: `AGENTS.md` and `gotchas.md` (document the knob + compactor)
- Test: `tests/policy.test.ts` (add a `compactByCheckpoints` describe block)
- Test: `tests/agent.test.ts` (add a checkpoint-injection describe block; extend the dynamic import)
- Test: `tests/render.test.ts` (add a `strategy_checkpoint` describe block)

**Interfaces:**
- Consumes: `Message`, `Policy` (from `src/types.ts`); `emitEvent`, the loop body (from `src/agent.ts`); the render helpers `CYAN/BOLD/RESET` (from `src/render.ts`).
- Produces:
  - `STRATEGY_CHECKPOINT_MARKER: string` exported from `src/agent.ts` (the detection sentinel; `content.includes(...)`, never equality)
  - `Policy.strategyCheckpointEvery?: number` (default 40; 0/undefined disables)
  - `compactByCheckpoints(messages: Message[]) => Message[]` exported from `src/policy.ts` — pure, returns a VIEW, never mutates its input; identity until the first completed checkpoint
  - Event `{ event: 'strategy_checkpoint', turn: number }`

- [ ] **Step 1: Write the failing compactor tests**

In `tests/policy.test.ts`, extend the imports to include the compactor and the marker:

```typescript
import { defaultPolicy, seriousPolicy, selectPolicy, compactByCheckpoints } from '../src/policy.ts';
import { STRATEGY_CHECKPOINT_MARKER } from '../src/agent.ts';
```

Add this describe block:

```typescript
describe('compactByCheckpoints — rolling evidence compaction', () => {
  const sys: Message = { role: 'system', content: 'sys' };
  const task: Message = { role: 'user', content: 'the original task' };
  const cp = (n: number): Message => ({ role: 'user', content: `${STRATEGY_CHECKPOINT_MARKER}\nturn ${n}` });
  const summary = (s: string): Message => ({ role: 'assistant', content: s });
  const toolCall: Message = {
    role: 'assistant',
    content: '',
    tool_calls: [{ id: 'tc', type: 'function', function: { name: 'bash', arguments: '{}' } }],
  };
  const toolResult: Message = { role: 'tool', content: 'ran', tool_call_id: 'tc', name: 'bash' };

  test('no checkpoint → identity (same array reference)', () => {
    const msgs = [sys, task, toolCall, toolResult];
    expect(compactByCheckpoints(msgs)).toBe(msgs);
  });

  test('a lone pending checkpoint (no summary yet) → identity, so its raw context survives', () => {
    const msgs = [sys, task, toolCall, toolResult, cp(2)];
    expect(compactByCheckpoints(msgs)).toBe(msgs);
  });

  test('one completed checkpoint → drops raw pre-checkpoint turns, keeps system+task+tail', () => {
    const working: Message = { role: 'assistant', content: 'still working' };
    const msgs = [sys, task, toolCall, toolResult, cp(2), summary('S2'), working];
    const view = compactByCheckpoints(msgs);
    expect(view).toEqual([sys, task, cp(2), summary('S2'), working]);
    expect(view).not.toContain(toolResult); // the raw pre-checkpoint tool pair is gone from the view
  });

  test('completed checkpoint followed by a fresh pending one → keeps everything from the completed one on', () => {
    const work: Message = { role: 'assistant', content: 'work' };
    const msgs = [sys, task, toolCall, toolResult, cp(2), summary('S2'), work, cp(4)];
    const view = compactByCheckpoints(msgs);
    expect(view).toEqual([sys, task, cp(2), summary('S2'), work, cp(4)]);
  });

  test('multiple completed checkpoints → keeps every summary (the evidence trail)', () => {
    const more: Message = { role: 'assistant', content: 'more' };
    const msgs = [sys, task, cp(2), summary('S2'), toolCall, toolResult, cp(4), summary('S4'), more];
    const view = compactByCheckpoints(msgs);
    expect(view).toEqual([sys, task, summary('S2'), cp(4), summary('S4'), more]);
  });

  test('a kept region never orphans a tool result from its call', () => {
    const msgs = [sys, task, cp(2), summary('S2'), toolCall, toolResult];
    const view = compactByCheckpoints(msgs);
    const idxCall = view.indexOf(toolCall);
    const idxResult = view.indexOf(toolResult);
    expect(idxCall).toBeGreaterThanOrEqual(0);
    expect(idxResult).toBe(idxCall + 1);
  });
});
```

- [ ] **Step 2: Run the compactor tests to verify they fail**

Run: `bun test tests/policy.test.ts -t "compactByCheckpoints"`
Expected: FAIL — `compactByCheckpoints` is not exported, and `STRATEGY_CHECKPOINT_MARKER` is not exported from agent.ts yet (import error).

- [ ] **Step 3: Add the marker and prompt builder to agent.ts**

In `src/agent.ts`, after the `EMPTY_RESPONSE_NUDGE` constant (after line 20), add:

```typescript
// A fixed, unique sentinel line that marks a strategy-checkpoint prompt. Detection keys off
// content.includes(STRATEGY_CHECKPOINT_MARKER) (never equality), so the interpolated turn number
// in the prompt body never breaks detection. The compactor (policy.ts) uses this to find checkpoints.
export const STRATEGY_CHECKPOINT_MARKER = '=== STRATEGY CHECKPOINT ===';

// The checkpoint prompt: a mid-run reflection that re-focuses the model and gives the compactor a
// boundary. The turn number is for the model's benefit only; detection ignores it.
function strategyCheckpointPrompt(turn: number): string {
  return (
    `${STRATEGY_CHECKPOINT_MARKER}\n` +
    `You are ${turn} turns into this task. Pause and re-focus:\n` +
    `1. Restate the goal in one line.\n` +
    `2. Rank your evidence so far, strongest to weakest.\n` +
    `3. Name the dead leads you are dropping.\n` +
    `4. State the single strongest lead you will pursue next.\n` +
    `Answer in prose only — do not call a tool this turn.`
  );
}
```

- [ ] **Step 4: Add the `strategyCheckpointEvery` knob to the Policy type**

In `src/types.ts`, inside the `Policy` type (after the `completionAudit?` field, before the closing `};` at line 53), add:

```typescript
  // Every N turns, inject a strategy-checkpoint prompt so a long run re-focuses and its evidence
  // trail gets a compaction anchor. 0 or undefined disables it. Default 40.
  strategyCheckpointEvery?: number;
```

- [ ] **Step 5: Implement `compactByCheckpoints` in policy.ts and wire the defaults**

In `src/policy.ts`, add the marker import at the top (after the existing type import on line 4):

```typescript
import { STRATEGY_CHECKPOINT_MARKER } from './agent.ts';
```

Add the compactor function (below the imports, above `defaultPolicy`):

```typescript
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
    if (m.role === 'user' && (m.content ?? '').includes(STRATEGY_CHECKPOINT_MARKER)) {
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
```

Then change the `defaultPolicy.contextStrategy` (line 11) from:

```typescript
  contextStrategy: (messages: Message[]) => messages,
```

to:

```typescript
  contextStrategy: compactByCheckpoints,
```

And add the checkpoint cadence to `defaultPolicy` (after the `completionAudit: true,` line, before the closing `};`):

```typescript
  // Re-focus + compaction anchor every 40 turns; a short run never reaches it, so trivial tasks pay nothing.
  strategyCheckpointEvery: 40,
```

- [ ] **Step 6: Run the compactor tests to verify they pass**

Run: `bun test tests/policy.test.ts`
Expected: PASS — the `compactByCheckpoints` block is green. The existing `contextStrategy` identity/preserve tests (lines 17-35) stay green: with no checkpoint marker, the compactor returns the same array reference.

- [ ] **Step 7: Write the failing checkpoint-injection loop test**

In `tests/agent.test.ts`, extend the dynamic import (line 18) to also pull the marker:

```typescript
const { run, STRATEGY_CHECKPOINT_MARKER } = await import('../src/agent.ts');
```

Add this describe block:

```typescript
describe('agent run — strategy checkpoint', () => {
  test('injects a checkpoint every strategyCheckpointEvery turns and does not finish on the answer', async () => {
    const toolResp = {
      message: {
        role: 'assistant' as const,
        content: '',
        tool_calls: [{ id: 'tc', type: 'function' as const, function: { name: 'my_tool', arguments: '{}' } }],
      },
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      finish_reason: 'tool_calls' as const,
    };
    // Turns 1-2: tool-calling work (so the run doesn't finish before the checkpoint fires at turn 2).
    // Turn 3 = the checkpoint answer (prose, skipped as a finish). Turn 4 = the real finish.
    mockChat
      .mockResolvedValueOnce(toolResp)
      .mockResolvedValueOnce(toolResp)
      .mockResolvedValueOnce({
        message: { role: 'assistant', content: 'Goal: X. Evidence ranked. Next: Y.' },
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        finish_reason: 'stop',
      })
      .mockResolvedValueOnce({
        message: { role: 'assistant', content: 'final answer' },
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        finish_reason: 'stop',
      });

    const events: Record<string, unknown>[] = [];
    const policy = makePolicy({
      strategyCheckpointEvery: 2,
      onEvent: (e) => events.push(e),
      contextStrategy: (m) => m, // isolate injection from compaction in this test
    });
    const state = await run(initialMessages(), [makeTool('my_tool')], policy);

    // The checkpoint answer (turn 3) did NOT end the run; the real finish (turn 4) did.
    expect(state.stopReason).toBe('done');
    expect(state.turns).toBe(4);

    const cpEvents = events.filter((e) => e.event === 'strategy_checkpoint');
    expect(cpEvents.length).toBe(1);
    expect(cpEvents[0].turn).toBe(2);

    const injected = state.messages.find(
      (m) => m.role === 'user' && String(m.content).includes(STRATEGY_CHECKPOINT_MARKER),
    );
    expect(injected).toBeDefined();
  });
});
```

- [ ] **Step 8: Run the loop test to verify it fails**

Run: `bun test tests/agent.test.ts -t "strategy checkpoint"`
Expected: FAIL — no checkpoint is injected yet, so the run finishes on turn 3 (the prose answer) with no `strategy_checkpoint` event.

- [ ] **Step 9: Add the top-of-loop injection and the skip-finish guard in agent.ts**

In `src/agent.ts`, replace the loop opening (lines 141-142):

```typescript
  while (turns < policy.maxTurns) {
    const contextMessages = policy.contextStrategy(allMessages);
```

with:

```typescript
  while (turns < policy.maxTurns) {
    // Strategy checkpoint: every strategyCheckpointEvery turns, inject a reflection prompt at the
    // top of the loop (before contextStrategy) so the run re-focuses and the compactor gets an
    // anchor. Fires only mid-run (turns > 0), so a short task never pays for it.
    let injectedCheckpoint = false;
    const checkpointEvery = policy.strategyCheckpointEvery ?? 0;
    if (checkpointEvery > 0 && turns > 0 && turns % checkpointEvery === 0) {
      emitEvent(policy, { event: 'strategy_checkpoint', turn: turns });
      allMessages.push({ role: 'user', content: strategyCheckpointPrompt(turns) });
      injectedCheckpoint = true;
    }

    const contextMessages = policy.contextStrategy(allMessages);
```

Then, in the same file, insert the skip-finish guard immediately before the `// No tool calls — the model is trying to finish. Classify the finish state.` comment (added in Task 1). The result should read:

```typescript
    // A checkpoint answer is reflection, not a completion: the model's no-tool summary would
    // otherwise read as 'done' and end the run right after every checkpoint. Skip the finish
    // classifier for it and keep working. (A checkpoint answered with a tool call already took the
    // tool branch above.) A BLOCKED: answer here is likewise deferred one turn — the model re-blocks.
    if (injectedCheckpoint) {
      continue;
    }

    // No tool calls — the model is trying to finish. Classify the finish state.
    const finish = policy.classifyFinish(response.message);
```

- [ ] **Step 10: Run the loop tests to verify they pass**

Run: `bun test tests/agent.test.ts`
Expected: PASS — the checkpoint test is green (fires once at turn 2, run ends `done` at turn 4), and every existing loop test still passes.

- [ ] **Step 11: Write the failing render test**

In `tests/render.test.ts`, add:

```typescript
describe('render — strategy_checkpoint', () => {
  test('rich: shows the checkpoint turn', () => {
    const out = collect({ event: 'strategy_checkpoint', turn: 40 }, RICH);
    expect(out).toContain('strategy checkpoint');
    expect(out).toContain('40');
  });

  test('quiet: omits the checkpoint line', () => {
    const out = collect({ event: 'strategy_checkpoint', turn: 40 }, QUIET);
    expect(out).toBe('');
  });
});
```

- [ ] **Step 12: Run the render test to verify it fails**

Run: `bun test tests/render.test.ts -t "strategy_checkpoint"`
Expected: FAIL — the event hits the silent `default` case, so rich output is `''` and the `toContain` assertions fail.

- [ ] **Step 13: Add the `strategy_checkpoint` render case**

In `src/render.ts`, add this case to the `switch` (place it before the `default:` case):

```typescript
    case 'strategy_checkpoint': {
      if (config.tier === 'quiet') return;
      const turn = event.turn as number;
      writer(`${CYAN(config)}${BOLD(config)}◆ strategy checkpoint (turn ${turn})${RESET(config)}\n`);
      return;
    }
```

- [ ] **Step 14: Run the render test to verify it passes**

Run: `bun test tests/render.test.ts`
Expected: PASS.

- [ ] **Step 15: Document the checkpoint + compactor**

In `AGENTS.md`, in the `src/policy.ts` bullet (around lines 25-31), add a sentence after the `completionAudit` clause:

```
  `strategyCheckpointEvery` (inject a re-focus prompt every N turns, default 40) drives
  the default `contextStrategy` = `compactByCheckpoints`, which collapses raw exploration
  before the last completed checkpoint while keeping every checkpoint summary (the view
  only — `allMessages` and the transcript keep every turn).
```

Add a new gotcha entry at the end of `gotchas.md`:

```
- **Long runs re-focus and compact on a checkpoint cadence — the summary is NOT a finish.** Every `strategyCheckpointEvery` turns (default 40; `turns > 0 && turns % every === 0`) the loop injects a `user` reflection prompt at the top of the loop, tagged with `STRATEGY_CHECKPOINT_MARKER`. The model's no-tool answer to it would otherwise read as `done` and end the run right after every checkpoint, so the loop sets an `injectedCheckpoint` flag that turn and skips the finish classifier (`if (injectedCheckpoint) continue;`) — a truly-finished model just finishes one turn later. The default `contextStrategy` is now `compactByCheckpoints`: it returns a VIEW `[system, task, ...prior checkpoint summaries, ...from the last COMPLETED checkpoint onward]`, dropping raw pre-checkpoint turns but keeping every summary (the ranked-evidence trail). "Completed" is load-bearing: a checkpoint injected this turn but not yet answered is pending, so its raw context stays in the verbatim tail until the answer lands. The compactor is pure — `allMessages` and `FinalState.messages` keep every turn. Detection uses `content.includes(marker)`, never equality, because the prompt interpolates the turn number.
```

- [ ] **Step 16: Run the full suite**

Run: `bun test`
Expected: PASS — full green suite.

- [ ] **Step 17: Commit**

```bash
git status
git add src/agent.ts src/types.ts src/policy.ts src/render.ts AGENTS.md gotchas.md tests/policy.test.ts tests/agent.test.ts tests/render.test.ts
git commit -m "feat(agent): periodic strategy checkpoint + rolling evidence compaction"
```

---

## Task 3: child results into parent context

Add an `onFinish` policy seam awaited inside the `'done'` branch (before the completion audit). Its default is `gatherChildren` in a new `src/children.ts`, which reads the agent registry, waits (bounded) for still-running direct children, and injects each finished child's redacted output as a `user` message so the parent incorporates the work before finishing. Add a `detach` param to `spawn_agent` (default false = gathered) and a `detached?` field to the spawn record, plus `child_result`/`awaiting_children` render cases.

**Files:**
- Create: `src/children.ts` (`gatherChildren` + `GatherOpts`)
- Modify: `src/types.ts` (Policy: add `onFinish?` and `childWaitMs?`)
- Modify: `src/policy.ts` (import `gatherChildren` + `defaultTranscriptDir`; wire the default `onFinish` + `childWaitMs` + the process-lifetime `deliveredPids` set)
- Modify: `src/agent.ts` (await `onFinish` inside the `'done'` branch, before the audit)
- Modify: `src/registry.ts:9-17` (`AgentSpawnRecord` gains `detached?: boolean`)
- Modify: `src/tools.ts:340-347` and `:379-387` (`spawn_agent` `detach` param → `detached` on the record)
- Modify: `src/render.ts` (add `child_result` and `awaiting_children` cases)
- Modify: `system.txt` (children-are-gathered note)
- Modify: `README.md`, `AGENTS.md`, `gotchas.md` (document the gather + `detach`)
- Test: `tests/children.test.ts` (new — temp registry + `.out` files)
- Test: `tests/agent.test.ts` (add an `onFinish` describe block)
- Test: `tests/registry.test.ts` (add a `detached` round-trip test)

**Interfaces:**
- Consumes: `Message` (`src/types.ts`); `readRegistry`, `deriveAgentStates`, `AgentSpawnRecord` (`src/registry.ts`); `redactSecrets` (`src/redact.ts`); `defaultTranscriptDir` (`src/transcript.ts`); `emitEvent` and the `'done'` branch from Task 1 (`src/agent.ts`).
- Produces:
  - `GatherOpts` = `{ selfPid: number; transcriptDir: string; deliveredPids: Set<number>; waitMs: number; emit: (event: Record<string, unknown>) => void; pollMs?: number }`
  - `gatherChildren(messages: Message[], opts: GatherOpts) => Promise<Message[] | null>` exported from `src/children.ts`
  - `Policy.onFinish?: (messages: Message[], emit: (event: Record<string, unknown>) => void) => Promise<Message[] | null>`
  - `Policy.childWaitMs?: number` (default 300000)
  - `AgentSpawnRecord.detached?: boolean`
  - `spawn_agent` gains an optional `detach: boolean` param (default false)
  - Events `{ event: 'child_result', pid, task, status }` and `{ event: 'awaiting_children', pids }`

- [ ] **Step 1: Add the `detached` field and write its failing round-trip test**

In `tests/registry.test.ts`, add (following the file's existing temp-dir pattern — reuse its `registryPath`/`tmpDir` setup):

```typescript
test('agent_spawn round-trips the detached flag', async () => {
  await appendRecord(registryPath, {
    event: 'agent_spawn', pid: 7, parent_pid: 1, task: 't', out: '/o', err: '/e', ts: 'ts', detached: true,
  });
  const recs = await readRegistry(registryPath);
  const spawn = recs.find((r) => r.event === 'agent_spawn') as AgentSpawnRecord;
  expect(spawn.detached).toBe(true);
});
```

If `AgentSpawnRecord` is not already imported in the test file, add it to the `../src/registry.ts` import.

- [ ] **Step 2: Run the registry test to verify it fails**

Run: `bun test tests/registry.test.ts -t "detached"`
Expected: FAIL — TypeScript rejects `detached` on `AgentSpawnRecord` (the field does not exist).

- [ ] **Step 3: Add `detached?` to `AgentSpawnRecord`**

In `src/registry.ts`, change the `AgentSpawnRecord` type (lines 9-17) to add the field:

```typescript
export type AgentSpawnRecord = {
  event: 'agent_spawn';
  pid: number;
  parent_pid: number;
  task: string;
  out: string;
  err: string;
  ts: string;
  detached?: boolean; // fire-and-forget: onFinish will not gather this child
};
```

- [ ] **Step 4: Run the registry test to verify it passes**

Run: `bun test tests/registry.test.ts`
Expected: PASS.

- [ ] **Step 5: Write the failing `children.ts` tests**

Create `tests/children.test.ts`:

```typescript
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
```

- [ ] **Step 6: Run the children tests to verify they fail**

Run: `bun test tests/children.test.ts`
Expected: FAIL — `src/children.ts` does not exist (import error).

- [ ] **Step 7: Implement `src/children.ts`**

Create `src/children.ts`:

```typescript
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
```

- [ ] **Step 8: Run the children tests to verify they pass**

Run: `bun test tests/children.test.ts`
Expected: PASS — all seven cases green (deliver, redact, deliver-once, ignore-detached, timeout, wait-then-deliver, no-children).

- [ ] **Step 9: Write the failing `onFinish` loop tests**

In `tests/agent.test.ts`, add this describe block:

```typescript
describe('agent run — onFinish (child gather)', () => {
  test('onFinish results are injected and the model finishes after incorporating them', async () => {
    mockChat.mockResolvedValue({
      message: { role: 'assistant', content: 'final answer' },
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      finish_reason: 'stop',
    });

    let calls = 0;
    const onFinish = async () => {
      calls++;
      return calls === 1 ? [{ role: 'user' as const, content: 'Child agent 1 finished [done]:\nresult' }] : null;
    };

    const state = await run(initialMessages(), [], makePolicy({ onFinish }));
    expect(state.stopReason).toBe('done');
    expect(calls).toBe(2); // once returns a message (continue), once returns null (proceed)
    expect(state.turns).toBe(2);
    const injected = state.messages.find(
      (m) => m.role === 'user' && String(m.content).includes('Child agent 1 finished'),
    );
    expect(injected).toBeDefined();
  });

  test('onFinish returning null lets the finish proceed unchanged', async () => {
    mockChat.mockResolvedValueOnce({
      message: { role: 'assistant', content: 'done' },
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      finish_reason: 'stop',
    });
    let calls = 0;
    const onFinish = async () => { calls++; return null; };
    const state = await run(initialMessages(), [], makePolicy({ onFinish }));
    expect(state.stopReason).toBe('done');
    expect(calls).toBe(1);
    expect(state.turns).toBe(1);
  });

  test('onFinish runs before the completion audit', async () => {
    const order: string[] = [];
    mockChat.mockResolvedValue({
      message: { role: 'assistant', content: 'answer' },
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      finish_reason: 'stop',
    });
    const onFinish = async () => { order.push('finish'); return null; };
    await run(initialMessages(), [], makePolicy({
      completionAudit: true,
      onFinish,
      onEvent: (e) => { if (e.event === 'completion_audit') order.push('audit'); },
    }));
    expect(order[0]).toBe('finish');
    expect(order).toContain('audit');
    expect(order.indexOf('finish')).toBeLessThan(order.indexOf('audit'));
  });
});
```

- [ ] **Step 10: Run the onFinish tests to verify they fail**

Run: `bun test tests/agent.test.ts -t "onFinish"`
Expected: FAIL — the loop does not call `policy.onFinish` yet, so the child message is never injected and `calls` stays 0.

- [ ] **Step 11: Add `onFinish` and `childWaitMs` to the Policy type**

In `src/types.ts`, inside `Policy` (after `strategyCheckpointEvery?` from Task 2, before the closing `};`), add:

```typescript
  // Awaited inside the 'done' branch before the completion audit. Returns messages to inject (e.g.
  // finished child-agent results); the loop then continues so the model incorporates them. null or
  // empty lets the finish proceed. `emit` is the loop's own event emitter, handed in so the seam can
  // surface its own events without the loop knowing their shape.
  onFinish?: (
    messages: Message[],
    emit: (event: Record<string, unknown>) => void,
  ) => Promise<Message[] | null>;
  // Max total time the default onFinish (child gather) waits for still-running children (default 300000).
  childWaitMs?: number;
```

- [ ] **Step 12: Await `onFinish` in the done branch of agent.ts**

In `src/agent.ts`, inside the `if (finish === 'done') {` block (from Task 1), insert the gather step between `emptyResponses = 0;` and the `// Completion audit:` comment:

```typescript
    if (finish === 'done') {
      // A real answer clears any prior blank streak.
      emptyResponses = 0;

      // Gather results from any children we spawned before accepting the finish, so their work
      // lands in context (and the audit can see it). onFinish is subagent-agnostic from the loop's
      // view — the registry I/O lives behind the seam. deliveredPids (owned by the default onFinish)
      // makes the second pass return null, so this never loops forever.
      if (policy.onFinish) {
        const gathered = await policy.onFinish(allMessages, (e) => emitEvent(policy, e));
        if (gathered && gathered.length > 0) {
          for (const m of gathered) allMessages.push(m);
          continue;
        }
      }

      // Completion audit: give the model exactly one enforced chance to verify before we accept
```

(Leave the rest of the audit block and the `return ... stopReason: 'done'` exactly as Task 1 wrote them.)

- [ ] **Step 13: Run the onFinish loop tests to verify they pass**

Run: `bun test tests/agent.test.ts`
Expected: PASS — all three `onFinish` tests green, and every existing loop test still passes (the default policy's real `onFinish` returns null when there are no children, so unrelated tests are unaffected).

- [ ] **Step 14: Wire the default `onFinish` and `childWaitMs` in policy.ts**

In `src/policy.ts`, add imports (after the existing imports):

```typescript
import { gatherChildren } from './children.ts';
import { defaultTranscriptDir } from './transcript.ts';
```

Add module-level state and constants (above `defaultPolicy`):

```typescript
const POLICY_SOURCE_DIR = import.meta.dir;
// Bounded so a hung child can never wedge the parent's finish forever; generous enough for real work.
const CHILD_WAIT_MS = 300000; // 5 min
// Process-lifetime record of delivered child pids, so each child's result lands exactly once across
// repeated finishes. Owned here and injected into gatherChildren.
const deliveredChildPids = new Set<number>();
```

Add these two fields to `defaultPolicy` (after `strategyCheckpointEvery: 40,`, before the closing `};`):

```typescript
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
```

- [ ] **Step 15: Run policy + full suite to verify the wiring is clean**

Run: `bun test tests/policy.test.ts && bun test`
Expected: PASS — no import cycle or type error from policy.ts pulling in children.ts/transcript.ts.

- [ ] **Step 16: Write the failing render tests for child events**

In `tests/render.test.ts`, add:

```typescript
describe('render — child_result', () => {
  test('rich: shows child pid and status', () => {
    const out = collect({ event: 'child_result', pid: 4242, task: 't', status: 'done' }, RICH);
    expect(out).toContain('child 4242');
    expect(out).toContain('done');
  });

  test('quiet: omits it', () => {
    expect(collect({ event: 'child_result', pid: 4242, status: 'done' }, QUIET)).toBe('');
  });
});

describe('render — awaiting_children', () => {
  test('rich: shows the count', () => {
    const out = collect({ event: 'awaiting_children', pids: [1, 2, 3] }, RICH);
    expect(out).toContain('awaiting 3');
  });
});
```

- [ ] **Step 17: Run the render tests to verify they fail**

Run: `bun test tests/render.test.ts -t "child_result"`
Expected: FAIL — both events hit the silent `default` case.

- [ ] **Step 18: Add the `child_result` and `awaiting_children` render cases**

In `src/render.ts`, add these two cases before the `default:` case:

```typescript
    case 'child_result': {
      if (config.tier === 'quiet') return;
      const pid = event.pid as number;
      const status = String(event.status ?? '');
      writer(`${CYAN(config)}${BOLD(config)}◆ child ${pid} result [${status}]${RESET(config)}\n`);
      return;
    }

    case 'awaiting_children': {
      if (config.tier === 'quiet') return;
      const pids = Array.isArray(event.pids) ? (event.pids as number[]) : [];
      writer(`${DIM(config)}… awaiting ${pids.length} child agent(s)${RESET(config)}\n`);
      return;
    }
```

- [ ] **Step 19: Run the render tests to verify they pass**

Run: `bun test tests/render.test.ts`
Expected: PASS.

- [ ] **Step 20: Add the `detach` param to `spawn_agent` and mark the record**

In `src/tools.ts`, add the `detach` property to the `spawn_agent` parameters schema (inside `properties`, lines 342-345):

```typescript
          task: { type: 'string', description: 'Task for the child agent to perform.' },
          cwd: { type: 'string', description: 'Working directory for the child. Defaults to current cwd.' },
          detach: {
            type: 'boolean',
            description:
              'Fire-and-forget: if true, this child is NOT gathered into your context when you finish. Default false (its result is delivered to you automatically).',
          },
```

In the handler, read the flag (after the `task`/`taskCwd` lines, around line 353):

```typescript
    const detach = args['detach'] === true;
```

And add it to the spawn record (in the `appendRecord` call, lines 379-387):

```typescript
      await appendRecord(resolve(transcriptDir, 'agents.jsonl'), {
        event: 'agent_spawn',
        pid,
        parent_pid: process.pid,
        task,
        out: result.outFile,
        err: result.errFile,
        ts: new Date().toISOString(),
        detached: detach,
      });
```

- [ ] **Step 21: Run the tools/spawn tests to verify nothing regressed**

Run: `bun test tests/tools.test.ts`
Expected: PASS. If a spawn-record assertion does a strict deep-equal and now trips on the added `detached: false`, update that assertion to include `detached: false` (the record shape legitimately changed). If no such test exists, this step is just confirmation.

- [ ] **Step 22: Teach the children-are-gathered convention in system.txt**

In `system.txt`, in the "Child Agents" section, after the line `You remain responsible for the final machine state.` (around line 226), add:

```
Children you spawn are gathered automatically when you finish: their results appear in
your context — labeled with each child's pid, task, and finish status — before your run
completes, and the parent will not finish while a child it spawned is still running (up
to a bounded wait). You do not need to read a child's `.out` file by hand. Use
`spawn_agent(detach: true)` only for fire-and-forget work whose result you will not use.
```

- [ ] **Step 23: Document the gather + detach in README.md, AGENTS.md, gotchas.md**

In `README.md`, update the `spawn_agent` tool bullet (line 58):

```
- `spawn_agent(task, cwd?, detach?)` — launch a child agent (see Subagents). By default its
  result is gathered into your context when you finish; pass `detach: true` for fire-and-forget.
```

In `AGENTS.md`, in the `spawn_agent tool` section (around line 65), append a sentence:

```
By default a spawned child is *awaited*: when the parent finishes, `onFinish` (the default
gather in `src/children.ts`) pulls each finished direct child's redacted `.out` into the
parent's context before the run completes. `spawn_agent(detach: true)` marks the record
`detached` so the gather skips it (true fire-and-forget).
```

Add a new gotcha entry at the end of `gotchas.md`:

```
- **Children are gathered into the parent's context at finish — behind the `onFinish` seam, not in the loop.** The loop awaits `policy.onFinish(allMessages, emit)` inside the `'done'` branch, BEFORE the completion audit; a non-empty return is pushed and the loop `continue`s (the model incorporates the results, then re-finishes), null proceeds. The default `onFinish` (in `policy.ts`) is `gatherChildren` (new `src/children.ts`), which reads `agents.jsonl`, selects this pid's direct, non-detached, not-yet-delivered children, waits up to `childWaitMs` (default 300000) for still-running ones, and injects each terminal child's `.out` — capped at 8000 chars and passed through `redactSecrets` (a child can print a secret) — as a `user` message `Child agent <pid> (task: …) finished [<status>]:\n<result>`. `<status>` comes from the child's `stop_reason`, so a blocked child reads `[blocked]`, never green. A process-lifetime `deliveredPids` set (owned by the default onFinish) makes the second pass return null, preventing an infinite gather loop; on timeout the parent injects `child <pid> still running, proceeding without it` once and finishes. `gatherChildren` takes all state via an injected opts bag (no module globals) so tests drive it with a temp registry and a tiny waitMs. `spawn_agent(detach: true)` marks the spawn record `detached` and the gather skips it. The loop stays subagent-agnostic — registry I/O lives entirely behind the seam.
```

- [ ] **Step 24: Run the full suite**

Run: `bun test`
Expected: PASS — full green suite.

- [ ] **Step 25: Commit**

```bash
git status
git add src/children.ts src/types.ts src/policy.ts src/agent.ts src/registry.ts src/tools.ts src/render.ts system.txt README.md AGENTS.md gotchas.md tests/children.test.ts tests/agent.test.ts tests/registry.test.ts tests/render.test.ts
git commit -m "feat(agent): gather child-agent results into parent context via onFinish seam"
```

---

## Build Order and Rationale

1 → 2 → 3. Task 1 restructures the finish branch (`classifyFinish` routing) that Task 3 extends with the `onFinish` await. Task 2's top-of-loop injection and skip-finish guard sit just above Task 1's `classifyFinish` call and are independent of it. Task 3's gather sits inside Task 1's `'done'` sub-branch. Doing them in order means each agent.ts edit targets a stable anchor the previous task produced.

## Self-Review

**1. Spec coverage** — every spec section maps to a task:
- Mechanism 1 (strategy checkpoint + compaction) → Task 2 (marker, prompt, injection, skip guard, `compactByCheckpoints`, `strategy_checkpoint` event + render).
- Mechanism 2 (honest `blocked`) → Task 1 (`classifyFinish`, routing, `stopReason: 'blocked'`, `exitCodeForStopReason` already maps non-done → nonzero, `statusForStopReason`, system.txt).
- Mechanism 3 (child gather) → Task 3 (`children.ts`, `onFinish` seam, `spawn_agent` `detach`, `AgentSpawnRecord.detached`, `childWaitMs`, `child_result`/`awaiting_children`, redaction, system.txt).
- Type/seam summary (spec §"Type / seam summary") → each type change lands in the task that needs it (types.ts touched by all three).
- Testing strategy (spec §"Testing strategy") → the compactor cases, `classifyFinish` cases, loop cases, children.ts cases, and the blocked exit-code case are all present.
- Global Constraints → redaction on child `.out` (Task 3 Step 7 + test Step 5), transcript completeness (compactor returns a view, never mutates — Task 2 Step 5 + the identity test), no console.log / no gates (no such code added), tool errors as results (untouched).
- `exitCodeForStopReason('blocked')` — the existing implementation is `return stopReason === 'done' ? 0 : 1;`, so `'blocked'` already maps to nonzero once it is in the union. Task 1 Step 11 adds the test that locks this in; no code change to the function is needed. Noted so no one hunts for a missing edit.

**2. Placeholder scan** — no "TBD"/"handle edge cases"/"similar to Task N". Every code step has real code; every doc step quotes the exact replacement text. The three doc edits that describe substring replacements (gotchas.md lines 39-40, AGENTS.md line 26) quote the exact before/after strings.

**3. Type consistency** — `classifyFinish` is spelled identically in types.ts, policy.ts, agent.ts, and the tests. `onFinish`'s signature `(messages, emit) => Promise<Message[] | null>` matches between types.ts, the loop call site (`policy.onFinish(allMessages, (e) => emitEvent(policy, e))`), the default in policy.ts, and the test doubles. `GatherOpts` field names (`selfPid`, `transcriptDir`, `deliveredPids`, `waitMs`, `emit`, `pollMs`) match between children.ts, the default onFinish, and children.test.ts's `baseOpts`. `AgentSpawnRecord.detached` matches between registry.ts, tools.ts, children.ts, and both tests. `strategyCheckpointEvery`, `STRATEGY_CHECKPOINT_MARKER`, and `childWaitMs` are each spelled consistently across their producers and consumers. `statusForStopReason` matches between index.ts and exit-code.test.ts. Event names (`strategy_checkpoint`, `child_result`, `awaiting_children`) match between emit sites and render cases/tests.

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-08-31-attention-child-context-and-blocked.md`. Two execution options:

**1. Subagent-Driven (recommended)** — I dispatch a fresh subagent per task, review between tasks (spec compliance + code quality), fast iteration; my context stays small.

**2. Inline Execution** — I execute the tasks in this session using executing-plans, batching with checkpoints for your review.

**Which approach?**
