import { asSchema, ModelMessage, parseJsonEventStream, ToolSet, zodSchema } from 'ai';
import { z } from 'zod';
import { LlmStepStreamEvent } from '@x/shared/dist/llm-step-events.js';

type CodexInputItem =
  | { type: 'message'; role: 'user' | 'assistant' | 'system' | 'developer'; content: Array<Record<string, unknown>> }
  | { type: 'function_call'; call_id: string; name: string; arguments: string }
  | { type: 'function_call_output'; call_id: string; output: string | Array<Record<string, unknown>> };

type CodexToolDefinition = {
  type: 'function';
  name: string;
  description?: string;
  parameters: unknown;
};

type CodexStepRequest = {
  model: string;
  stream: true;
  store: false;
  instructions: string;
  input: CodexInputItem[];
  tools?: CodexToolDefinition[];
};

type CodexStreamChunk = {
  type: string;
  [key: string]: unknown;
};

type StepFinishReason = 'stop' | 'tool-calls' | 'length' | 'content-filter' | 'error' | 'other' | 'unknown';

type StepUsage = {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  reasoningTokens?: number;
  cachedInputTokens?: number;
};

type CodexAuthLike = {
  tokens: {
    access_token: string;
  };
  metadata: {
    accountId?: string | null;
  };
};

const CODEX_RUNTIME_BASE_URL = 'https://chatgpt.com/backend-api/codex';
const CODEX_RUNTIME_USER_AGENT = 'codex-tui/0.118.0 (Mac OS 26.3.1; arm64) iTerm.app/3.6.9 (codex-tui; 0.118.0)';

export type CodexNormalizedError = {
  code: 'auth' | 'model_not_supported' | 'tool_loop_incompatible' | 'unknown';
  message: string;
};

const CodexStreamChunkSchema = z.object({
  type: z.string(),
}).passthrough();

function redactSecrets(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(redactSecrets);
  }

  if (!value || typeof value !== 'object') {
    if (typeof value === 'string') {
      return value
        .replace(/Bearer\s+[A-Za-z0-9._-]+/gi, 'Bearer [redacted]')
        .replace(/("?(?:access|refresh|id)_token"?\s*:\s*")([^"]+)"/gi, '$1[redacted]"');
    }
    return value;
  }

  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([key, nestedValue]) => {
      const normalizedKey = key.toLowerCase();
      if (normalizedKey === 'authorization') {
        return [key, 'Bearer [redacted]'];
      }
      if (
        normalizedKey === 'access_token'
        || normalizedKey === 'refresh_token'
        || normalizedKey === 'id_token'
      ) {
        return [key, '[redacted]'];
      }
      return [key, redactSecrets(nestedValue)];
    }),
  );
}

function traceCodexStep(traceLabel: string | undefined, event: string, payload: unknown): void {
  const suffix = traceLabel ? ` ${traceLabel}` : '';
  console.log(`[CodexRuntime]${suffix} ${event}: ${JSON.stringify(redactSecrets(payload))}`);
}

