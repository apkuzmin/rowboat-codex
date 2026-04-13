import { ProviderV2 } from '@ai-sdk/provider';
import z from 'zod';
import { isSignedIn } from '../account/account.js';
import { isCodexConnected } from '../auth/codex.js';
import { getGatewayProvider } from './gateway.js';
import { CODEX_DEFAULT_MODEL, CODEX_LIGHTWEIGHT_MODEL, getCodexProvider } from './codex.js';
import { createProvider, Provider } from './models.js';

export type ActiveProviderMode = 'rowboat' | 'chatgpt-codex' | 'byok';

export type ActiveProviderContext = {
  mode: ActiveProviderMode;
  provider: ProviderV2;
  defaultModel: string;
  defaultKnowledgeGraphModel: string;
  defaultMeetingNotesModel: string;
};

export async function resolveActiveProvider(
  config: z.infer<typeof Provider>,
): Promise<ActiveProviderContext> {
  if (await isSignedIn()) {
    return {
      mode: 'rowboat',
      provider: await getGatewayProvider(),
      defaultModel: 'gpt-5.4',
      defaultKnowledgeGraphModel: 'gpt-5.4-mini',
      defaultMeetingNotesModel: 'gpt-5.4',
    };
  }

  if (await isCodexConnected()) {
    return {
      mode: 'chatgpt-codex',
      provider: await getCodexProvider(),
      defaultModel: CODEX_DEFAULT_MODEL,
      defaultKnowledgeGraphModel: CODEX_LIGHTWEIGHT_MODEL,
      defaultMeetingNotesModel: CODEX_LIGHTWEIGHT_MODEL,
    };
  }

  return {
    mode: 'byok',
    provider: createProvider(config),
    defaultModel: '',
    defaultKnowledgeGraphModel: '',
    defaultMeetingNotesModel: '',
  };
}

export async function getActiveProviderMode(): Promise<Exclude<ActiveProviderMode, 'byok'> | null> {
  if (await isSignedIn()) {
    return 'rowboat';
  }
  if (await isCodexConnected()) {
    return 'chatgpt-codex';
  }
  return null;
}
