// ABOUTME: Shared types for break-away-seams — messages, tools, policy, and final state.
// ABOUTME: All other modules import from here; nothing else imports from multiple places.

export type Message = {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
  name?: string;
};

export type ToolCall = {
  id: string;
  type: 'function';
  function: {
    name: string;
    arguments: string;
  };
};

export type ToolDefinition = {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: object;
  };
};

export type Tool = {
  definition: ToolDefinition;
  handler: (args: Record<string, unknown>) => Promise<string>;
};

export type Policy = {
  maxTurns: number;
  onToolError: 'retry' | 'abort' | 'nudge';
  contextStrategy: (messages: Message[]) => Message[];
  shouldContinue: (lastMessage: Message) => boolean;
  onEvent?: (event: Record<string, unknown>) => void;
  // Transient API errors (connection drops, 429, 5xx) get retried in-loop so a single
  // gateway blip doesn't kill a long investigation. A retry does NOT consume a turn.
  apiMaxAttempts?: number; // total tries per model call, including the first (default 3)
  apiRetryBaseMs?: number; // base backoff; grows exponentially with jitter (default 750)
};

export type FinalState = {
  messages: Message[];
  turns: number;
  usage: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
  elapsed: number; // ms
  stopReason: 'done' | 'maxTurns' | 'aborted' | 'error';
};
