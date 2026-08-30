// ABOUTME: CLI entry point — parses args, builds initial messages, runs REPL or one-shot mode.
// ABOUTME: Stats and progress go to stderr; only the final prose answer goes to stdout.

import { run } from './agent.ts';
import { tools } from './tools.ts';
import { defaultPolicy } from './policy.ts';
import type { Message, FinalState, Policy, Tool } from './types.ts';
import { openTranscript, writeEvent, closeTranscript, defaultTranscriptDir } from './transcript.ts';
import { render, buildRenderConfig, type Tier } from './render.ts';
import { appendRecord, readRegistry, deriveAgentStates, diffAgentStates, type AgentState } from './registry.ts';
import defaultSystemText from '../system.txt' with { type: 'text' };
import { readFileSync, existsSync } from 'node:fs';
import { resolve, join } from 'node:path';

// Anchor paths before any chdir so they survive --cwd.
const SOURCE_DIR = import.meta.dir;

export function isEmbedded(): boolean {
  return import.meta.dir.startsWith('/$bunfs/');
}

export const RESTART_EXIT_CODE = 42;

// Exit with RESTART_EXIT_CODE on SIGUSR2 so the wrapper script (bin/break-away-loop) relaunches.
process.on('SIGUSR2', () => {
  process.exit(RESTART_EXIT_CODE);
});

const DEFAULT_SYSTEM_PATH = join(SOURCE_DIR, '../system.txt');

// Mutable refs updated by doReload; runTask/repl read from here so hot-reload takes effect.
export const currentRefs: { tools: Tool[]; systemPrompt: string; policy: Policy } = {
  tools,
  systemPrompt: '',
  policy: defaultPolicy,
};

export async function doReload(toolsPath: string, policyPath: string, systemPath: string): Promise<boolean> {
  try {
    const ts = Date.now();
    const [toolsMod, policyMod] = await Promise.all([
      import(toolsPath + '?v=' + ts),
      import(policyPath + '?v=' + ts),
    ]);
    const newTools: Tool[] = toolsMod.tools;
    const newPolicy: Policy = policyMod.defaultPolicy;
    const newSystemPrompt = readFileSync(systemPath, 'utf8').trim();
    currentRefs.tools = newTools;
    currentRefs.policy = newPolicy;
    currentRefs.systemPrompt = newSystemPrompt;
    process.stderr.write('[reload] hot-reloaded seams\n');
    return true;
  } catch (err) {
    process.stderr.write(`[reload] failed: ${err}\n`);
    return false;
  }
}

// SIGHUP handler: hot-reload seams. Registered at module load with default paths;
// main() re-registers with the actual systemPath after parsing args.
let _sighupSystemPath = DEFAULT_SYSTEM_PATH;
process.on('SIGHUP', () => {
  if (isEmbedded()) {
    process.stderr.write('[reload] compiled binary — reload unavailable; rebuild instead\n');
    return;
  }
  doReload(resolve(SOURCE_DIR, 'tools.ts'), resolve(SOURCE_DIR, 'policy.ts'), _sighupSystemPath);
});

export function formatStats(state: FinalState): string {
  const secs = (state.elapsed / 1000).toFixed(1);
  return `done in ${state.turns} turns, ${state.usage.total_tokens} tokens (prompt: ${state.usage.prompt_tokens} / completion: ${state.usage.completion_tokens}), ${secs}s`;
}

const USAGE = `
Usage: bun src/index.ts [OPTIONS] [TASK]

  TASK             Task string for one-shot mode. Omit for REPL.

Options:
  --cwd <path>     Change working directory before running tools.
  --model <name>   Override the model (env: OPENAI_COMPATIBLE_MODEL).
  --system <path>  Path to system prompt file (default: system.txt).
  --max-turns <n>  Override the loop turn budget (default: policy's maxTurns).
  --quiet          Minimal output — tool calls and stats only.
  --debug          Full output — reasoning, api_ms, longer excerpts.
  --help           Print this help and exit.
`.trim();

