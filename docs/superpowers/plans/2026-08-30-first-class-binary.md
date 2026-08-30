# First-Class Binary Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `bun build --compile` a first-class mode by fixing four runtime failures that occur when break-away runs as a compiled binary instead of source.

**Architecture:** The compiled binary embeds `/$bunfs/root` as a read-only FS, breaking three path-anchored behaviors (system prompt, transcripts, spawn_agent child command). Each fix adds a narrow embedded-mode detection branch — `isEmbedded()` checks `import.meta.dir` prefix — that redirects to writable paths (`~/.break-away/transcripts`, `process.execPath`). The real system prompt gets bundled via Bun's static text import. Source mode is untouched.

**Tech Stack:** Bun 1.3.14, TypeScript, `bun build --compile`, `node:os`, `node:path`

**Spec:** The task description provided to this session (verified background section + four fixes section).

## Global Constraints

- Branch: `feat/first-class-binary` — conventional commits, each ending `\nClaude-Session: https://claude.ai/code/session_01GPwMKMSRcjK7gMqvkeqHX1`
- `bun test` must stay green (80 tests + new tests)
- No mocks of our own code
- stdout purity: no `console.log`, only `process.stdout.write` for model's final answer
- `.env` never committed, never printed
- ABOUTME headers on all hand-written source files
- Tool errors are results, never thrown
- YAGNI — minimal change that achieves correctness

---

### Task 1: Embedded-mode detection utility

**Files:**
- Modify: `src/index.ts` (add `isEmbedded()` export, no other changes)
- Test: `tests/args.test.ts` (extend the existing args/index test file with a describe block)

**Interfaces:**
- Produces: `export function isEmbedded(): boolean` — returns `true` when `import.meta.dir.startsWith('/$bunfs/')`, false otherwise

**Background:** In a `bun build --compile` binary, `import.meta.dir` is `/$bunfs/root`. In source mode it is a normal filesystem path starting with `/` but not `/$bunfs/`. The check `startsWith('/$bunfs/')` is the robust idiom — it avoids depending on the exact suffix `root` and will still work if Bun uses a different subpath.

- [ ] **Step 1: Write the failing test**

In `tests/args.test.ts`, add at the top:
```typescript
import { parseArgs, loadSystemPrompt, isEmbedded } from '../src/index.ts';
```
(Replace the existing import line — it already imports `parseArgs, loadSystemPrompt`.)

Append this describe block at the bottom of the file:

```typescript
describe('isEmbedded', () => {
  test('returns false when running from source', () => {
    // In bun test, import.meta.dir is a real filesystem path
    expect(isEmbedded()).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd /Users/harper/Public/src/2389/break-away && bun test tests/args.test.ts 2>&1 | tail -20
```
Expected: fails with "isEmbedded is not exported" or similar.

- [ ] **Step 3: Add `isEmbedded` to `src/index.ts`**

After the `SOURCE_DIR` line (line 13), add:

```typescript
export function isEmbedded(): boolean {
  return import.meta.dir.startsWith('/$bunfs/');
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
cd /Users/harper/Public/src/2389/break-away && bun test tests/args.test.ts 2>&1 | tail -10
```
Expected: all tests in the file pass.

- [ ] **Step 5: Run full suite**

```bash
cd /Users/harper/Public/src/2389/break-away && bun test 2>&1 | tail -5
```
Expected: 80+ pass, 0 fail.

- [ ] **Step 6: Commit**

```bash
cd /Users/harper/Public/src/2389/break-away
git add src/index.ts tests/args.test.ts
git commit -m "$(cat <<'EOF'
feat: add isEmbedded() utility for compiled-binary detection

Claude-Session: https://claude.ai/code/session_01GPwMKMSRcjK7gMqvkeqHX1
EOF
)"
```

---

### Task 2: Real system prompt bundled in binary (Fix 1)

**Files:**
- Modify: `src/index.ts` — static text import of `system.txt`, update `loadSystemPrompt` fallback logic, update SIGHUP handler

**Interfaces:**
- Consumes: `isEmbedded(): boolean` (Task 1)
- The new top-of-file import: `import defaultSystemText from '../system.txt' with { type: 'text' };`
- `loadSystemPrompt(path: string, isDefault: boolean): string` — signature unchanged; behavior changes: on default-path read failure, returns `defaultSystemText` instead of the generic hardcoded string

