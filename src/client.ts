// ABOUTME: OpenAI-compatible HTTP client — reads env vars, calls the chat completions endpoint.
// ABOUTME: Returns a normalized {message, usage, finish_reason} object; no streaming.

import OpenAI from 'openai';
import type { Message, ToolDefinition } from './types.ts';

const apiKey = process.env.OPENAI_COMPATIBLE_API_KEY ?? '';
const baseURL = process.env.OPENAI_COMPATIBLE_BASE_URL ?? 'https://api.openai.com/v1';
const model = process.env.OPENAI_COMPATIBLE_MODEL ?? 'gpt-4o';

const client = new OpenAI({ apiKey, baseURL });

export async function chat(
  messages: Message[],
  tools: ToolDefinition[],
  verbose = false,
): Promise<{
  message: Message;
  usage: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
  finish_reason: string;
}> {
  // Cast messages to the shape OpenAI expects — the union is compatible at runtime.
  const openaiMessages = messages as OpenAI.Chat.ChatCompletionMessageParam[];

  const params: OpenAI.Chat.ChatCompletionCreateParamsNonStreaming = {
    model,
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

  if (verbose) {
    // Some providers put reasoning in a non-standard field.
    const anyRaw = raw as Record<string, unknown>;
    if (anyRaw['reasoning'] || anyRaw['reasoning_content']) {
      const reasoning = (anyRaw['reasoning'] ?? anyRaw['reasoning_content']) as string;
      if (reasoning) {
        process.stderr.write(`[reasoning] ${reasoning}\n`);
      }
    }
  }

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
  };
}
