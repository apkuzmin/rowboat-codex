import { createOpenAI } from '@ai-sdk/openai';
import { ProviderV2 } from '@ai-sdk/provider';
import z from 'zod';
import { getCodexAuthRecord } from '../auth/codex.js';
import { ModelConfig } from './models.js';

export const CODEX_PROVIDER_ID = 'chatgpt-codex';
export const CODEX_PROVIDER_NAME = 'ChatGPT / Codex';
export const CODEX_BASE_URL = 'https://chatgpt.com/backend-api/codex';
export const CODEX_DISCOVERY_CLIENT_VERSION = '0.118.0';
export const CODEX_USER_AGENT = 'codex-tui/0.118.0 (Mac OS 26.3.1; arm64) iTerm.app/3.6.9 (codex-tui; 0.118.0)';
export const CODEX_DEFAULT_MODEL = 'gpt-5.4';
export const CODEX_LIGHTWEIGHT_MODEL = 'gpt-5.4-mini';

const CODEX_MODEL_CACHE_TTL_MS = 5 * 60 * 1000;

const FALLBACK_CODEX_MODELS = [
  {
    id: CODEX_DEFAULT_MODEL,
    name: 'gpt-5.4',
  },
  {
    id: CODEX_LIGHTWEIGHT_MODEL,
    name: 'GPT-5.4-Mini',
  },
  {
    id: 'gpt-5.3-codex',
    name: 'gpt-5.3-codex',
  },
  {
    id: 'gpt-5.2',
    name: 'gpt-5.2',
  },
];

const CodexDiscoverySchema = z.object({
  models: z.array(z.object({
    slug: z.string(),
    display_name: z.string().optional(),
    visibility: z.string().optional(),
  }).passthrough()),
});

type CodexModelOption = {
  id: string;
  name?: string;
  release_date?: string;
};

export type CodexCatalogSource = 'discovered' | 'fallback';

type CodexCatalog = {
  models: CodexModelOption[];
  source: CodexCatalogSource;
  lastUpdated?: string;
};

type CodexModelDefaults = {
  defaultModel: string;
  defaultKnowledgeGraphModel: string;
  defaultMeetingNotesModel: string;
};

let codexCatalogCache: (CodexCatalog & { fetchedAt: number }) | null = null;

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values)];
}

function getFallbackCatalog(): CodexCatalog {
  return {
    models: FALLBACK_CODEX_MODELS,
    source: 'fallback',
  };
}

function getCodexDefaults(models: CodexModelOption[]): CodexModelDefaults {
  const defaultModel = models.find((model) => model.id === CODEX_DEFAULT_MODEL)?.id
    ?? models.find((model) => !model.id.toLowerCase().includes('mini'))?.id
    ?? models[0]?.id
    ?? CODEX_DEFAULT_MODEL;
  const lightweightModel = models.find((model) => model.id === CODEX_LIGHTWEIGHT_MODEL)?.id
    ?? models.find((model) => model.id.toLowerCase().includes('mini'))?.id
    ?? defaultModel;

  return {
    defaultModel,
    defaultKnowledgeGraphModel: lightweightModel,
    defaultMeetingNotesModel: lightweightModel,
  };
}

function normalizeSavedModels(
  models: string[] | undefined,
  validIds: Set<string>,
  defaultModel: string,
): { models: string[]; invalidSavedModels: string[] } {
  const invalidSavedModels: string[] = [];
  const normalized = uniqueStrings(
    (models ?? [])
      .map((model) => model.trim())
      .filter(Boolean)
      .filter((model) => {
        const isValid = validIds.has(model);
        if (!isValid) {
          invalidSavedModels.push(model);
        }
        return isValid;
      }),
  );

  return {
    models: normalized.length > 0 ? normalized : [defaultModel],
    invalidSavedModels,
  };
}

function buildCodexDiscoveryHeaders(auth: Awaited<ReturnType<typeof getCodexAuthRecord>>): Record<string, string> {
  if (!auth) {
    return {};
  }

  return {
    Authorization: `Bearer ${auth.tokens.access_token}`,
    Accept: 'application/json',
    Originator: 'codex-tui',
    'User-Agent': CODEX_USER_AGENT,
    ...(auth.metadata.accountId ? { 'Chatgpt-Account-Id': auth.metadata.accountId } : {}),
  };
}

async function discoverCodexCatalog(): Promise<CodexCatalog> {
  const auth = await getCodexAuthRecord();
  if (!auth) {
    throw new Error('ChatGPT / Codex account is not connected');
  }

  const discoveryUrl = new URL(`${CODEX_BASE_URL}/models`);
  discoveryUrl.searchParams.set('client_version', CODEX_DISCOVERY_CLIENT_VERSION);

  const response = await fetch(discoveryUrl, {
    headers: buildCodexDiscoveryHeaders(auth),
  });
  const text = await response.text();

  if (!response.ok) {
    throw new Error(`Codex model discovery failed: ${text.trim() || `HTTP ${response.status}`}`);
  }

  const payload = CodexDiscoverySchema.parse(JSON.parse(text));
  const models = payload.models
    .filter((model) => model.visibility !== 'hide')
    .map((model) => ({
      id: model.slug,
      name: model.display_name || model.slug,
    }));

  if (models.length === 0) {
    throw new Error('Codex model discovery returned no visible models');
  }

  return {
    models,
    source: 'discovered',
    lastUpdated: new Date().toISOString(),
  };
}

