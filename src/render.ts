// ABOUTME: Stderr renderer — pure function of (event, config, writer) => void.
// ABOUTME: Three tiers: quiet / rich (default) / debug. Color only when TTY and NO_COLOR unset.

export type Tier = 'quiet' | 'rich' | 'debug';

export type RenderConfig = {
  tier: Tier;
  tty: boolean; // true = ANSI OK; false = plain text
};

// Build RenderConfig from the current process environment.
export function buildRenderConfig(tier: Tier): RenderConfig {
  const tty = !!process.stderr.isTTY && !process.env.NO_COLOR;
  return { tier, tty };
}

// ANSI helpers — only emit codes when tty=true.
function ansi(config: RenderConfig, code: string): string {
  return config.tty ? `\x1b[${code}m` : '';
}

const DIM = (c: RenderConfig) => ansi(c, '2');
const RESET = (c: RenderConfig) => ansi(c, '0');
const BOLD = (c: RenderConfig) => ansi(c, '1');
const CYAN = (c: RenderConfig) => ansi(c, '36');
const YELLOW = (c: RenderConfig) => ansi(c, '33');
const RED = (c: RenderConfig) => ansi(c, '31');

function argsCompact(args: unknown, maxChars = 80): string {
  try {
    const s = JSON.stringify(args);
    if (s.length <= maxChars) return s;
    return s.slice(0, maxChars) + '…';
  } catch {
    return String(args);
  }
}

const SNIPPET_CHARS = 300;
const SNIPPET_LINES = 6;

function snippet(text: string): { text: string; elided: boolean } {
  const lines = text.split('\n');
  if (lines.length > SNIPPET_LINES) {
    return { text: lines.slice(0, SNIPPET_LINES).join('\n'), elided: true };
  }
  if (text.length > SNIPPET_CHARS) {
    return { text: text.slice(0, SNIPPET_CHARS), elided: true };
  }
  return { text, elided: false };
}

type Writer = (s: string) => void;

// Pure renderer — emits to writer (typically a stderr.write bind).
export function render(event: Record<string, unknown>, config: RenderConfig, writer: Writer): void {
  const ev = event.event as string;

  switch (ev) {
    case 'run_start': {
      if (config.tier === 'quiet') return;
      const task = String(event.task ?? '');
      if (config.tier === 'debug') {
        const model = String(event.model ?? '');
        writer(`${BOLD(config)}▶ run${RESET(config)} ${task}  ${DIM(config)}[${model}]${RESET(config)}\n`);
      } else {
        writer(`${BOLD(config)}▶ run${RESET(config)} ${task}\n`);
      }
      return;
    }

    case 'done': {
      const turns = event.turns as number;
      const tokens = event.tokens as number;
      const ms = event.duration_ms as number;
      const secs = (ms / 1000).toFixed(1);
      writer(`${DIM(config)}done in ${turns} turns, ${tokens} tokens, ${secs}s${RESET(config)}\n`);
      return;
    }

    case 'tool_call': {
      const name = String(event.name ?? '');
      const args = event.args;
      const compact = argsCompact(args, config.tier === 'debug' ? 120 : 80);
      writer(`${CYAN(config)}[tool]${RESET(config)} ${BOLD(config)}${name}${RESET(config)} ${DIM(config)}${compact}${RESET(config)}\n`);
      return;
    }

    case 'tool_result': {
      const name = String(event.name ?? '');
      const result = String(event.result ?? '');

      // spawn_agent success: first-class block shown in all tiers (it's signal).
      if (name === 'spawn_agent' && result.startsWith('spawned child agent')) {
        // Parse pid from first line "spawned child agent (pid <n>)"
        const pidMatch = result.match(/pid (\d+)/);
        const pid = pidMatch ? pidMatch[1] : '?';
        // Parse out path from "results: read_file <path>"
        const outMatch = result.match(/results: read_file (.+)/);
        const outPath = outMatch ? outMatch[1] : '';
        writer(`${BOLD(config)}◆ spawned agent ${pid}${RESET(config)}\n`);
        if (config.tier !== 'quiet' && outPath) {
          writer(`  ${DIM(config)}out: ${outPath}${RESET(config)}\n`);
        }
        if (config.tier === 'debug') {
          const { text, elided } = snippet(result);
          const indented = text.split('\n').map((l) => `  ${l}`).join('\n');
          writer(`${DIM(config)}${indented}${RESET(config)}\n`);
          if (elided) writer(`  ${DIM(config)}…${RESET(config)}\n`);
        }
        return;
      }

      if (config.tier === 'quiet') return;
      const truncated = !!event.truncated;
      const chars = event.chars as number;
      const { text, elided } = snippet(result);
      const charInfo = config.tier === 'debug' ? ` ${DIM(config)}(${chars} chars)${RESET(config)}` : '';
      const truncatedMark = truncated ? ` ${YELLOW(config)}[truncated]${RESET(config)}` : '';
      writer(`  ${DIM(config)}↳ ${name}${charInfo}${truncatedMark}${RESET(config)}\n`);
      if (text) {
        const indented = text.split('\n').map((l) => `  ${l}`).join('\n');
        writer(`${DIM(config)}${indented}${RESET(config)}\n`);
      }
      if (elided) {
        writer(`  ${DIM(config)}…${RESET(config)}\n`);
      }
      return;
    }

    case 'assistant': {
      if (config.tier === 'quiet') return;
      const reasoning = String(event.reasoning ?? '');
      const content = String(event.content ?? '');
      const apiMs = event.api_ms as number | undefined;

      if (reasoning) {
        writer(`${DIM(config)}  reasoning: ${reasoning}${RESET(config)}\n`);
      }
      if (content) {
        writer(`${BOLD(config)}  ↩${RESET(config)} ${content}\n`);
      }
      if (config.tier === 'debug' && typeof apiMs === 'number') {
        writer(`${DIM(config)}  api: ${apiMs}ms${RESET(config)}\n`);
      }
      return;
    }

    case 'tool_retry': {
      if (config.tier === 'quiet') return;
      const tool = String(event.tool ?? '');
      const attempt = event.attempt;
      writer(`${YELLOW(config)}  ↺ retry${RESET(config)} ${tool} (attempt ${attempt})\n`);
      return;
    }

    case 'nudge': {
      if (config.tier === 'quiet') return;
      const tool = String(event.tool ?? '');
      writer(`${YELLOW(config)}  nudge${RESET(config)} after ${tool} error\n`);
      return;
    }

    default:
      // Unknown event type — silently ignore.
      return;
  }
}