export type ParsedArgs = {
  task: string | null;
  systemPath: string;
  tier: Tier;
  model: string | null;
  cwd: string | null;
  maxTurns: number | null;
  help: boolean;
  unknownFlag: string | null;
};

export function parseArgs(argv: string[]): ParsedArgs {
  let task: string | null = null;
  let systemPath = DEFAULT_SYSTEM_PATH;
  let tier: Tier = 'rich';
  let model: string | null = null;
  let cwd: string | null = null;
  let maxTurns: number | null = null;
  let help = false;
  let unknownFlag: string | null = null;

  const args = argv.slice(2);
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--quiet') {
      if (tier === 'debug') {
        unknownFlag = '--quiet and --debug are mutually exclusive';
      } else {
        tier = 'quiet';
      }
    } else if (args[i] === '--debug') {
      if (tier === 'quiet') {
        unknownFlag = '--quiet and --debug are mutually exclusive';
      } else {
        tier = 'debug';
      }
    } else if (args[i] === '--help') {
      help = true;
    } else if (args[i] === '--system' && args[i + 1]) {
      systemPath = args[++i];
    } else if (args[i] === '--model' && args[i + 1]) {
      model = args[++i];
    } else if (args[i] === '--cwd' && args[i + 1]) {
      cwd = args[++i];
    } else if (args[i] === '--max-turns' && args[i + 1]) {
      const n = Number(args[++i]);
      if (!Number.isInteger(n) || n < 1) {
        unknownFlag = `--max-turns (invalid value: ${args[i]})`;
      } else {
        maxTurns = n;
      }
    } else if (args[i].startsWith('--')) {
      unknownFlag = args[i];
    } else {
      task = args[i];
    }
  }

  return { task, systemPath, tier, model, cwd, maxTurns, help, unknownFlag };
}

export function loadSystemPrompt(path: string, isDefault: boolean): string {
  try {
    return readFileSync(path, 'utf8').trim();
  } catch (err) {
    if (isDefault) return defaultSystemText.trim();
    process.stderr.write(`error: cannot read system prompt: ${path}: ${err}\n`);
    process.exit(1);
  }
}

function transcriptDir(): string {
  return defaultTranscriptDir(SOURCE_DIR);
}

function registryPath(): string {
  return join(transcriptDir(), 'agents.jsonl');
}

// ── Poller ────────────────────────────────────────────────────────────────────

// Starts a 2s interval that reads the registry and prints state changes
// for direct children (parent_pid === process.pid). Stderr only, all tiers.
// Returns a stop function. The interval is unref'd so it won't keep the process alive.
function startPoller(): () => void {
  let prevStates = new Map<number, AgentState>();

  const tick = async () => {
    try {
      const records = await readRegistry(registryPath());
      const nextStates = deriveAgentStates(records);
      const lines = diffAgentStates(prevStates, nextStates, process.pid);
      for (const line of lines) {
        process.stderr.write(line + '\n');
      }
      prevStates = nextStates;
    } catch {
      // best-effort — swallow
    }
  };

  const handle = setInterval(tick, 2000);
  // Bun supports unref() — verified below; prevents timer from keeping process alive.
  if (typeof handle.unref === 'function') handle.unref();

  return () => clearInterval(handle);
}

// ── /agents REPL command ──────────────────────────────────────────────────────

