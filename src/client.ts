// ABOUTME: OpenAI-compatible HTTP client — reads env vars lazily at call time, not import time.
// ABOUTME: buildClientConfig() and chat() accept a modelOverride so --model flows through cleanly.

import OpenAI from 'openai';
import type { Message, ToolDefinition } from './types.ts';

export type ClientConfig = {
  model: string;
  apiKey: string;
  baseURL: string;
};

export function buildClientConfig(opts: { modelOverride?: string | null }): ClientConfig {
  const model = opts.modelOverride ?? process.env.OPENAI_COMPATIBLE_MODEL ?? 'gpt-4o';
  const apiKey = process.env.OPENAI_COMPATIBLE_API_KEY ?? '';
  const baseURL = process.env.OPENAI_COMPATIBLE_BASE_URL ?? 'https://api.openai.com/v1';
  return { model, apiKey, baseURL };
}

export async function chat(
  messages: Message[],
  tools: ToolDefinition[],
  modelOverride?: string | null,
): Promise<{
  message: Message;
  usage: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
  finish_reason: string;
  reasoning: string;
}> {
  const config = buildClientConfig({ modelOverride });
  const client = new OpenAI({ apiKey: config.apiKey, baseURL: config.baseURL });

  // Cast messages to the shape OpenAI expects — the union is compatible at runtime.
  const openaiMessages = messages as OpenAI.Chat.ChatCompletionMessageParam[];

  const params: OpenAI.Chat.ChatCompletionCreateParamsNonStreaming = {
    model: config.model,
    messages: openaiMessages,
    stream: false,
  };

  if (tools.length > 0) {
    params.tools = tools as OpenAI.Chat.ChatCompletionTool[];
    params.tool_choice = 'auto';
  }

  const response = await client.chat.completions.create(params);

  const choice = response.choices[0];
  const raw = choice.message;

  // Extract reasoning from non-standard field (lunaroute/GLM gateway uses 'reasoning').
  const anyRaw = raw as Record<string, unknown>;
  const reasoning = typeof anyRaw['reasoning'] === 'string' ? anyRaw['reasoning'] : '';

  const message: Message = {
    role: raw.role,
    content: raw.content ?? '',
  };

  if (raw.tool_calls && raw.tool_calls.length > 0) {
    message.tool_calls = raw.tool_calls.map((tc) => ({
      id: tc.id,
      type: 'function' as const,
      function: {
        name: tc.function.name,
        arguments: tc.function.arguments,
      },
    }));
  }

  const usage = response.usage ?? { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };

  return {
    message,
    usage: {
      prompt_tokens: usage.prompt_tokens,
      completion_tokens: usage.completion_tokens,
      total_tokens: usage.total_tokens,
    },
    finish_reason: choice.finish_reason ?? 'stop',
    reasoning,
  };
}