export async function resolveCodexCatalog(forceRefresh: boolean = false): Promise<CodexCatalog> {
  const now = Date.now();
  if (!forceRefresh && codexCatalogCache && (now - codexCatalogCache.fetchedAt) < CODEX_MODEL_CACHE_TTL_MS) {
    return {
      models: codexCatalogCache.models,
      source: codexCatalogCache.source,
      lastUpdated: codexCatalogCache.lastUpdated,
    };
  }

  try {
    const discovered = await discoverCodexCatalog();
    codexCatalogCache = {
      ...discovered,
      fetchedAt: now,
    };
    return discovered;
  } catch (error) {
    console.warn(
      '[Codex] Falling back to curated ChatGPT / Codex model list:',
      error instanceof Error ? error.message : String(error),
    );
    return getFallbackCatalog();
  }
}

export async function normalizeCodexModelConfig(
  config: z.infer<typeof ModelConfig>,
): Promise<{
  config: z.infer<typeof ModelConfig>;
  changed: boolean;
  invalidSavedModels: string[];
  source: CodexCatalogSource;
  lastUpdated?: string;
}> {
  if ((config.providerMode ?? 'byok') !== CODEX_PROVIDER_ID) {
    return {
      config,
      changed: false,
      invalidSavedModels: [],
      source: 'fallback',
    };
  }

  const catalog = await resolveCodexCatalog();
  const defaults = getCodexDefaults(catalog.models);
  const validIds = new Set(catalog.models.map((model) => model.id));

  const primaryModels = normalizeSavedModels(
    uniqueStrings([config.model, ...(config.models ?? [])].map((model) => model ?? '')),
    validIds,
    defaults.defaultModel,
  );
  const normalizedKgModel = validIds.has(config.knowledgeGraphModel ?? '')
    ? config.knowledgeGraphModel
    : defaults.defaultKnowledgeGraphModel;
  const normalizedMeetingNotesModel = validIds.has(config.meetingNotesModel ?? '')
    ? config.meetingNotesModel
    : defaults.defaultMeetingNotesModel;

  const invalidSavedModels = uniqueStrings([
    ...primaryModels.invalidSavedModels,
    ...(config.knowledgeGraphModel && !validIds.has(config.knowledgeGraphModel) ? [config.knowledgeGraphModel] : []),
    ...(config.meetingNotesModel && !validIds.has(config.meetingNotesModel) ? [config.meetingNotesModel] : []),
  ]);

  const normalizedConfig: z.infer<typeof ModelConfig> = {
    ...config,
    model: primaryModels.models[0],
    models: primaryModels.models,
    knowledgeGraphModel: normalizedKgModel,
    meetingNotesModel: normalizedMeetingNotesModel,
  };

  const changed = normalizedConfig.model !== config.model
    || JSON.stringify(normalizedConfig.models ?? []) !== JSON.stringify(config.models ?? [])
    || (normalizedConfig.knowledgeGraphModel ?? '') !== (config.knowledgeGraphModel ?? '')
    || (normalizedConfig.meetingNotesModel ?? '') !== (config.meetingNotesModel ?? '');

  return {
    config: normalizedConfig,
    changed,
    invalidSavedModels,
    source: catalog.source,
    lastUpdated: catalog.lastUpdated,
  };
}

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
      'User-Agent': CODEX_USER_AGENT,
      ...(auth.metadata.accountId ? { 'Chatgpt-Account-Id': auth.metadata.accountId } : {}),
    },
  }) as unknown as ProviderV2;
}

export async function listCodexModels(savedModelIds: string[] = []): Promise<{
  providers: Array<{
    id: string;
    name: string;
    models: Array<{
      id: string;
      name?: string;
      release_date?: string;
    }>;
    meta?: {
      catalogSource?: CodexCatalogSource;
      invalidSavedModels?: string[];
      defaultModel?: string;
      defaultKnowledgeGraphModel?: string;
      defaultMeetingNotesModel?: string;
    };
  }>;
  lastUpdated?: string;
}> {
  return await listResolvedCodexModels(savedModelIds);
}

export async function listResolvedCodexModels(savedModelIds: string[] = []): Promise<{
  providers: Array<{
    id: string;
    name: string;
    models: Array<{
      id: string;
      name?: string;
      release_date?: string;
    }>;
    meta?: {
      catalogSource?: CodexCatalogSource;
      invalidSavedModels?: string[];
      defaultModel?: string;
      defaultKnowledgeGraphModel?: string;
      defaultMeetingNotesModel?: string;
    };
  }>;
  lastUpdated?: string;
}> {
  const catalog = await resolveCodexCatalog();
  const defaults = getCodexDefaults(catalog.models);
  const validIds = new Set(catalog.models.map((model) => model.id));
  const invalidSavedModels = uniqueStrings(
    savedModelIds
      .map((model) => model.trim())
      .filter(Boolean)
      .filter((model) => !validIds.has(model)),
  );

  return {
    providers: [
      {
        id: CODEX_PROVIDER_ID,
        name: CODEX_PROVIDER_NAME,
        models: catalog.models,
        meta: {
          catalogSource: catalog.source,
          invalidSavedModels,
          defaultModel: defaults.defaultModel,
          defaultKnowledgeGraphModel: defaults.defaultKnowledgeGraphModel,
          defaultMeetingNotesModel: defaults.defaultMeetingNotesModel,
        },
      },
    ],
    lastUpdated: catalog.lastUpdated,
  };
}