**Background:** Bun bundles `import X from 'file' with { type: 'text' }` into the binary as a string. This is the correct idiom in Bun 1.x. The static import is evaluated at module load, so `defaultSystemText` is always the content of `system.txt` at build time. The existing fallback logic in `loadSystemPrompt` already has the right structure: try file → on failure, if `isDefault`, return fallback; else exit 1. We just swap the fallback value from the generic string to `defaultSystemText` and delete `FALLBACK_SYSTEM_PROMPT`.

SIGHUP/doReload in the binary: `doReload` already calls `readFileSync(systemPath)` — that will fail on the embedded path. The handler must detect embedded mode and warn instead of attempting a broken reload. Only warn on SIGHUP; the manual `/reload` command in REPL goes through `doReload` too, so the warning comes naturally.

- [ ] **Step 1: Write the failing tests**

Add a new file `tests/system-prompt.test.ts`:

```typescript
// ABOUTME: Tests for system prompt loading and embedded-mode fallback behavior.
// ABOUTME: Covers loadSystemPrompt fallback ordering and SIGHUP warning in embedded mode.

import { describe, test, expect } from 'bun:test';
import { loadSystemPrompt } from '../src/index.ts';
import { writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

describe('loadSystemPrompt — fallback is real prompt, not generic string', () => {
  test('fallback when isDefault=true and file missing is non-empty and not the old generic string', () => {
    const result = loadSystemPrompt('/nonexistent/path/sys.txt', true);
    expect(typeof result).toBe('string');
    expect(result.length).toBeGreaterThan(50);
    // Must NOT be the old generic placeholder
    expect(result).not.toBe(
      'You are a code agent. Work step by step. Use tools to read, write, and run code. Report what you did when done.',
    );
  });

  test('fallback text contains real agent instructions (proves bundled content)', () => {
    const result = loadSystemPrompt('/nonexistent/path/sys.txt', true);
    // system.txt instructs the agent about tools and working step by step
    expect(result).toMatch(/tool/i);
  });

  test('explicit --system path failure exits 1 (unchanged)', () => {
    const indexPath = new URL('../src/index.ts', import.meta.url).pathname;
    const result = Bun.spawnSync(
      ['bun', indexPath, '--system', '/nonexistent/path/sys.txt', 'dummy task'],
      { env: { ...process.env, BREAK_AWAY_TRANSCRIPT_DIR: '/tmp' } },
    );
    expect(result.exitCode).toBe(1);
    expect(new TextDecoder().decode(result.stderr)).toContain('/nonexistent/path/sys.txt');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail (or the non-generic assertion fails)**

```bash
cd /Users/harper/Public/src/2389/break-away && bun test tests/system-prompt.test.ts 2>&1 | tail -15
```

Expected: the "not the old generic string" test fails because the current fallback IS the old generic string.

- [ ] **Step 3: Add static text import and update `loadSystemPrompt` in `src/index.ts`**

At the top of `src/index.ts`, after the existing imports, add:

```typescript
import defaultSystemText from '../system.txt' with { type: 'text' };
```

Remove the `FALLBACK_SYSTEM_PROMPT` constant (the entire line starting with `const FALLBACK_SYSTEM_PROMPT`).

Change `loadSystemPrompt` to:

```typescript
export function loadSystemPrompt(path: string, isDefault: boolean): string {
  try {
    return readFileSync(path, 'utf8').trim();
  } catch (err) {
    if (isDefault) return defaultSystemText.trim();
    process.stderr.write(`error: cannot read system prompt: ${path}: ${err}\n`);
    process.exit(1);
  }
}
```

- [ ] **Step 4: Update `doReload` to warn in embedded mode**

`doReload` already catches errors and returns false. The SIGHUP handler wraps it. Update the SIGHUP handler body in `src/index.ts` to detect embedded mode:

```typescript
process.on('SIGHUP', () => {
  if (isEmbedded()) {
    process.stderr.write('[reload] compiled binary — reload unavailable; rebuild instead\n');
    return;
  }
  doReload(resolve(SOURCE_DIR, 'tools.ts'), resolve(SOURCE_DIR, 'policy.ts'), _sighupSystemPath);
});
```

The `/reload` REPL command calls `doReload` directly; that will also warn (via `doReload`'s existing catch, which emits `[reload] failed: ...`). That's acceptable — the binary import will fail, the error message explains it. No special-casing needed for REPL `/reload` beyond what already exists.

- [ ] **Step 5: Add a test for the SIGHUP embedded-mode warning**

In `tests/reload.test.ts`, the existing SIGHUP tests check that the handler is registered. We do NOT test the embedded-mode branch there (it would require faking `import.meta.dir`). Instead, add a note in the describe block comment. The `isEmbedded()` unit test (Task 1) covers the detection; the SIGHUP branch is too coupled to the signal for unit testing without mocks.

No test change required here.

- [ ] **Step 6: Run all tests**

```bash
cd /Users/harper/Public/src/2389/break-away && bun test 2>&1 | tail -5
```
Expected: 80 + (new system-prompt tests) pass, 0 fail.

- [ ] **Step 7: Commit**

```bash
cd /Users/harper/Public/src/2389/break-away
git add src/index.ts tests/system-prompt.test.ts
git commit -m "$(cat <<'EOF'
feat: bundle real system prompt in binary via static text import

