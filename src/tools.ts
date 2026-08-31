// ABOUTME: Tool registry — read_file, write_file, bash, spawn_agent.
// ABOUTME: Output capped at 8000 chars; bash captures stdout, stderr, and exit code.

import type { Tool } from './types.ts';
import { join, resolve, dirname, basename } from 'node:path';
import { rename, unlink } from 'node:fs/promises';
import { defaultTranscriptDir } from './transcript.ts';
import { appendRecord } from './registry.ts';

const TOOLS_SOURCE_DIR = import.meta.dir;

export type SpawnArgsSuccess = { cmd: string; outFile: string; errFile: string };
export type SpawnArgsError = { error: string };

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
  if (params.depth >= params.maxDepth) {
    return { error: `spawn refused: max agent depth ${params.maxDepth} reached` };
  }
  const slug = params.ts.replace(/[:.]/g, '-');
  const outFile = resolve(params.transcriptDir, `spawn-${slug}.out`);
  const errFile = resolve(params.transcriptDir, `spawn-${slug}.err`);

  const esc = (s: string) => s.replace(/'/g, `'\\''`);
  const agentCmd = params.embedded
    ? `'${esc(params.execPath)}'`
    : `bun '${esc(params.indexPath)}'`;
  const cmd = `nohup ${agentCmd} --cwd '${esc(params.cwd)}' '${esc(params.task)}' >'${esc(outFile)}' 2>'${esc(errFile)}' & echo $!`;
  return { cmd, outFile, errFile };
}

const OUTPUT_CAP = 8000;
const DEFAULT_MAX_LINES = 400;

function cap(output: string): string {
  if (output.length <= OUTPUT_CAP) return output;
  const tail = output.slice(-OUTPUT_CAP);
  return `[truncated: showing last ${OUTPUT_CAP} of ${output.length} chars]\n` + tail;
}

// Validate a required argument before it reaches the real operation. Models mis-key args
// (e.g. {command} instead of {cmd}), which used to send `undefined` into the shell or file API.
function missingField(field: string, detail = 'expected a non-empty string'): string {
  return `error: missing required field: ${field} (${detail})`;
}

// Validate an optional positive-integer arg. Returns an error string if present-but-invalid,
// or null if absent (use the default) or valid. Absent means undefined/null, not 0.
function badPositiveInt(field: string, value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) {
    return `error: read_file.${field} must be an integer >= 1`;
  }
  return null;
}

const readFile: Tool = {
  definition: {
    type: 'function',
    function: {
      name: 'read_file',
      description:
        'Read a file. Optionally read a line window with start_line (1-based, default 1) and max_lines. ' +
        'Ranged reads return range metadata (total lines and next_start_line) so you can page through a ' +
        'large file deterministically instead of fighting output truncation.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Absolute or relative path to the file.' },
          start_line: { type: 'number', description: '1-based line to start reading at (default 1).' },
          max_lines: { type: 'number', description: `Maximum lines to return (default ${DEFAULT_MAX_LINES}).` },
        },
        required: ['path'],
      },
    },
  },
  async handler(args) {
    if (typeof args['path'] !== 'string' || args['path'] === '') return missingField('path');
    const startErr = badPositiveInt('start_line', args['start_line']);
    if (startErr) return startErr;
    const maxErr = badPositiveInt('max_lines', args['max_lines']);
    if (maxErr) return maxErr;

    const filePath = args['path'];
    let text: string;
    try {
      text = await Bun.file(filePath).text();
    } catch (err) {
      return `error: ${String(err)}`;
    }

    const rangeRequested = args['start_line'] != null || args['max_lines'] != null;
    const start = (args['start_line'] as number | undefined) ?? 1;
    const limit = (args['max_lines'] as number | undefined) ?? DEFAULT_MAX_LINES;

    // split('\n') is a perfect inverse of join('\n'), so windows reconstruct the file exactly —
    // this preserves empty files (['']) and a final line with no trailing newline.
    const lines = text.split('\n');
    const total = lines.length;

    // No range requested and the whole file fits under the cap: return it verbatim, as before.
    if (!rangeRequested && total <= limit && text.length <= OUTPUT_CAP) {
      return text;
    }

    const startIdx = start - 1;
    if (startIdx >= total) {
      return `error: start_line ${start} is past end of file (${total} lines)`;
    }

    let endExcl = Math.min(startIdx + limit, total);
    let body = lines.slice(startIdx, endExcl).join('\n');
    // Enforce the output cap by dropping whole lines from the end, so range identity stays honest
    // (report the range actually returned) instead of mid-line truncation.
    while (endExcl - startIdx > 1 && body.length > OUTPUT_CAP) {
      endExcl--;
      body = lines.slice(startIdx, endExcl).join('\n');
    }
    // A single requested line longer than the cap: head-truncate it but keep its line identity.
    if (endExcl - startIdx === 1 && body.length > OUTPUT_CAP) {
      body = body.slice(0, OUTPUT_CAP) + '\n[line truncated]';
    }

    const hasMore = endExcl < total;
    const meta = hasMore
      ? `[lines ${start}-${endExcl} of ${total}; next_start_line=${endExcl + 1}]`
      : `[lines ${start}-${endExcl} of ${total}; end of file]`;
    return `${meta}\n${body}`;
  },
};

const writeFile: Tool = {
  definition: {
    type: 'function',
    function: {
      name: 'write_file',
      description: 'Write content to a file at the given path, creating it if needed.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Absolute or relative path to the file.' },
          content: { type: 'string', description: 'Content to write.' },
        },
        required: ['path', 'content'],
      },
    },
  },
  async handler(args) {
    if (typeof args['path'] !== 'string' || args['path'] === '') return missingField('path');
    // An empty file is a legitimate write, so content only has to be a string.
    if (typeof args['content'] !== 'string') return missingField('content', 'expected a string');
    const filePath = args['path'];
    const content = args['content'];
    try {
      await Bun.write(filePath, content);
      return `wrote ${content.length} bytes to ${filePath}`;
    } catch (err) {
      return `error: ${String(err)}`;
    }
  },
};

const editFile: Tool = {
  definition: {
    type: 'function',
    function: {
      name: 'edit_file',
      description:
        'Replace an exact snippet in a file. Use after reading the target file. `old_text` must match ' +
        'the current file exactly, whitespace included. The tool refuses zero matches or ambiguous ' +
        'multiple matches — include enough surrounding context that `old_text` occurs exactly once.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Absolute or relative path to the file.' },
          old_text: { type: 'string', description: 'Exact text to replace. Must occur exactly once in the file.' },
          new_text: { type: 'string', description: 'Replacement text. May be empty to delete old_text.' },
        },
        required: ['path', 'old_text', 'new_text'],
      },
    },
  },
  async handler(args) {
    if (typeof args['path'] !== 'string' || args['path'] === '') return missingField('path');
    if (typeof args['old_text'] !== 'string' || args['old_text'] === '') return missingField('old_text');
    // new_text may be empty — deleting old_text is a valid edit — so it only has to be a string.
    if (typeof args['new_text'] !== 'string') return missingField('new_text', 'expected a string');
    const filePath = args['path'];
    const oldText = args['old_text'];
    const newText = args['new_text'];

    let content: string;
    try {
      content = await Bun.file(filePath).text();
    } catch (err) {
      return `error: cannot read ${filePath}: ${String(err)}`;
    }

    // Exact, non-overlapping occurrence count. Refuse anything but a unique match — no guessing.
    const count = content.split(oldText).length - 1;
    if (count === 0) {
      return `error: no match for old_text in ${filePath}; re-read the file and copy the exact text, whitespace included`;
    }
    if (count > 1) {
      return `error: old_text is ambiguous — ${count} matches in ${filePath}; include more surrounding context so it occurs exactly once`;
    }

    // Replace by index, not String.replace, so `$&`/`$1` in new_text stay literal.
    const idx = content.indexOf(oldText);
    const updated = content.slice(0, idx) + newText + content.slice(idx + oldText.length);

    // Affected line range: 1-based start line of the match, through the last line old_text spans.
    const startLine = content.slice(0, idx).split('\n').length;
    const endLine = startLine + oldText.split('\n').length - 1;

    // Atomic write: stage in a temp file in the SAME directory, then rename over the target. A crash
    // mid-write leaves the original intact — the rename only happens once the full content is on disk.
    const tmpPath = join(dirname(filePath), `.${basename(filePath)}.edit-${process.pid}.tmp`);
    try {
      await Bun.write(tmpPath, updated);
      await rename(tmpPath, filePath);
    } catch (err) {
      try { await unlink(tmpPath); } catch { /* nothing staged to clean up */ }
      return `error: could not write ${filePath}: ${String(err)}`;
    }

    return `replaced 1 occurrence in ${filePath} (lines ${startLine}-${endLine}); ${updated.length} chars`;
  },
};

const BASH_DEFAULT_TIMEOUT_MS = 30_000;

const bash: Tool = {
  definition: {
    type: 'function',
    function: {
      name: 'bash',
      description: 'Run a shell command. Returns stdout, stderr, and exit code.',
      parameters: {
        type: 'object',
        properties: {
          cmd: { type: 'string', description: 'Shell command to run.' },
          timeout_ms: {
            type: 'number',
            description: `Timeout in milliseconds (default ${BASH_DEFAULT_TIMEOUT_MS}).`,
          },
        },
        required: ['cmd'],
      },
    },
  },
  async handler(args) {
    if (typeof args['cmd'] !== 'string' || args['cmd'] === '') return missingField('cmd');
    const cmd = args['cmd'];
    const rawTimeout = args['timeout_ms'];
    const timeoutMs = typeof rawTimeout === 'number' && rawTimeout > 0 ? rawTimeout : BASH_DEFAULT_TIMEOUT_MS;
    try {
      // detached: the child leads its own process group, so a timeout can SIGKILL the whole
      // group. Without this, killing only bash orphans backgrounded children (nmap, `sleep &`),
      // which keep the stdout pipe open and hang the read for their full lifetime.
      const proc = Bun.spawn(['bash', '-c', cmd], {
        stdout: 'pipe',
        stderr: 'pipe',
        detached: true,
      });

      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        // Negative pid targets the whole group; the leader is included. Fall back to a
        // direct kill if the group is already gone.
        try { process.kill(-proc.pid, 'SIGKILL'); } catch { /* group already gone */ }
        try { proc.kill(9); } catch { /* already gone */ }
      }, timeoutMs);

      const [stdoutBuf, stderrBuf, exitCode] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ]);
      clearTimeout(timer);

      if (timedOut) {
        const partial = cap(stdoutBuf + stderrBuf);
        return `[timed out after ${timeoutMs}ms — process group killed]${partial ? `\npartial output:\n${partial}` : ''}`;
      }

      const combined = `stdout:\n${stdoutBuf}\nstderr:\n${stderrBuf}\nexit: ${exitCode}`;
      return cap(combined);
    } catch (err) {
      return `error: ${String(err)}`;
    }
  },
};

// ── verifySpawn ───────────────────────────────────────────────────────────────
// Exported seam: wait waitMs, then check if pid is alive.
// If dead, read the errFile best-effort and return its head (500 chars or 8 lines, whichever smaller).

export type VerifySpawnResult = { ok: true } | { ok: false; errHead: string };

export async function verifySpawn(pid: number, errFile: string, waitMs: number): Promise<VerifySpawnResult> {
  await Bun.sleep(waitMs);
  try {
    process.kill(pid, 0);
    return { ok: true };
  } catch {
    // pid is dead — read errFile best-effort
    let errHead = '';
    try {
      const raw = await Bun.file(errFile).text();
      const lines = raw.split('\n');
      const byLines = lines.slice(0, 8).join('\n');
      const byChars = raw.slice(0, 500);
      errHead = byLines.length <= byChars.length ? byLines : byChars;
    } catch {
      // unreadable — return empty
    }
    return { ok: false, errHead };
  }
}

const spawnAgent: Tool = {
  definition: {
    type: 'function',
    function: {
      name: 'spawn_agent',
      description:
        'Launch a detached child agent for a task. The child runs in the background and survives this process exiting. ' +
        'Results are written to the .out file shown in the response. Depth-guarded: refuses if agent nesting is too deep.',
      parameters: {
        type: 'object',
        properties: {
          task: { type: 'string', description: 'Task for the child agent to perform.' },
          cwd: { type: 'string', description: 'Working directory for the child. Defaults to current cwd.' },
          detach: {
            type: 'boolean',
            description:
              'Fire-and-forget: if true, this child is NOT gathered into your context when you finish. Default false (its result is delivered to you automatically).',
          },
        },
        required: ['task'],
      },
    },
  },
  async handler(args) {
    if (typeof args['task'] !== 'string' || args['task'] === '') return missingField('task');
    const task = args['task'];
    const taskCwd = (args['cwd'] as string | undefined) ?? process.cwd();
    const detach = args['detach'] === true;
    const depth = Number(process.env.BREAK_AWAY_DEPTH ?? '0');
    const maxDepth = Number(process.env.BREAK_AWAY_MAX_DEPTH ?? '3');
    const transcriptDir = defaultTranscriptDir(TOOLS_SOURCE_DIR);
    const indexPath = resolve(TOOLS_SOURCE_DIR, 'index.ts');
    const ts = new Date().toISOString();

    const embedded = TOOLS_SOURCE_DIR.startsWith('/$bunfs/');
    const result = buildSpawnArgs({ task, cwd: taskCwd, transcriptDir, depth, maxDepth, ts, indexPath, embedded, execPath: process.execPath });
    if ('error' in result) return result.error;

    try {
      const proc = Bun.spawn(['bash', '-c', result.cmd], {
        stdout: 'pipe',
        stderr: 'pipe',
        env: {
          ...process.env,
          BREAK_AWAY_DEPTH: String(depth + 1),
          BREAK_AWAY_PARENT_PID: String(process.pid),
        },
      });
      const pidStr = (await new Response(proc.stdout).text()).trim();
      const pid = parseInt(pidStr, 10);
      if (!pid || isNaN(pid)) return `error: failed to get child pid (got: ${pidStr})`;

      // Record the spawn in the shared registry (best-effort).
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

      // Verify the child is still alive after a short delay — nohup echoes a pid even for corpses.
      const verify = await verifySpawn(pid, result.errFile, 700);
      if (!verify.ok) {
        const detail = verify.errHead ? `\n${verify.errHead}` : '';
        return `error: child agent (pid ${pid}) died at boot${detail}`;
      }

      const registryPath = resolve(transcriptDir, 'agents.jsonl');
      return `spawned child agent (pid ${pid})\nresults: read_file ${result.outFile}\nerrors: read_file ${result.errFile}\nstatus: read_file ${registryPath}`;
    } catch (err) {
      return `error: ${String(err)}`;
    }
  },
};

export const tools: Tool[] = [readFile, writeFile, editFile, bash, spawnAgent];
