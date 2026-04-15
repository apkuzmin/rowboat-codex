import { tool, type ModelMessage } from 'ai';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

vi.mock('../auth/codex.js', () => ({
  buildCodexHeaders: vi.fn((_auth: unknown, extraHeaders: Record<string, string> = {}) => ({
    Authorization: 'Bearer [mock]',
    Accept: 'application/json',
    Originator: 'codex-tui',
    ...extraHeaders,
  })),
  getCodexAuthRecord: vi.fn(async () => ({
    tokens: { access_token: 'token' },
    metadata: { accountId: 'acct_123' },
  })),
}));

import {
  buildCodexStepInput,
  buildCodexStepRequest,
  normalizeCodexError,
  streamCodexStep,
} from './codex-runtime.js';

function createEventStreamResponse(events: unknown[]): Response {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const event of events) {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
      }
      controller.close();
    },
  });

  return new Response(body, {
    status: 200,
    headers: {
      'Content-Type': 'text/event-stream',
    },
  });
}

async function collectEvents(generator: AsyncGenerator<unknown, void, unknown>): Promise<unknown[]> {
  const events: unknown[] = [];
  for await (const event of generator) {
    events.push(event);
  }
  return events;
}

describe('codex-runtime', () => {
  it('builds Codex step input without transient upstream ids', () => {
    const messages = [
      {
        role: 'user',
        content: 'Read the file',
      },
      {
        role: 'assistant',
        content: [
          {
            type: 'text',
            text: 'Checking now.',
            providerMetadata: { openai: { itemId: 'msg_123' } },
          },
          {
            type: 'tool-call',
            toolCallId: 'call-1',
            toolName: 'workspace-readFile',
            input: { path: '/tmp/demo.txt' },
            providerMetadata: { openai: { itemId: 'fc_123' } },
          },
        ],
      },
      {
        role: 'tool',
        content: [
          {
            type: 'tool-result',
            toolCallId: 'call-1',
            toolName: 'workspace-readFile',
            output: {
              type: 'text',
              value: 'file body',
            },
          },
        ],
      },
    ] as ModelMessage[];

    const input = buildCodexStepInput(messages);

    expect(input).toEqual([
      {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: 'Read the file' }],
      },
      {
        type: 'message',
        role: 'assistant',
        content: [{ type: 'output_text', text: 'Checking now.' }],
      },
      {
        type: 'function_call',
        call_id: 'call-1',
        name: 'workspace-readFile',
        arguments: '{"path":"/tmp/demo.txt"}',
      },
      {
        type: 'function_call_output',
        call_id: 'call-1',
        output: 'file body',
      },
    ]);
    expect(JSON.stringify(input)).not.toContain('msg_123');
    expect(JSON.stringify(input)).not.toContain('fc_123');
  });

  it('builds a Codex step request with store disabled and tools serialized as JSON Schema', () => {
    const tools = {
      readFile: tool({
        description: 'Read a file',
        inputSchema: z.object({
          path: z.string(),
        }),
      }),
    };

    const request = buildCodexStepRequest({
      modelId: 'gpt-5.4',
      messages: [{ role: 'user', content: 'Read demo.txt' }] as ModelMessage[],
      system: 'You are helpful.',
      tools,
    });

    expect(request.store).toBe(false);
    expect(request.stream).toBe(true);
    expect(request.instructions).toBe('You are helpful.');
    expect(request).not.toHaveProperty('previous_response_id');
    expect(request.tools).toEqual([
      {
        type: 'function',
        name: 'readFile',
        description: 'Read a file',
        parameters: {
          $schema: 'http://json-schema.org/draft-07/schema#',
          additionalProperties: false,
          properties: {
            path: { type: 'string' },
          },
          required: ['path'],
          type: 'object',
        },
      },
    ]);
  });

  it('normalizes Codex-specific backend errors', () => {
    expect(
      normalizeCodexError({
        responseBody: JSON.stringify({
          detail: 'Selected model is not supported when using Codex with a ChatGPT account',
        }),
      }),
    ).toMatchObject({
      code: 'model_not_supported',
    });

    expect(
      normalizeCodexError({
        statusCode: 401,
        responseBody: 'unauthorized',
      }),
    ).toMatchObject({
      code: 'auth',
    });

    expect(
      normalizeCodexError({
        responseBody: "Item with id 'fc_123' not found. Items are not persisted when store is set to false.",
      }),
    ).toMatchObject({
      code: 'tool_loop_incompatible',
    });
  });

  it('streams a single tool call step end-to-end', async () => {
    const fetchFn = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const parsedBody = JSON.parse(String(init?.body));
      expect(parsedBody.store).toBe(false);
      expect(parsedBody.instructions).toBe('System prompt');
      expect(parsedBody.input).toEqual([
        {
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text: 'Run pwd' }],
        },
      ]);

      return createEventStreamResponse([
        { type: 'response.created', response: { id: 'resp_1', created_at: 1, model: 'gpt-5.4' } },
        { type: 'response.output_item.added', output_index: 0, item: { type: 'message', id: 'msg_1' } },
        { type: 'response.output_text.delta', item_id: 'msg_1', delta: 'Let me ' },
        { type: 'response.output_text.delta', item_id: 'msg_1', delta: 'check.' },
        { type: 'response.output_item.done', output_index: 0, item: { type: 'message', id: 'msg_1' } },
        {
          type: 'response.output_item.done',
          output_index: 1,
          item: {
            type: 'function_call',
            id: 'fc_1',
            call_id: 'call-1',
            name: 'executeCommand',
            arguments: '{"command":"pwd"}',
            status: 'completed',
          },
        },
        {
          type: 'response.completed',
          response: {
            usage: {
              input_tokens: 12,
              input_tokens_details: { cached_tokens: 2 },
              output_tokens: 4,
              output_tokens_details: { reasoning_tokens: 1 },
            },
          },
        },
      ]);
    });

    const events = await collectEvents(streamCodexStep({
      modelId: 'gpt-5.4',
      messages: [{ role: 'user', content: 'Run pwd' }] as ModelMessage[],
      system: 'System prompt',
      tools: {
        executeCommand: tool({
          description: 'Execute a shell command',
          inputSchema: z.object({
            command: z.string(),
          }),
        }),
      },
      fetchFn: fetchFn as typeof fetch,
      traceLabel: 'test-single-tool',
    }));

    expect(events).toEqual([
      { type: 'text-start' },
      { type: 'text-delta', delta: 'Let me ' },
      { type: 'text-delta', delta: 'check.' },
      { type: 'text-end' },
      {
        type: 'tool-call',
        toolCallId: 'call-1',
        toolName: 'executeCommand',
        input: { command: 'pwd' },
      },
      {
        type: 'finish-step',
        finishReason: 'tool-calls',
        usage: {
          inputTokens: 12,
          outputTokens: 4,
          totalTokens: 16,
          reasoningTokens: 1,
          cachedInputTokens: 2,
        },
      },
    ]);
  });

  it('streams multiple tool calls in one turn', async () => {
    const events = await collectEvents(streamCodexStep({
      modelId: 'gpt-5.4',
      messages: [{ role: 'user', content: 'Run two commands' }] as ModelMessage[],
      system: 'System prompt',
      tools: {
        executeCommand: tool({
          description: 'Execute a shell command',
          inputSchema: z.object({
            command: z.string(),
          }),
        }),
      },
      fetchFn: vi.fn(async () => createEventStreamResponse([
        {
          type: 'response.output_item.done',
          output_index: 0,
          item: {
            type: 'function_call',
            id: 'fc_1',
            call_id: 'call-1',
            name: 'executeCommand',
            arguments: '{"command":"pwd"}',
            status: 'completed',
          },
        },
        {
          type: 'response.output_item.done',
          output_index: 1,
          item: {
            type: 'function_call',
            id: 'fc_2',
            call_id: 'call-2',
            name: 'executeCommand',
            arguments: '{"command":"ls"}',
            status: 'completed',
          },
        },
        {
          type: 'response.completed',
          response: {
            usage: {
              input_tokens: 8,
              output_tokens: 3,
              output_tokens_details: {},
            },
          },
        },
      ])) as typeof fetch,
    }));

    expect(events).toEqual([
      {
        type: 'tool-call',
        toolCallId: 'call-1',
        toolName: 'executeCommand',
        input: { command: 'pwd' },
      },
      {
        type: 'tool-call',
        toolCallId: 'call-2',
        toolName: 'executeCommand',
        input: { command: 'ls' },
      },
      {
        type: 'finish-step',
        finishReason: 'tool-calls',
        usage: {
          inputTokens: 8,
          outputTokens: 3,
          totalTokens: 11,
          reasoningTokens: undefined,
          cachedInputTokens: undefined,
        },
      },
    ]);
  });

  it('continues after tool results and returns final assistant text', async () => {
    const fetchFn = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const parsedBody = JSON.parse(String(init?.body));
      expect(parsedBody.input).toEqual([
        {
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text: 'What was the output?' }],
        },
        {
          type: 'function_call',
          call_id: 'call-1',
          name: 'executeCommand',
          arguments: '{"command":"pwd"}',
        },
        {
          type: 'function_call_output',
          call_id: 'call-1',
          output: '{"stdout":"/tmp"}',
        },
      ]);

      return createEventStreamResponse([
        { type: 'response.output_item.added', output_index: 0, item: { type: 'message', id: 'msg_2' } },
        { type: 'response.output_text.delta', item_id: 'msg_2', delta: 'The command returned /tmp.' },
        { type: 'response.output_item.done', output_index: 0, item: { type: 'message', id: 'msg_2' } },
        {
          type: 'response.completed',
          response: {
            usage: {
              input_tokens: 10,
              output_tokens: 5,
              output_tokens_details: {},
            },
          },
        },
      ]);
    });

    const events = await collectEvents(streamCodexStep({
      modelId: 'gpt-5.4',
      system: 'System prompt',
      tools: {},
      messages: [
        { role: 'user', content: 'What was the output?' },
        {
          role: 'assistant',
          content: [
            {
              type: 'tool-call',
              toolCallId: 'call-1',
              toolName: 'executeCommand',
              input: { command: 'pwd' },
            },
          ],
        },
        {
          role: 'tool',
          content: [
            {
              type: 'tool-result',
              toolCallId: 'call-1',
              toolName: 'executeCommand',
              output: {
                type: 'text',
                value: '{"stdout":"/tmp"}',
              },
            },
          ],
        },
      ] as ModelMessage[],
      fetchFn: fetchFn as typeof fetch,
    }));

    expect(events).toEqual([
      { type: 'text-start' },
      { type: 'text-delta', delta: 'The command returned /tmp.' },
      { type: 'text-end' },
      {
        type: 'finish-step',
        finishReason: 'stop',
        usage: {
          inputTokens: 10,
          outputTokens: 5,
          totalTokens: 15,
          reasoningTokens: undefined,
          cachedInputTokens: undefined,
        },
      },
    ]);
  });
});