function safeJsonParse(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function normalizeToolOutput(output: unknown): string | Array<Record<string, unknown>> {
  if (typeof output === 'string') {
    return output;
  }

  if (Array.isArray(output)) {
    return output.map((entry) => (entry && typeof entry === 'object' ? { ...(entry as Record<string, unknown>) } : { value: entry }));
  }

  return JSON.stringify(output ?? null);
}

function buildAssistantContentParts(content: string): Array<Record<string, unknown>> {
  return content.length > 0 ? [{ type: 'output_text', text: content }] : [];
}

export function buildCodexStepInput(messages: ModelMessage[]): CodexInputItem[] {
  const input: CodexInputItem[] = [];

  for (const message of messages) {
    switch (message.role) {
      case 'system': {
        input.push({
          type: 'message',
          role: 'developer',
          content: [{ type: 'input_text', text: message.content }],
        });
        break;
      }
      case 'user': {
        const content = typeof message.content === 'string'
          ? [{ type: 'input_text', text: message.content }]
          : message.content
              .filter((part): part is { type: 'text'; text: string } => part.type === 'text')
              .map((part) => ({ type: 'input_text', text: part.text }));

        input.push({
          type: 'message',
          role: 'user',
          content,
        });
        break;
      }
      case 'assistant': {
        if (typeof message.content === 'string') {
          input.push({
            type: 'message',
            role: 'assistant',
            content: buildAssistantContentParts(message.content),
          });
          break;
        }

        for (const part of message.content) {
          switch (part.type) {
            case 'text':
              input.push({
                type: 'message',
                role: 'assistant',
                content: buildAssistantContentParts(part.text),
              });
              break;
            case 'tool-call':
              input.push({
                type: 'function_call',
                call_id: part.toolCallId,
                name: part.toolName,
                arguments: typeof part.input === 'string' ? part.input : JSON.stringify(part.input ?? {}),
              });
              break;
            case 'reasoning':
              // Local multi-step continuity is reconstructed from assistant text and tool state.
              // Codex-specific reasoning item IDs are intentionally not persisted across turns.
              break;
            default:
              break;
          }
        }
        break;
      }
      case 'tool': {
        for (const part of message.content) {
          input.push({
            type: 'function_call_output',
            call_id: part.toolCallId,
            output: normalizeToolOutput(part.output.type === 'content' ? part.output.value : part.output.value),
          });
        }
        break;
      }
      default:
        break;
    }
  }

  return input;
}

function buildCodexToolDefinitions(tools: ToolSet): CodexToolDefinition[] | undefined {
  const definitions = Object.entries(tools)
    .flatMap(([name, tool]) => {
      if (tool.type && tool.type !== 'function' && tool.type !== 'dynamic') {
        return [];
      }

      return [{
        type: 'function' as const,
        name,
        description: tool.description,
        parameters: asSchema(tool.inputSchema).jsonSchema,
      }];
    });

  return definitions.length > 0 ? definitions : undefined;
}

export function buildCodexStepRequest({
  modelId,
  messages,
  system,
  tools,
}: {
  modelId: string;
  messages: ModelMessage[];
  system: string;
  tools: ToolSet;
}): CodexStepRequest {
  return {
    model: modelId,
    stream: true,
    store: false,
    instructions: system ?? '',
    input: buildCodexStepInput(messages),
    tools: buildCodexToolDefinitions(tools),
  };
}

function extractErrorDetail(text: string | undefined): string {
  if (!text) {
    return '';
  }

  try {
    const parsed = JSON.parse(text) as {
      detail?: unknown;
      error?: { message?: unknown };
      message?: unknown;
    };

    if (typeof parsed.detail === 'string' && parsed.detail.trim()) {
      return parsed.detail;
    }
    if (typeof parsed.error?.message === 'string' && parsed.error.message.trim()) {
      return parsed.error.message;
    }
    if (typeof parsed.message === 'string' && parsed.message.trim()) {
      return parsed.message;
    }
  } catch {
    return text;
  }

  return text;
}

export function normalizeCodexError(input: {
  responseBody?: string;
  message?: string;
  statusCode?: number;
}): CodexNormalizedError {
  const detail = extractErrorDetail(input.responseBody) || input.message || 'Codex request failed';
  const haystack = detail.toLowerCase();

  if (
    input.statusCode === 401
    || input.statusCode === 403
    || haystack.includes('unauthorized')
    || haystack.includes('invalid token')
    || haystack.includes('expired token')
    || haystack.includes('session expired')
  ) {
    return {
      code: 'auth',
      message: 'ChatGPT / Codex session expired or is invalid. Reconnect the account in Settings -> Models.',
    };
  }

  if (haystack.includes('not supported when using codex with a chatgpt account')) {
    return {
      code: 'model_not_supported',
      message: 'Selected ChatGPT / Codex model is no longer supported for this account. Open Settings -> Models and choose one of the current ChatGPT / Codex models.',
    };
  }

  if (
    (haystack.includes('item with id') && haystack.includes('not found'))
    || haystack.includes('items are not persisted when store is set to false')
    || haystack.includes('not persisted when store is set to false')
  ) {
    return {
      code: 'tool_loop_incompatible',
      message: 'ChatGPT / Codex tool state became inconsistent during a multi-step turn. Retry the task; if this continues, reconnect the account.',
    };
  }

  return {
    code: 'unknown',
    message: detail,
  };
}

function mapCodexFinishReason(reason: string | undefined, hasFunctionCall: boolean): StepFinishReason {
  switch (reason) {
    case undefined:
    case null:
    case '':
      return hasFunctionCall ? 'tool-calls' : 'stop';
    case 'max_output_tokens':
      return 'length';
    case 'content_filter':
      return 'content-filter';
    default:
      return hasFunctionCall ? 'tool-calls' : 'unknown';
  }
}

async function* readParsedStream<T>(stream: ReadableStream<T>): AsyncGenerator<T, void, unknown> {
  const reader = stream.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        return;
      }
      if (value !== undefined) {
        yield value;
      }
    }
  } finally {
    reader.releaseLock();
  }
}

function ensureTextStart(textItems: Set<string>, itemId: string): z.infer<typeof LlmStepStreamEvent>[] {
  if (textItems.has(itemId)) {
    return [];
  }
  textItems.add(itemId);
  return [{ type: 'text-start' }];
}

