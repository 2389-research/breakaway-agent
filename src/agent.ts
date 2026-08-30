// ABOUTME: The agent loop — applies policy, calls the LLM, dispatches tool calls, accumulates state.
// ABOUTME: run(messages, tools, policy) => FinalState. All behavior is injected through Policy.

import { chat } from './client.ts';
import type { Message, Tool, Policy, FinalState, ToolCall } from './types.ts';

let verbose = false;

export function setVerbose(v: boolean): void {
  verbose = v;
}

function argsPreview(argsJson: string): string {
  const MAX = 60;
  if (argsJson.length <= MAX) return argsJson;
  return argsJson.slice(0, MAX) + '...';
}

async function executeToolCall(
  tc: ToolCall,
  tools: Tool[],
): Promise<{ result: string; isError: boolean }> {
  const tool = tools.find((t) => t.definition.function.name === tc.function.name);

  if (!tool) {
    return { result: `error: unknown tool "${tc.function.name}"`, isError: true };
  }

  let args: Record<string, unknown> = {};
  try {
    args = JSON.parse(tc.function.arguments);
  } catch {
    return { result: `error: could not parse tool arguments: ${tc.function.arguments}`, isError: true };
  }

  process.stderr.write(`[tool] ${tc.function.name} ${argsPreview(tc.function.arguments)}\n`);

  try {
    const result = await tool.handler(args);
    return { result, isError: false };
  } catch (err) {
    return { result: `error: ${String(err)}`, isError: true };
  }
}

function toolResultMessage(tc: ToolCall, result: string): Message {
  return {
    role: 'tool',
    content: result,
    tool_call_id: tc.id,
    name: tc.function.name,
  };
}

export async function run(
  messages: Message[],
  tools: Tool[],
  policy: Policy,
  modelOverride?: string | null,
): Promise<FinalState> {
  const start = Date.now();
  const allMessages = [...messages];
  const toolDefs = tools.map((t) => t.definition);
  const usage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
  let turns = 0;

  while (turns < policy.maxTurns) {
    const contextMessages = policy.contextStrategy(allMessages);

    let response: Awaited<ReturnType<typeof chat>>;
    try {
      response = await chat(contextMessages, toolDefs, verbose, modelOverride);
    } catch (err) {
      allMessages.push({ role: 'assistant', content: `error: ${String(err)}` });
      return {
        messages: allMessages,
        turns,
        usage,
        elapsed: Date.now() - start,
        stopReason: 'error',
      };
    }

    usage.prompt_tokens += response.usage.prompt_tokens;
    usage.completion_tokens += response.usage.completion_tokens;
    usage.total_tokens += response.usage.total_tokens;

    allMessages.push(response.message);
    turns++;

    const finishReason = response.finish_reason;

    if (finishReason === 'tool_calls' || response.message.tool_calls?.length) {
      const tcs = response.message.tool_calls ?? [];

      for (const tc of tcs) {
        const { result, isError } = await executeToolCall(tc, tools);

        const isKnownTool = !!tools.find((t) => t.definition.function.name === tc.function.name);
        if (isError && isKnownTool) {
          // Known tool that errored — apply error policy
          if (policy.onToolError === 'abort') {
            allMessages.push(toolResultMessage(tc, result));
            return {
              messages: allMessages,
              turns,
              usage,
              elapsed: Date.now() - start,
              stopReason: 'aborted',
            };
          } else if (policy.onToolError === 'retry') {
            // Retry once
            process.stderr.write(`[tool] retrying ${tc.function.name}...\n`);
            const retry = await executeToolCall(tc, tools);
            allMessages.push(toolResultMessage(tc, retry.result));
          } else if (policy.onToolError === 'nudge') {
            allMessages.push(toolResultMessage(tc, result));
            allMessages.push({ role: 'user', content: 'that tool errored, try again' });
          }
        } else {
          // Unknown tool or success — push result and continue
          allMessages.push(toolResultMessage(tc, result));
        }
      }

      continue;
    }

    // No tool calls — check shouldContinue
    if (!policy.shouldContinue(response.message)) {
      return {
        messages: allMessages,
        turns,
        usage,
        elapsed: Date.now() - start,
        stopReason: 'done',
      };
    }
  }

  return {
    messages: allMessages,
    turns,
    usage,
    elapsed: Date.now() - start,
    stopReason: 'maxTurns',
  };
}
