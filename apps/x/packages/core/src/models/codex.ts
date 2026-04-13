import { createOpenAI } from '@ai-sdk/openai';
import { ProviderV2 } from '@ai-sdk/provider';
import { getCodexAuthRecord } from '../auth/codex.js';

export const CODEX_PROVIDER_ID = 'chatgpt-codex';
export const CODEX_PROVIDER_NAME = 'ChatGPT / Codex';
export const CODEX_BASE_URL = 'https://chatgpt.com/backend-api/codex';
export const CODEX_DEFAULT_MODEL = 'gpt-5-codex';
export const CODEX_LIGHTWEIGHT_MODEL = 'codex-mini-latest';

const FIXED_CODEX_MODELS = [
  {
    id: CODEX_DEFAULT_MODEL,
    name: 'GPT-5 Codex',
  },
  {
    id: CODEX_LIGHTWEIGHT_MODEL,
    name: 'Codex Mini Latest',
  },
];

export async function getCodexProvider(): Promise<ProviderV2> {
  const auth = await getCodexAuthRecord();
  if (!auth) {
    throw new Error('ChatGPT / Codex account is not connected');
  }

  return createOpenAI({
    apiKey: auth.tokens.access_token,
    baseURL: CODEX_BASE_URL,
    headers: {
      Originator: 'codex-tui',
      ...(auth.metadata.accountId ? { 'Chatgpt-Account-Id': auth.metadata.accountId } : {}),
    },
  }) as unknown as ProviderV2;
}

export async function listCodexModels(): Promise<{
  providers: Array<{
    id: string;
    name: string;
    models: Array<{
      id: string;
      name?: string;
      release_date?: string;
    }>;
  }>;
}> {
  return {
    providers: [
      {
        id: CODEX_PROVIDER_ID,
        name: CODEX_PROVIDER_NAME,
        models: FIXED_CODEX_MODELS,
      },
    ],
  };
}