async function printAgentsTree(): Promise<void> {
  const records = await readRegistry(registryPath());
  const states = deriveAgentStates(records);

  // Build full descendant tree rooted at our pid.
  function descendants(pid: number): number[] {
    const result: number[] = [];
    for (const [p, s] of states) {
      if (s.parentPid === pid) {
        result.push(p);
        result.push(...descendants(p));
      }
    }
    return result;
  }

  const ours = new Set([process.pid, ...descendants(process.pid)]);

  // Print root (us) first.
  const stateMarker = (s: AgentState['state']) => ({ running: '●', done: '✔', died: '✗' }[s]);
  const age = (ts: string) => {
    const ms = Date.now() - new Date(ts).getTime();
    return Math.round(ms / 1000) + 's';
  };
  const taskSnippet = (t: string) => (t.length > 60 ? t.slice(0, 57) + '…' : t);

  // Walk depth-first from our pid.
  function printNode(pid: number, depth: number) {
    const s = states.get(pid);
    const indent = '  '.repeat(depth);
    if (pid === process.pid) {
      process.stderr.write(`${indent}${stateMarker('running')} ${pid} (self)  ${taskSnippet(s?.task ?? 'repl')}\n`);
    } else if (s) {
      process.stderr.write(`${indent}${stateMarker(s.state)} ${pid}  ${s.state}  ${age(s.startTs)}  ${taskSnippet(s.task)}\n`);
    }
    for (const [childPid, cs] of states) {
      if (cs.parentPid === pid) printNode(childPid, depth + 1);
    }
  }

  // Check if our self entry exists (it should from agent_start at boot).
  if (!states.has(process.pid)) {
    process.stderr.write(`(self not yet registered in registry)\n`);
  }
  printNode(process.pid, 0);

  // Count live agents outside our tree.
  let outsiders = 0;
  for (const [pid, s] of states) {
    if (!ours.has(pid) && s.state === 'running') outsiders++;
  }
  if (outsiders > 0) {
    process.stderr.write(`other live agents in registry: ${outsiders}\n`);
  }
}

async function runTask(
  task: string,
  systemPrompt: string,
  model: string | null,
  tier: Tier,
  basePolicy: Policy = defaultPolicy,
): Promise<FinalState> {
  const messages: Message[] = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: task },
  ];

  const handle = await openTranscript(transcriptDir());
  const renderCfg = buildRenderConfig(tier);

  const startEvent = {
    event: 'run_start',
    task,
    model: model ?? process.env.OPENAI_COMPATIBLE_MODEL ?? 'gpt-4o',
    cwd: process.cwd(),
  };
  await writeEvent(handle, startEvent);
  render(startEvent, renderCfg, (s) => process.stderr.write(s));

  const stopPoller = startPoller();

  const policy = {
    ...basePolicy,
    onEvent: (e: Record<string, unknown>) => {
      writeEvent(handle, e);
      render(e, renderCfg, (s) => process.stderr.write(s));
    },
  };
  const state = await run(messages, currentRefs.tools, policy, model);

  stopPoller();

  const doneEvent = {
    event: 'done',
    turns: state.turns,
    tokens: state.usage.total_tokens,
    duration_ms: state.elapsed,
  };
  await writeEvent(handle, doneEvent);
  render(doneEvent, renderCfg, (s) => process.stderr.write(s));

  // agent_done registry record.
  await appendRecord(registryPath(), { event: 'agent_done', pid: process.pid, ts: new Date().toISOString() });

  // End-of-run summary: list still-running direct children.
  const records = await readRegistry(registryPath());
  const states = deriveAgentStates(records);
  const stillRunning: AgentState[] = [];
  for (const s of states.values()) {
    if (s.parentPid === process.pid && s.state === 'running') {
      stillRunning.push(s);
    }
  }
  if (stillRunning.length > 0) {
    const noun = stillRunning.length === 1 ? 'child still running' : 'children still running';
    process.stderr.write(`${stillRunning.length} ${noun}:\n`);
    for (const s of stillRunning) {
      const errLine = s.errFile ? `  tail -f ${s.errFile}` : '';
      process.stderr.write(`  pid ${s.pid}${errLine}\n`);
    }
  }

  await closeTranscript(handle);

  return state;
}