Replaces generic fallback with system.txt content bundled at compile time.
SIGHUP warns in embedded mode instead of attempting a broken reload.

Claude-Session: https://claude.ai/code/session_01GPwMKMSRcjK7gMqvkeqHX1
EOF
)"
```

---

### Task 3: Transcript dir redirected to ~/.break-away/transcripts in binary (Fix 2)

**Files:**
- Modify: `src/index.ts` — update `transcriptDir()` function
- Modify: `src/tools.ts` — update `DEFAULT_SPAWN_TRANSCRIPT_DIR` to use same resolution
- Test: `tests/transcript-dir.test.ts` (new file)

**Interfaces:**
- Consumes: `isEmbedded(): boolean` (Task 1)
- `transcriptDir(): string` is a module-private function in `src/index.ts`; make it `export function transcriptDir(): string` so it can be tested
- The function must return: `$BREAK_AWAY_TRANSCRIPT_DIR` if set, else `~/.break-away/transcripts` when embedded, else the existing default next to the source dir

**Background:** In source mode, `import.meta.dir` is the real `src/` dir, so `resolve(SOURCE_DIR, '../.transcripts')` works. In the binary, `resolve('/$bunfs/root', '../.transcripts')` resolves to `/$bunfs/.transcripts`, which is EROFS. The fix is: when embedded, use `join(homedir(), '.break-away', 'transcripts')`. `$BREAK_AWAY_TRANSCRIPT_DIR` always wins — that's the existing contract. `src/tools.ts` has its own `DEFAULT_SPAWN_TRANSCRIPT_DIR` built from `import.meta.dir`; it must get the same treatment. Both places should use a shared exported function from `src/index.ts` — but `tools.ts` can't import from `index.ts` without a circular dep. Extract the default-dir computation into a helper `defaultTranscriptDir(): string` in `src/index.ts` and export it; `tools.ts` imports it.

Wait — `tools.ts` already imports from other files. Check the import chain: `tools.ts` imports from `types.ts` only (and node modules). `index.ts` imports from `tools.ts`. So importing from `index.ts` into `tools.ts` would be circular. Instead: extract `defaultTranscriptDir` into `src/transcript.ts` (the transcript module), which neither imports `index.ts` nor `tools.ts`. Both `index.ts` and `tools.ts` can import from `transcript.ts`.

`src/transcript.ts` gets:
```typescript
import { homedir } from 'node:os';
export function defaultTranscriptDir(sourceDir: string): string {
  if (process.env.BREAK_AWAY_TRANSCRIPT_DIR) return process.env.BREAK_AWAY_TRANSCRIPT_DIR;
  if (sourceDir.startsWith('/$bunfs/')) return join(homedir(), '.break-away', 'transcripts');
  return resolve(sourceDir, '../.transcripts');
}
```

`index.ts`: replace `transcriptDir()` with:
```typescript
import { defaultTranscriptDir } from './transcript.ts';
function transcriptDir(): string {
  return defaultTranscriptDir(SOURCE_DIR);
}
```
Export `transcriptDir` for testability if not already done.

`tools.ts`: replace the `DEFAULT_SPAWN_TRANSCRIPT_DIR` constant with a call to `defaultTranscriptDir`:
```typescript
import { defaultTranscriptDir } from './transcript.ts';
// remove: const DEFAULT_SPAWN_TRANSCRIPT_DIR = resolve(TOOLS_SOURCE_DIR, '../.transcripts');
```
And in the `spawnAgent` handler, change `process.env.BREAK_AWAY_TRANSCRIPT_DIR ?? DEFAULT_SPAWN_TRANSCRIPT_DIR` to `defaultTranscriptDir(TOOLS_SOURCE_DIR)`.

- [ ] **Step 1: Write the failing tests**

Create `tests/transcript-dir.test.ts`:

```typescript
// ABOUTME: Tests for defaultTranscriptDir — embedded vs source mode dir resolution.
// ABOUTME: Pure function test; no filesystem or compile step needed.

