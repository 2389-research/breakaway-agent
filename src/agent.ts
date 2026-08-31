// ABOUTME: The agent loop — applies policy, calls the LLM, dispatches tool calls, accumulates state.
// ABOUTME: run(messages, tools, policy) => FinalState. All behavior is injected through Policy.

import { chat } from './client.ts';
import { redactSecrets } from './redact.ts';
import type { Message, Tool, Policy, FinalState, ToolCall, ToolDefinition } from './types.ts';

// Injected once when the model first tries to finish under a completion-audit policy, forcing it
// to prove the task is actually done (with tools) before we accept a no-tool answer as complete.
const COMPLETION_AUDIT_PROMPT =
  'Before finalizing, audit the task against the requested observable outcome. ' +
  'Use tools now if any important behavior has not been empirically verified. ' +
  'Check the final diff/state and relevant tests. If the result is already proven, ' +
  'finish with the concise evidence.';

function emitEvent(policy: Policy, event: Record<string, unknown>): void {
  if (!policy.onEvent) return;
  try {
    policy.onEvent(event);
  } catch {
    // best-effort — observer errors must not kill the loop
  }
}

// A transient error is worth retrying; a permanent one (bad key, bad request) is not.
// Classification mirrors the OpenAI SDK's own shouldRetry: connection errors (no numeric
// status) plus 408/409/429 and any 5xx. Everything else (401, 400, 404, ...) is permanent.
function isTransientApiError(err: unknown): boolean {
  const status = (err as { status?: unknown } | null)?.status;
  if (typeof status !== 'number') return true; // connection/network failure — no HTTP status
  if (status === 408 || status === 409 || status === 429) return true;
  return status >= 500;
}

// A safe, payload-free reason for the api_retry event — status only, never the error body,
// so provider payloads and any embedded key material never reach the transcript.
function apiErrorReason(err: unknown): string {
  const status = (err as { status?: unknown } | null)?.status;
  return typeof status === 'number' ? `HTTP ${status}` : 'connection error';
}

// Call the model with bounded retries for transient failures. Retries happen here, below the
// turn loop, so a blip costs backoff time but never a turn. Permanent errors rethrow immediately.
async function callChatWithRetry(
  messages: Message[],
  toolDefs: ToolDefinition[],
  modelOverride: string | null | undefined,
  policy: Policy,
): Promise<Awaited<ReturnType<typeof chat>>> {
  const maxAttempts = Math.max(1, policy.apiMaxAttempts ?? 1);
  const baseMs = policy.apiRetryBaseMs ?? 750;
  let attempt = 0;
  for (;;) {
    attempt++;
    try {
      return await chat(messages, toolDefs, modelOverride);
    } catch (err) {
      if (!isTransientApiError(err) || attempt >= maxAttempts) throw err;
      // Exponential backoff with jitter (0.5×–1.5× the base window) to avoid thundering-herd retries.
      const delay = Math.round(baseMs * 2 ** (attempt - 1) * (0.5 + Math.random()));
      emitEvent(policy, {
        event: 'api_retry',
        attempt,
        max_attempts: maxAttempts,
        delay_ms: delay,
        reason: apiErrorReason(err),
      });
      await Bun.sleep(delay);
    }
  }
}

async function executeToolCall(
  tc: ToolCall,
  tools: Tool[],
): Promise<{ result: string; isError: boolean }> {
  // Redact secrets at this single chokepoint so neither the model nor the transcript sees them.
  const { result, isError } = await runToolCall(tc, tools);
  return { result: redactSecrets(result), isError };
}

async function runToolCall(
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

  // Tool progress is emitted via events — no direct stderr writes.
  // The tool_call event is emitted by the caller before invoking this function.
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
  // Completion audit fires at most once per run() — this guards against re-triggering.
  let completionAuditTriggered = false;

  while (turns < policy.maxTurns) {
    const contextMessages = policy.contextStrategy(allMessages);

    let response: Awaited<ReturnType<typeof chat>>;
    const apiStart = Date.now();
    try {
      response = await callChatWithRetry(contextMessages, toolDefs, modelOverride, policy);
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
    const api_ms = Date.now() - apiStart;

    usage.prompt_tokens += response.usage.prompt_tokens;
    usage.completion_tokens += response.usage.completion_tokens;
    usage.total_tokens += response.usage.total_tokens;

    // Store message WITHOUT reasoning — some providers reject echoed reasoning.
    allMessages.push(response.message);
    turns++;

    const finishReason = response.finish_reason;

    emitEvent(policy, {
      event: 'assistant',
      content: response.message.content ?? '',
      reasoning: response.reasoning ?? '',
      api_ms,
      tool_calls: (response.message.tool_calls ?? []).map((tc) => ({
        name: tc.function.name,
        args_chars: tc.function.arguments.length,
      })),
    });

    if (finishReason === 'tool_calls' || response.message.tool_calls?.length) {
      const tcs = response.message.tool_calls ?? [];

      for (const tc of tcs) {
        let args: Record<string, unknown> = {};
        try { args = JSON.parse(tc.function.arguments); } catch { /* keep empty */ }
        emitEvent(policy, { event: 'tool_call', name: tc.function.name, args });

        const { result, isError } = await executeToolCall(tc, tools);
        const truncated = result.startsWith('[truncated:');
        emitEvent(policy, { event: 'tool_result', name: tc.function.name, chars: result.length, truncated, result });

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
            emitEvent(policy, { event: 'tool_retry', tool: tc.function.name, attempt: 1 });
            const retry = await executeToolCall(tc, tools);
            emitEvent(policy, { event: 'tool_result', name: tc.function.name, chars: retry.result.length, truncated: retry.result.startsWith('[truncated:'), result: retry.result });
            allMessages.push(toolResultMessage(tc, retry.result));
          } else if (policy.onToolError === 'nudge') {
            emitEvent(policy, { event: 'nudge', tool: tc.function.name });
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

    // No tool calls — the model wants to finish.
    if (!policy.shouldContinue(response.message)) {
      // Completion audit: give the model exactly one enforced chance to verify before we accept
      // a no-tool finish as done. Only fire when at least one more turn of budget remains
      // (turns < maxTurns - 1) so the injected audit turn can actually run; at an explicit
      // ceiling we accept the finish instead of injecting a prompt no turn would answer.
      // With no turn limit (the default) maxTurns is Infinity, so this always fires once.
      if (
        policy.completionAudit &&
        !completionAuditTriggered &&
        turns < policy.maxTurns - 1
      ) {
        completionAuditTriggered = true;
        emitEvent(policy, { event: 'completion_audit', turn: turns });
        allMessages.push({ role: 'user', content: COMPLETION_AUDIT_PROMPT });
        continue;
      }
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
