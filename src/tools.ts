// ABOUTME: Tool registry — read_file, write_file, edit_file, bash, restart_self. Each tool has a definition and handler.
// ABOUTME: Output capped at 8000 chars; bash captures stdout, stderr, and exit code.

import type { Tool } from './types.ts';

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


const editFile: Tool = {
  definition: {
    type: 'function',
    function: {
      name: 'edit_file',
      description:
        'Edit a file by replacing an exact string. old_string must match exactly (including whitespace) and, unless replace_all is true, must appear exactly once in the file.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Absolute or relative path to the file.' },
          old_string: { type: 'string', description: 'Exact text to replace.' },
          new_string: { type: 'string', description: 'Replacement text.' },
          replace_all: {
            type: 'boolean',
            description: 'Replace every occurrence (default false: requires exactly one match).',
          },
        },
        required: ['path', 'old_string', 'new_string'],
      },
    },
  },
  async handler(args) {
    const filePath = args['path'] as string;
    const oldString = args['old_string'] as string;
    const newString = args['new_string'] as string;
    const replaceAll = Boolean(args['replace_all']);
    try {
      if (oldString === '') return 'error: old_string must be non-empty (use write_file to create files)';
      const file = Bun.file(filePath);
      const text = await file.text();
      const count = text.split(oldString).length - 1;
      if (count === 0) return `error: old_string not found in ${filePath}`;
      if (count > 1 && !replaceAll) return `error: old_string occurs ${count} times in ${filePath}; pass replace_all or include more surrounding context`;
      const updated = text.replaceAll(oldString, newString);
      await Bun.write(filePath, updated);
      return `edited ${filePath}: ${count} occurrence${count === 1 ? '' : 's'} replaced`;
    } catch (err) {
      return `error: ${String(err)}`;
    }
  },
};

// restart_self: re-exec this process with the same argv so a fresh Bun runtime
// picks up edits to the agent's own source (bun runs from source, so new code
// just works). Budget-guarded via BREAK_AWAY_RESTARTS so a model can't loop
// forever respawning itself.
const RESTART_BUDGET = 3;

const restartSelf: Tool = {
  definition: {
    type: 'function',
    function: {
      name: 'restart_self',
      description:
        'Restart the agent process so it picks up changes to its own source code (src/, system.txt, tools). ' +
        'Spawns a fresh copy of this process with the same arguments (in one-shot mode the task re-runs from the start; ' +
        'in REPL mode a fresh REPL starts, conversation history is lost), then exits the current process. ' +
        'Call this AFTER editing your own files, not instead of. Limited restarts per run.',
      parameters: {
        type: 'object',
        properties: {
          note: {
            type: 'string',
            description: 'Optional note printed to stderr before restarting (e.g. what changed).',
          },
        },
      },
    },
  },
  async handler(args) {
    const note = typeof args['note'] === 'string' ? args['note'] : '';
    const restarts = Number(process.env.BREAK_AWAY_RESTARTS ?? '0');
    if (restarts >= RESTART_BUDGET) {
      return `error: restart budget exhausted (${restarts}/${RESTART_BUDGET} restarts used); finish the task with the current code`;
    }
    try {
      if (note) process.stderr.write(`[restart_self] ${note}\n`);
      const child = Bun.spawn([process.execPath, ...process.argv.slice(1)], {
        stdio: ['inherit', 'inherit', 'inherit'],
        env: { ...process.env, BREAK_AWAY_RESTARTS: String(restarts + 1) },
      });
      child.unref();
      process.stderr.write(
        `[restart_self] respawning as pid ${child.pid} (restart ${restarts + 1}/${RESTART_BUDGET}); exiting\n`,
      );
      // Let the child get a head start so its transcript open() doesn't race ours.
      await Bun.sleep(150);
      process.exit(0);
    } catch (err) {
      return `error: ${String(err)}`;
    }
  },
};

export const tools: Tool[] = [readFile, writeFile, editFile, bash, restartSelf];
