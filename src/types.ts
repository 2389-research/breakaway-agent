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
  // Classify a no-tool finish attempt: 'done' = a real answer; 'blocked' = the model declared it
  // cannot proceed (a line beginning BLOCKED:); 'empty' = a blank turn that is not an answer.
  // One seam owns every finish state — "no tool calls" alone never means done.
  classifyFinish: (lastMessage: Message) => 'done' | 'blocked' | 'empty';
  onEvent?: (event: Record<string, unknown>) => void;
  // Transient API errors (connection drops, 429, 5xx) get retried in-loop so a single
  // gateway blip doesn't kill a long investigation. A retry does NOT consume a turn.
  apiMaxAttempts?: number; // total tries per model call, including the first (default 3)
  apiRetryBaseMs?: number; // base backoff; grows exponentially with jitter (default 750)
  // A blank finish (no tool calls, empty content) is not a real answer. The loop nudges the model
  // this many times to recover before ending with stopReason 'error' instead of a false 'done' (default 1).
  maxEmptyRetries?: number;
  // When true, a model's first no-tool finish triggers exactly one audit turn (tools re-enabled)
  // to catch false victory before the run is accepted as done. On by default (both profiles).
  completionAudit?: boolean;
  // Every N turns, inject a strategy-checkpoint prompt so a long run re-focuses and its evidence
  // trail gets a compaction anchor. 0 or undefined disables it. Default 40.
  strategyCheckpointEvery?: number;
  // Awaited inside the 'done' branch before the completion audit. Returns messages to inject (e.g.
  // finished child-agent results); the loop then continues so the model incorporates them. null or
  // empty lets the finish proceed. `emit` is the loop's own event emitter, handed in so the seam can
  // surface its own events without the loop knowing their shape.
  onFinish?: (
    messages: Message[],
    emit: (event: Record<string, unknown>) => void,
  ) => Promise<Message[] | null>;
  // Advisory only: the default onFinish ignores this and always waits a fixed 300000ms. The field
  // exists so a custom onFinish (the experiment surface) can read a wait budget from the policy;
  // overriding it alone has no effect — override onFinish too.
  childWaitMs?: number;
};

export type FinalState = {
  messages: Message[];
  turns: number;
  usage: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
  elapsed: number; // ms
  stopReason: 'done' | 'maxTurns' | 'aborted' | 'error' | 'blocked';
};
