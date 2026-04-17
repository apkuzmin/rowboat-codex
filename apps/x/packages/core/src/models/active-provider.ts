import { ProviderV2 } from '@ai-sdk/provider';
import z from 'zod';
import { isSignedIn } from '../account/account.js';
import { isCodexConnected } from '../auth/codex.js';
import { getGatewayProvider } from './gateway.js';
import { CODEX_DEFAULT_MODEL, CODEX_LIGHTWEIGHT_MODEL, getCodexProvider } from './codex.js';
import { ModelConfig, createProvider } from './models.js';

export type ActiveProviderMode = 'rowboat' | 'chatgpt-codex' | 'byok';

export type ActiveProviderContext = {
  mode: ActiveProviderMode;
  provider: ProviderV2;
  defaultModel: string;
  defaultKnowledgeGraphModel: string;
  defaultMeetingNotesModel: string;
};

export async function resolveActiveProvider(
  config: z.infer<typeof ModelConfig>,
): Promise<ActiveProviderContext> {
  if (config.providerMode === 'rowboat') {
    if (!(await isSignedIn())) {
      throw new Error('Rowboat is selected in Models, but the Rowboat account is not signed in.');
    }
    return {
      mode: 'rowboat',
      provider: await getGatewayProvider(),
      defaultModel: 'gpt-5.4',
      defaultKnowledgeGraphModel: 'gpt-5.4-mini',
      defaultMeetingNotesModel: 'gpt-5.4',
    };
  }

  if (config.providerMode === 'chatgpt-codex') {
    if (!(await isCodexConnected())) {
      throw new Error('ChatGPT / Codex is selected in Models, but the account is not connected.');
    }
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
    provider: createProvider(config.provider),
    defaultModel: '',
    defaultKnowledgeGraphModel: '',
    defaultMeetingNotesModel: '',
  };
}

export function getActiveProviderMode(config: z.infer<typeof ModelConfig>): ActiveProviderMode {
  return config.providerMode ?? 'byok';
}