function ensureReasoningStart(
  reasoningItems: Map<string, number>,
  itemId: string,
  summaryIndex: number,
): z.infer<typeof LlmStepStreamEvent>[] {
  if (reasoningItems.get(itemId) === summaryIndex) {
    return [];
  }

  const events: z.infer<typeof LlmStepStreamEvent>[] = [];
  const existing = reasoningItems.get(itemId);
  if (existing !== undefined) {
    events.push({ type: 'reasoning-end' });
  }
  reasoningItems.set(itemId, summaryIndex);
  events.push({ type: 'reasoning-start' });
  return events;
}

function ensureReasoningEnd(
  reasoningItems: Map<string, number>,
  itemId: string,
): z.infer<typeof LlmStepStreamEvent>[] {
  if (!reasoningItems.has(itemId)) {
    return [];
  }

  reasoningItems.delete(itemId);
  return [{ type: 'reasoning-end' }];
}

export async function* streamCodexStep({
  modelId,
  messages,
  system,
  tools,
  signal,
  fetchFn = fetch,
  traceLabel,
  authRecord,
}: {
  modelId: string;
  messages: ModelMessage[];
  system: string;
  tools: ToolSet;
  signal?: AbortSignal;
  fetchFn?: typeof fetch;
  traceLabel?: string;
  authRecord?: CodexAuthLike | null;
}): AsyncGenerator<z.infer<typeof LlmStepStreamEvent>, void, unknown> {
  const authModule = authRecord
    ? null
    : await import('../auth/codex.js');
  const auth = authRecord ?? await authModule?.getCodexAuthRecord();
  if (!auth) {
    yield {
      type: 'error',
      error: 'ChatGPT / Codex account is not connected.',
    };
    return;
  }

  const requestBody = buildCodexStepRequest({
    modelId,
    messages,
    system,
    tools,
  });

  traceCodexStep(traceLabel, 'request', requestBody);

  let response: Response;
  try {
    response = await fetchFn(`${CODEX_RUNTIME_BASE_URL}/responses`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${auth.tokens.access_token}`,
        Accept: 'application/json',
        Originator: 'codex-tui',
        'Content-Type': 'application/json',
        'User-Agent': CODEX_RUNTIME_USER_AGENT,
        ...(auth.metadata.accountId ? { 'Chatgpt-Account-Id': auth.metadata.accountId } : {}),
      },
      body: JSON.stringify(requestBody),
      signal,
    });
  } catch (error) {
    yield {
      type: 'error',
      error: normalizeCodexError({
        message: error instanceof Error ? error.message : String(error),
      }).message,
    };
    return;
  }

  if (!response.ok) {
    const responseBody = await response.text();
    traceCodexStep(traceLabel, 'http-error', { status: response.status, responseBody });
    yield {
      type: 'error',
      error: normalizeCodexError({
        responseBody,
        statusCode: response.status,
      }).message,
    };
    return;
  }

  if (!response.body) {
    yield {
      type: 'error',
      error: 'Codex response stream was empty.',
    };
    return;
  }

  try {
    const parsedStream = parseJsonEventStream({
      stream: response.body,
      schema: zodSchema(CodexStreamChunkSchema),
    });

    let hasFunctionCall = false;
    let finishReason: StepFinishReason = 'unknown';
    const usage: StepUsage = {};
    const activeTextItems = new Set<string>();
    const activeReasoningItems = new Map<string, number>();

    for await (const parseResult of readParsedStream(parsedStream)) {
      signal?.throwIfAborted();

      if (!parseResult.success) {
        traceCodexStep(traceLabel, 'chunk-parse-error', parseResult.error);
        continue;
      }

      const chunk = parseResult.value as CodexStreamChunk;
      traceCodexStep(traceLabel, 'chunk', chunk);

      switch (chunk.type) {
        case 'response.output_item.added': {
          const item = chunk.item as CodexStreamChunk | undefined;
          if (!item) {
            break;
          }
          if (item.type === 'message') {
            const itemId = typeof item.id === 'string' ? item.id : '';
            if (itemId) {
              for (const event of ensureTextStart(activeTextItems, itemId)) {
                yield event;
              }
            }
          } else if (item.type === 'reasoning') {
            const itemId = typeof item.id === 'string' ? item.id : '';
            if (itemId) {
              for (const event of ensureReasoningStart(activeReasoningItems, itemId, 0)) {
                yield event;
              }
            }
          }
          break;
        }
        case 'response.output_text.delta': {
          const itemId = typeof chunk.item_id === 'string' ? chunk.item_id : '';
          if (itemId) {
            for (const event of ensureTextStart(activeTextItems, itemId)) {
              yield event;
            }
          }
          yield {
            type: 'text-delta',
            delta: typeof chunk.delta === 'string' ? chunk.delta : '',
          };
          break;
        }
        case 'response.reasoning_summary_part.added': {
          const itemId = typeof chunk.item_id === 'string' ? chunk.item_id : '';
          const summaryIndex = typeof chunk.summary_index === 'number' ? chunk.summary_index : 0;
          if (itemId) {
            for (const event of ensureReasoningStart(activeReasoningItems, itemId, summaryIndex)) {
              yield event;
            }
          }
          break;
        }
        case 'response.reasoning_summary_text.delta': {
          const itemId = typeof chunk.item_id === 'string' ? chunk.item_id : '';
          const summaryIndex = typeof chunk.summary_index === 'number' ? chunk.summary_index : 0;
          if (itemId) {
            for (const event of ensureReasoningStart(activeReasoningItems, itemId, summaryIndex)) {
              yield event;
            }
          }
          yield {
            type: 'reasoning-delta',
            delta: typeof chunk.delta === 'string' ? chunk.delta : '',
          };
          break;
        }
        case 'response.reasoning_summary_part.done': {
          const itemId = typeof chunk.item_id === 'string' ? chunk.item_id : '';
          if (itemId) {
            for (const event of ensureReasoningEnd(activeReasoningItems, itemId)) {
              yield event;
            }
          }
          break;
        }
        case 'response.output_item.done': {
          const item = chunk.item as CodexStreamChunk | undefined;
          if (!item) {
            break;
          }

          if (item.type === 'message') {
            const itemId = typeof item.id === 'string' ? item.id : '';
            if (itemId && activeTextItems.has(itemId)) {
              activeTextItems.delete(itemId);
              yield { type: 'text-end' };
            }
          } else if (item.type === 'reasoning') {
            const itemId = typeof item.id === 'string' ? item.id : '';
            if (itemId) {
              for (const event of ensureReasoningEnd(activeReasoningItems, itemId)) {
                yield event;
              }
            }
          } else if (item.type === 'function_call') {
            hasFunctionCall = true;
            yield {
              type: 'tool-call',
              toolCallId: typeof item.call_id === 'string' ? item.call_id : '',
              toolName: typeof item.name === 'string' ? item.name : '',
              input: safeJsonParse(typeof item.arguments === 'string' ? item.arguments : ''),
            };
          }
          break;
        }
        case 'response.completed':
        case 'response.incomplete': {
          const responseUsage = chunk.response && typeof chunk.response === 'object'
            ? (chunk.response as Record<string, unknown>).usage as Record<string, unknown> | undefined
            : undefined;
          const incompleteDetails = chunk.response && typeof chunk.response === 'object'
            ? (chunk.response as Record<string, unknown>).incomplete_details as Record<string, unknown> | undefined
            : undefined;
          finishReason = mapCodexFinishReason(
            typeof incompleteDetails?.reason === 'string' ? incompleteDetails.reason : undefined,
            hasFunctionCall,
          );
          usage.inputTokens = typeof responseUsage?.input_tokens === 'number' ? responseUsage.input_tokens : undefined;
          usage.outputTokens = typeof responseUsage?.output_tokens === 'number' ? responseUsage.output_tokens : undefined;
          usage.totalTokens = usage.inputTokens !== undefined && usage.outputTokens !== undefined
            ? usage.inputTokens + usage.outputTokens
            : undefined;

          const inputTokenDetails = responseUsage?.input_tokens_details;
          if (inputTokenDetails && typeof inputTokenDetails === 'object') {
            usage.cachedInputTokens = typeof (inputTokenDetails as Record<string, unknown>).cached_tokens === 'number'
              ? (inputTokenDetails as Record<string, unknown>).cached_tokens as number
              : undefined;
          }

          const outputTokenDetails = responseUsage?.output_tokens_details;
          if (outputTokenDetails && typeof outputTokenDetails === 'object') {
            usage.reasoningTokens = typeof (outputTokenDetails as Record<string, unknown>).reasoning_tokens === 'number'
              ? (outputTokenDetails as Record<string, unknown>).reasoning_tokens as number
              : undefined;
          }
          break;
        }
        case 'error': {
          const errorValue = chunk.error && typeof chunk.error === 'object'
            ? chunk.error as Record<string, unknown>
            : undefined;
          const rawMessage = typeof errorValue?.message === 'string'
            ? errorValue.message
            : 'Codex stream error';
          yield {
            type: 'error',
            error: normalizeCodexError({ message: rawMessage }).message,
          };
          return;
        }
        default:
          break;
      }
    }

    for (const itemId of [...activeReasoningItems.keys()]) {
      for (const event of ensureReasoningEnd(activeReasoningItems, itemId)) {
        yield event;
      }
    }

    for (const itemId of [...activeTextItems]) {
      activeTextItems.delete(itemId);
      yield { type: 'text-end' };
    }

    yield {
      type: 'finish-step',
      finishReason,
      usage,
    };
  } catch (error) {
    yield {
      type: 'error',
      error: normalizeCodexError({
        message: error instanceof Error ? error.message : String(error),
      }).message,
    };
  }
}