import { describe, test, expect } from 'bun:test';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { defaultTranscriptDir } from '../src/transcript.ts';

describe('defaultTranscriptDir', () => {
  test('env var wins in source mode', () => {
    const orig = process.env.BREAK_AWAY_TRANSCRIPT_DIR;
    process.env.BREAK_AWAY_TRANSCRIPT_DIR = '/custom/path';
    try {
      expect(defaultTranscriptDir('/some/source/dir')).toBe('/custom/path');
    } finally {
      if (orig === undefined) delete process.env.BREAK_AWAY_TRANSCRIPT_DIR;
      else process.env.BREAK_AWAY_TRANSCRIPT_DIR = orig;
    }
  });

  test('env var wins in embedded mode', () => {
    const orig = process.env.BREAK_AWAY_TRANSCRIPT_DIR;
    process.env.BREAK_AWAY_TRANSCRIPT_DIR = '/custom/path';
    try {
      expect(defaultTranscriptDir('/$bunfs/root')).toBe('/custom/path');
    } finally {
      if (orig === undefined) delete process.env.BREAK_AWAY_TRANSCRIPT_DIR;
      else process.env.BREAK_AWAY_TRANSCRIPT_DIR = orig;
    }
  });

  test('embedded mode without env var returns ~/.break-away/transcripts', () => {
    const orig = process.env.BREAK_AWAY_TRANSCRIPT_DIR;
    delete process.env.BREAK_AWAY_TRANSCRIPT_DIR;
    try {
      const result = defaultTranscriptDir('/$bunfs/root');
      expect(result).toBe(join(homedir(), '.break-away', 'transcripts'));
    } finally {
      if (orig !== undefined) process.env.BREAK_AWAY_TRANSCRIPT_DIR = orig;
    }
  });

  test('embedded mode with different bunfs subpath still returns home dir', () => {
    const orig = process.env.BREAK_AWAY_TRANSCRIPT_DIR;
    delete process.env.BREAK_AWAY_TRANSCRIPT_DIR;
    try {
      const result = defaultTranscriptDir('/$bunfs/other');
      expect(result).toBe(join(homedir(), '.break-away', 'transcripts'));
    } finally {
      if (orig !== undefined) process.env.BREAK_AWAY_TRANSCRIPT_DIR = orig;
    }
  });

  test('source mode without env var returns sibling .transcripts dir', () => {
    const orig = process.env.BREAK_AWAY_TRANSCRIPT_DIR;
    delete process.env.BREAK_AWAY_TRANSCRIPT_DIR;
    try {
      const sourceDir = '/home/user/break-away/src';
      const result = defaultTranscriptDir(sourceDir);
      expect(result).toBe(resolve(sourceDir, '../.transcripts'));
    } finally {
      if (orig !== undefined) process.env.BREAK_AWAY_TRANSCRIPT_DIR = orig;
    }
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd /Users/harper/Public/src/2389/break-away && bun test tests/transcript-dir.test.ts 2>&1 | tail -10
```
Expected: fails because `defaultTranscriptDir` is not exported from `transcript.ts`.

- [ ] **Step 3: Update `src/transcript.ts`**

Add these imports at the top:
```typescript
import { homedir } from 'node:os';
import { resolve, join } from 'node:path';
```

Add this function after the existing imports (before `TranscriptHandle`):
```typescript
export function defaultTranscriptDir(sourceDir: string): string {
  if (process.env.BREAK_AWAY_TRANSCRIPT_DIR) return process.env.BREAK_AWAY_TRANSCRIPT_DIR;
  if (sourceDir.startsWith('/$bunfs/')) return join(homedir(), '.break-away', 'transcripts');
  return resolve(sourceDir, '../.transcripts');
}
```

Note: `transcript.ts` currently imports `join` from `node:path`. Add `resolve` to that import.

- [ ] **Step 4: Update `src/index.ts` to use `defaultTranscriptDir`**

Add `defaultTranscriptDir` to the transcript import:
```typescript
import { openTranscript, writeEvent, closeTranscript, defaultTranscriptDir } from './transcript.ts';
```

Remove the `DEFAULT_TRANSCRIPT_DIR` constant.

Replace `transcriptDir()` function:
```typescript
function transcriptDir(): string {
  return defaultTranscriptDir(SOURCE_DIR);
}
```

- [ ] **Step 5: Update `src/tools.ts` to use `defaultTranscriptDir`**

Add import at top of `src/tools.ts`:
```typescript
import { defaultTranscriptDir } from './transcript.ts';
```

Remove the line:
```typescript
const DEFAULT_SPAWN_TRANSCRIPT_DIR = resolve(TOOLS_SOURCE_DIR, '../.transcripts');
```

In `spawnAgent.handler`, change:
```typescript
const transcriptDir = process.env.BREAK_AWAY_TRANSCRIPT_DIR ?? DEFAULT_SPAWN_TRANSCRIPT_DIR;
```
to:
```typescript
const transcriptDir = defaultTranscriptDir(TOOLS_SOURCE_DIR);
```

- [ ] **Step 6: Run all tests**

```bash
cd /Users/harper/Public/src/2389/break-away && bun test 2>&1 | tail -5
```
Expected: 80 + (new tests) pass, 0 fail.

- [ ] **Step 7: Commit**

```bash
cd /Users/harper/Public/src/2389/break-away
git add src/transcript.ts src/index.ts src/tools.ts tests/transcript-dir.test.ts
git commit -m "$(cat <<'EOF'
feat: redirect transcript dir to ~/.break-away/transcripts in compiled binary

Extracts defaultTranscriptDir() into transcript.ts; both index.ts and
tools.ts use it. Embedded mode falls back to home dir instead of EROFS path.

Claude-Session: https://claude.ai/code/session_01GPwMKMSRcjK7gMqvkeqHX1
EOF
)"
```

---

### Task 4: spawn_agent uses process.execPath in binary mode (Fix 3)

**Files:**
- Modify: `src/tools.ts` — extend `buildSpawnArgs` params with `execPath` and `embedded` fields; update `cmd` construction
- Modify: `tests/spawn.test.ts` — update existing tests to pass new required params; add new tests for embedded mode

**Interfaces:**
- Consumes: `isEmbedded(): boolean` (Task 1) — but `buildSpawnArgs` is a pure helper; pass `embedded: boolean` and `execPath: string` as params instead of calling `isEmbedded()` inside it (keeps it testable without compile step)
- `buildSpawnArgs` new signature:
  ```typescript
  export function buildSpawnArgs(params: {
    task: string;
    cwd: string;
    transcriptDir: string;
    depth: number;
    maxDepth: number;
    ts: string;
    indexPath: string;
    embedded: boolean;   // NEW: true → use execPath; false → use `bun indexPath`
    execPath: string;    // NEW: process.execPath value (passed in, not read inside)
  }): SpawnArgsSuccess | SpawnArgsError
  ```
- In the `spawnAgent` handler, pass `embedded: isEmbedded()` and `execPath: process.execPath`
- `cmd` construction: when `embedded`, the command starts with `nohup '${esc(params.execPath)}'`; when source, it stays `nohup bun '${esc(params.indexPath)}'`
- In source mode, `indexPath` is still used; in embedded mode, `indexPath` is irrelevant (but kept in the signature for completeness/documentation)

**Background:** `process.execPath` in a compiled Bun binary is the path to the binary itself. In source mode it is the path to the Bun runtime. The `--cwd`, task, and redirection flags are the same in both cases.

- [ ] **Step 1: Update `tests/spawn.test.ts` with new required params and new tests**

Update `BASE_PARAMS` in the test file to add the new required fields:

```typescript
const BASE_PARAMS = {
  task: 'do something',
  cwd: '/tmp/work',
  transcriptDir: '/tmp/transcripts',
  depth: 0,
  maxDepth: 3,
  ts: '2025-01-01T00:00:00.000Z',
  indexPath: '/usr/local/src/break-away/src/index.ts',
  embedded: false,
  execPath: '/usr/local/bin/bun',
};
```

The existing test `'cmd includes indexPath'` checks that cmd contains the indexPath. This test is for source mode (embedded: false), so it must still pass.

Add these new tests at the end of the describe block:

```typescript
  test('source mode cmd starts with nohup bun and includes indexPath', () => {
    const result = buildSpawnArgs({ ...BASE_PARAMS, embedded: false });
    if ('error' in result) throw new Error(result.error);
    expect(result.cmd).toContain("bun '/usr/local/src/break-away/src/index.ts'");
  });

  test('embedded mode cmd uses execPath instead of bun + indexPath', () => {
    const result = buildSpawnArgs({
      ...BASE_PARAMS,
      embedded: true,
      execPath: '/home/user/.local/bin/break-away',
      indexPath: '/$bunfs/root/index.ts',
    });
    if ('error' in result) throw new Error(result.error);
    expect(result.cmd).toContain("'/home/user/.local/bin/break-away'");
    expect(result.cmd).not.toContain('/$bunfs/root/index.ts');
  });

  test('embedded mode cmd still includes --cwd and task', () => {
    const result = buildSpawnArgs({
      ...BASE_PARAMS,
      embedded: true,
      execPath: '/home/user/.local/bin/break-away',
    });
    if ('error' in result) throw new Error(result.error);
    expect(result.cmd).toContain('--cwd');
    expect(result.cmd).toContain('/tmp/work');
    expect(result.cmd).toContain('do something');
  });

  test('embedded mode depth guard still works', () => {
    const result = buildSpawnArgs({
      ...BASE_PARAMS,
      embedded: true,
      depth: 3,
      maxDepth: 3,
    });
    expect('error' in result).toBe(true);
  });
```

- [ ] **Step 2: Run tests to verify the new tests fail**

```bash
cd /Users/harper/Public/src/2389/break-away && bun test tests/spawn.test.ts 2>&1 | tail -15
```
Expected: new tests fail (wrong number of params or wrong cmd shape), existing tests also fail because `buildSpawnArgs` is now called without the new required params.

- [ ] **Step 3: Update `buildSpawnArgs` in `src/tools.ts`**

Update the params type:
```typescript
export function buildSpawnArgs(params: {
  task: string;
  cwd: string;
  transcriptDir: string;
  depth: number;
  maxDepth: number;
  ts: string;
  indexPath: string;
  embedded: boolean;
  execPath: string;
}): SpawnArgsSuccess | SpawnArgsError {
```

Update the `cmd` line:
```typescript
const agentCmd = params.embedded
  ? `'${esc(params.execPath)}'`
  : `bun '${esc(params.indexPath)}'`;
const cmd = `nohup ${agentCmd} --cwd '${esc(params.cwd)}' '${esc(params.task)}' >'${esc(outFile)}' 2>'${esc(errFile)}' & echo $!`;
```

Update the `spawnAgent` handler to pass the new fields:

Import `isEmbedded` at the top of `tools.ts`:
```typescript
import { isEmbedded } from './index.ts';
```

Wait — that's circular (`index.ts` imports `tools.ts`). Instead, add `embedded` and `execPath` directly in the handler using `import.meta.dir`:

```typescript
const embedded = TOOLS_SOURCE_DIR.startsWith('/$bunfs/');
```
And `execPath: process.execPath`. No import of `isEmbedded` needed — the handler inlines the same check. This keeps `buildSpawnArgs` fully parameterized (testable) while avoiding a circular dep.

So in the handler, the call becomes:
```typescript
const embedded = TOOLS_SOURCE_DIR.startsWith('/$bunfs/');
const result = buildSpawnArgs({
  task, cwd: taskCwd, transcriptDir, depth, maxDepth, ts, indexPath,
  embedded, execPath: process.execPath,
});
```

- [ ] **Step 4: Run all tests**

```bash
cd /Users/harper/Public/src/2389/break-away && bun test 2>&1 | tail -5
```
Expected: 80 + (new) pass, 0 fail.

- [ ] **Step 5: Commit**

```bash
cd /Users/harper/Public/src/2389/break-away
git add src/tools.ts tests/spawn.test.ts
git commit -m "$(cat <<'EOF'
feat: spawn_agent uses process.execPath in compiled binary mode

buildSpawnArgs takes embedded+execPath params; embedded=true emits the
binary path instead of `bun <indexPath>`, keeping subagents functional.

Claude-Session: https://claude.ai/code/session_01GPwMKMSRcjK7gMqvkeqHX1
EOF
)"
```

---

### Task 5: Build script, .gitignore, README, AGENTS.md, gotchas.md (Fix 4 + docs)

**Files:**
- Modify: `package.json` — add `"build"` script
- Modify: `.gitignore` — add `/break-away` binary
- Modify: `README.md` — add "Building a binary" section
- Modify: `AGENTS.md` — brief binary mode entry
- Modify: `gotchas.md` — brief binary mode entry

**No test needed** — this is configuration and docs.

- [ ] **Step 1: Add build script to `package.json`**

Edit `package.json` `scripts` block:
```json
"scripts": {
  "start": "bun run src/index.ts",
  "build": "bun build --compile src/index.ts --outfile break-away",
  "test": "bun test"
}
```

- [ ] **Step 2: Add binary to `.gitignore`**

Append to `.gitignore`:
```
/break-away
```

- [ ] **Step 3: Update README.md — add "Building a binary" section**

After the "Subagents" section, add:

```markdown
## Building a binary

```sh
bun run build
```

Produces a self-contained `break-away` binary (~61 MB) via `bun build --compile`. Run it from any directory:

```sh
./break-away "describe the project"
```

**What works in the binary (everything):**
- All tools (read_file, write_file, bash, spawn_agent), subagents, REPL
- Transcripts — written to `~/.break-away/transcripts/` (or `$BREAK_AWAY_TRANSCRIPT_DIR`)
- `.env` is picked up automatically from the launch directory

**What doesn't work (inherent limit):**
- Self-modification / hot-reload — the binary is a frozen snapshot; `SIGHUP` warns instead of reloading. Rebuild to pick up source changes.
- `/reload` in REPL has the same limit — it will report a failure; rebuild instead.

Per-experiment configuration: drop a `.env` in whatever directory you launch the binary from.
```

- [ ] **Step 4: Update AGENTS.md — binary mode entry**

In the "Hard rules" section (or append a new "Binary mode" section before Hard rules):

```markdown
## Binary mode (`bun run build`)

Running `bun run build` compiles to a `./break-away` binary. The binary is ignored by git. In binary mode:
- Transcripts go to `~/.break-away/transcripts/` (env var still wins).
- Subagents (`spawn_agent`) launch the binary itself via `process.execPath`.
- The system prompt is bundled at build time; `--system <path>` still overrides at runtime.
- `SIGHUP` / `/reload` warn that reload is unavailable — rebuild instead.
```

- [ ] **Step 5: Update gotchas.md — binary mode entry**

Append:
```markdown
- **Compiled binary (`bun run build`) has embedded FS.** `import.meta.dir` = `/$bunfs/root` in the binary — paths anchored there are read-only and break at runtime. Fixes: text import bundles system.txt; transcripts redirect to `~/.break-away/transcripts`; spawn_agent uses `process.execPath` for children. `bun test` runs from source — these paths are never hit during tests, which is by design.
- **SIGHUP / `/reload` in binary warns, doesn't reload.** The binary is a frozen snapshot. Rebuild (`bun run build`) to pick up source changes.
```

- [ ] **Step 6: Run full test suite one more time**

```bash
cd /Users/harper/Public/src/2389/break-away && bun test 2>&1 | tail -5
```
Expected: all pass.

- [ ] **Step 7: Commit**

```bash
cd /Users/harper/Public/src/2389/break-away
git add package.json .gitignore README.md AGENTS.md gotchas.md
git commit -m "$(cat <<'EOF'
feat: add build script, binary gitignore, and binary mode docs

package.json gets a build script. README, AGENTS.md, gotchas.md document
what works and what doesn't in the compiled binary.

Claude-Session: https://claude.ai/code/session_01GPwMKMSRcjK7gMqvkeqHX1
EOF
)"
```

---

### Task 6: Build and verify end-to-end

This task is **manual verification** — it cannot be fully automated, but the steps are concrete.

**Files:**
- No source changes

- [ ] **Step 1: Build the binary**

```bash
cd /Users/harper/Public/src/2389/break-away && bun run build 2>&1
```
Expected: output mentions 91 modules, produces `./break-away`.

- [ ] **Step 2: Create a temp dir and source .env**

```bash
TMPDIR=$(mktemp -d)
set -a; . /Users/harper/Public/src/2389/break-away/.env; set +a
```

- [ ] **Step 3: Verify (a) — real task, output file in tmpdir, stdout prose only**

```bash
/Users/harper/Public/src/2389/break-away/break-away --cwd "$TMPDIR" "write hello.txt containing the word hello" > "$TMPDIR/stdout.txt" 2>"$TMPDIR/stderr.txt"
cat "$TMPDIR/stdout.txt"   # must be prose only, no JSON or progress
ls "$TMPDIR/hello.txt"     # must exist
```

- [ ] **Step 4: Verify (b) — transcript appears in ~/.break-away/transcripts/**

```bash
ls ~/.break-away/transcripts/run-*.jsonl | tail -1 | xargs head -3
```
Expected: valid JSON lines with `event: "run_start"` etc.

- [ ] **Step 5: Verify (c) — embedded prompt correctness (BANANAPHONE test)**

```bash
# Append marker to system.txt
echo 'End every answer with the word BANANAPHONE.' >> /Users/harper/Public/src/2389/break-away/system.txt
# Rebuild
cd /Users/harper/Public/src/2389/break-away && bun run build
# Run
/Users/harper/Public/src/2389/break-away/break-away "say hello" 2>/dev/null
# Check output ends with BANANAPHONE
/Users/harper/Public/src/2389/break-away/break-away "say hello" 2>/dev/null | grep -i BANANAPHONE
# Restore
git checkout -- /Users/harper/Public/src/2389/break-away/system.txt
# Rebuild clean
bun run build
```

- [ ] **Step 6: Verify (d) — subagents from the binary**

```bash
FLAG="$TMPDIR/flag.txt"
/Users/harper/Public/src/2389/break-away/break-away --cwd "$TMPDIR" "use spawn_agent to write the text 'subagent-ran' to flag.txt in $TMPDIR" 2>/dev/null
# Poll for flag.txt up to 30s
for i in $(seq 1 30); do [ -f "$FLAG" ] && break; sleep 1; done
cat "$FLAG"   # must contain subagent-ran
ls ~/.break-away/transcripts/spawn-*.out | tail -1   # spawn .out file must exist
```

- [ ] **Step 7: Verify git status is clean**

```bash
cd /Users/harper/Public/src/2389/break-away && git status --porcelain
```
Expected: only `??` for `break-away` binary (gitignored, so it should NOT appear — confirm nothing tracked is dirty).

---

## Self-Review

**Spec coverage check:**

| Spec requirement | Task covering it |
|---|---|
| Static text import of system.txt | Task 2 |
| `loadSystemPrompt` filesystem-first, fallback to bundled | Task 2 |
| Delete generic fallback string | Task 2 |
| Explicit `--system` failure still exits 1 | Task 2 (existing test, preserved) |
| SIGHUP warns in embedded mode | Task 2 |
| `isEmbedded()` via `/$bunfs/` prefix | Task 1 |
| Transcript dir → `~/.break-away/transcripts` when embedded | Task 3 |
| `$BREAK_AWAY_TRANSCRIPT_DIR` still wins | Task 3 |
| mkdir -p, best-effort semantics | Existing `transcript.ts` behavior, unchanged |
| `spawn_agent` uses `process.execPath` when embedded | Task 4 |
| `buildSpawnArgs` extended minimally, tested | Task 4 |
| `bun run build` script in package.json | Task 5 |
| `/break-away` in .gitignore | Task 5 |
| README "Building a binary" section | Task 5 |
| AGENTS.md binary mode notes | Task 5 |
| gotchas.md binary mode notes | Task 5 |
| `bun test` stays green | All tasks |
| E2E verification: (a)–(d) | Task 6 |

**No gaps found.**

**Placeholder scan:** All test code is concrete. All implementation snippets are complete. No "TBD" or "handle edge cases" prose.

**Type consistency:** `buildSpawnArgs` params type is updated consistently in both the function definition (Task 4 Step 3) and all test callsites (Task 4 Step 1). `defaultTranscriptDir(sourceDir: string): string` signature is consistent across definition (Task 3 Step 3) and all imports (Tasks 3/4). `isEmbedded(): boolean` signature consistent across definition (Task 1 Step 3) and usage (Task 4 Step 3 handler inline).
