// ABOUTME: Tool registry — read_file, write_file, bash, spawn_agent.
// ABOUTME: Output capped at 8000 chars; bash captures stdout, stderr, and exit code.

import type { Tool } from './types.ts';
import { join, resolve } from 'node:path';
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

function cap(output: string): string {
  if (output.length <= OUTPUT_CAP) return output;
  const tail = output.slice(-OUTPUT_CAP);
  return `[truncated: showing last ${OUTPUT_CAP} of ${output.length} chars]\n` + tail;
}

const readFile: Tool = {
  definition: {
    type: 'function',
    function: {
      name: 'read_file',
      description: 'Read the contents of a file at the given path.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Absolute or relative path to the file.' },
        },
        required: ['path'],
      },
    },
  },
  async handler(args) {
    const filePath = args['path'] as string;
    try {
      const file = Bun.file(filePath);
      const text = await file.text();
      return cap(text);
    } catch (err) {
      return `error: ${String(err)}`;
    }
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
    const filePath = args['path'] as string;
    const content = args['content'] as string;
    try {
      await Bun.write(filePath, content);
      return `wrote ${content.length} bytes to ${filePath}`;
    } catch (err) {
      return `error: ${String(err)}`;
    }
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
    const cmd = args['cmd'] as string;
    const timeoutMs = (args['timeout_ms'] as number | undefined) ?? BASH_DEFAULT_TIMEOUT_MS;
    try {
      const proc = Bun.spawn(['bash', '-c', cmd], {
        stdout: 'pipe',
        stderr: 'pipe',
      });

      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        proc.kill();
      }, timeoutMs);

      const [stdoutBuf, stderrBuf, exitCode] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ]);
      clearTimeout(timer);

      if (timedOut) {
        const partial = cap(stdoutBuf + stderrBuf);
        return `[timed out after ${timeoutMs}ms — process killed]${partial ? `\npartial output:\n${partial}` : ''}`;
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
        },
        required: ['task'],
      },
    },
  },
  async handler(args) {
    const task = args['task'] as string;
    const taskCwd = (args['cwd'] as string | undefined) ?? process.cwd();
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

export const tools: Tool[] = [readFile, writeFile, bash, spawnAgent];