async function repl(systemPrompt: string, systemPath: string, model: string | null, tier: Tier, basePolicy: Policy = defaultPolicy): Promise<void> {
  const messages: Message[] = [{ role: 'system', content: systemPrompt }];

  const handle = await openTranscript(transcriptDir());
  const renderCfg = buildRenderConfig(tier);

  const startEvent = {
    event: 'run_start',
    task: 'repl',
    model: model ?? process.env.OPENAI_COMPATIBLE_MODEL ?? 'gpt-4o',
    cwd: process.cwd(),
  };
  await writeEvent(handle, startEvent);
  render(startEvent, renderCfg, (s) => process.stderr.write(s));

  process.stderr.write('break-away repl — ctrl+D to exit\n');

  const stopPoller = startPoller();

  for await (const line of console) {
    const task = line.trim();
    if (!task) {
      process.stderr.write('> ');
      continue;
    }

    if (task === '/reload') {
      await doReload(
        resolve(SOURCE_DIR, 'tools.ts'),
        resolve(SOURCE_DIR, 'policy.ts'),
        systemPath,
      );
      process.stderr.write('> ');
      continue;
    }
    if (task === '/restart') {
      process.exit(RESTART_EXIT_CODE);
    }
    if (task === '/agents') {
      await printAgentsTree();
      process.stderr.write('> ');
      continue;
    }

    messages.push({ role: 'user', content: task });

    const replPolicy = {
      ...basePolicy,
      onEvent: (e: Record<string, unknown>) => {
        writeEvent(handle, e);
        render(e, renderCfg, (s) => process.stderr.write(s));
      },
    };
    const state = await run(messages, currentRefs.tools, replPolicy, model);

    // Append the assistant's final reply to messages for continuity
    const lastAssistant = [...state.messages].reverse().find((m) => m.role === 'assistant');
    if (lastAssistant) {
      // state.messages already has it; splice back in for next round
      messages.length = 0;
      messages.push(...state.messages);
    }

    const lastMsg = state.messages[state.messages.length - 1];
    if (lastMsg && lastMsg.content) {
      process.stdout.write(lastMsg.content + '\n');
    }

    const doneEvent = {
      event: 'done',
      turns: state.turns,
      tokens: state.usage.total_tokens,
      duration_ms: state.elapsed,
    };
    await writeEvent(handle, doneEvent);
    render(doneEvent, renderCfg, (s) => process.stderr.write(s));

    process.stderr.write('> ');
  }

  stopPoller();
  await appendRecord(registryPath(), { event: 'agent_done', pid: process.pid, ts: new Date().toISOString() });
  await closeTranscript(handle);
}

async function main(): Promise<void> {
  const { task, systemPath, tier, model, cwd, maxTurns, help, unknownFlag } = parseArgs(process.argv);

  if (unknownFlag) {
    process.stderr.write(`error: unknown flag: ${unknownFlag}\n\n${USAGE}\n`);
    process.exit(1);
  }

  if (help) {
    process.stderr.write(USAGE + '\n');
    process.exit(0);
  }

  if (cwd) {
    const resolved = resolve(cwd);
    if (!existsSync(resolved)) {
      process.stderr.write(`error: --cwd path does not exist: ${resolved}\n\n${USAGE}\n`);
      process.exit(1);
    }
    process.chdir(resolved);
  }

  const isDefaultSystem = systemPath === DEFAULT_SYSTEM_PATH;
  const systemPrompt = loadSystemPrompt(systemPath, isDefaultSystem);
  currentRefs.systemPrompt = systemPrompt;
  const policy = maxTurns !== null ? { ...defaultPolicy, maxTurns } : defaultPolicy;
  currentRefs.policy = policy;

  // Update the SIGHUP handler's systemPath now that we know it.
  _sighupSystemPath = systemPath;

  // Record boot in the shared registry.
  const parentPidEnv = process.env.BREAK_AWAY_PARENT_PID;
  const parentPidVal = parentPidEnv ? Number(parentPidEnv) : null;
  await appendRecord(registryPath(), {
    event: 'agent_start',
    pid: process.pid,
    parent_pid: parentPidVal,
    depth: Number(process.env.BREAK_AWAY_DEPTH ?? '0'),
    task: task ?? 'repl',
    cwd: process.cwd(),
    ts: new Date().toISOString(),
  });

  if (task) {
    const state = await runTask(task, systemPrompt, model, tier, policy);
    const lastMsg = state.messages[state.messages.length - 1];
    if (lastMsg && lastMsg.content) {
      process.stdout.write(lastMsg.content + '\n');
    }
  } else {
    await repl(systemPrompt, systemPath, model, tier, policy);
  }
}

if (import.meta.main) {
  main().catch((err) => {
    process.stderr.write(`fatal: ${err}\n`);
    process.exit(1);
  });
}
