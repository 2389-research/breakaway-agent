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
};

export type FinalState = {
  messages: Message[];
  turns: number;
  usage: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
  elapsed: number; // ms
  stopReason: 'done' | 'maxTurns' | 'aborted' | 'error';
};
