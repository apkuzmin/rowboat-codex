import { describe, expect, it } from 'vitest';
import { LlmModelConfig } from '@x/shared/dist/models.js';

describe('LlmModelConfig schema', () => {
  it('defaults legacy configs without providerMode to byok', () => {
    const parsed = LlmModelConfig.parse({
      provider: { flavor: 'openai' },
      model: 'gpt-5.4',
    });

    expect(parsed).toEqual({
      providerMode: 'byok',
      provider: { flavor: 'openai' },
      model: 'gpt-5.4',
    });
  });

  it('requires provider for byok configs', () => {
    const result = LlmModelConfig.safeParse({
      providerMode: 'byok',
      model: 'gpt-5.4',
    });

    expect(result.success).toBe(false);
  });

  it('accepts account-backed configs without provider and strips legacy provider payload', () => {
    const parsed = LlmModelConfig.parse({
      providerMode: 'chatgpt-codex',
      provider: { flavor: 'openai' },
      model: 'codex-mini-latest',
      models: ['codex-mini-latest', 'codex-pro-latest'],
      knowledgeGraphModel: 'codex-mini-latest',
      meetingNotesModel: 'codex-pro-latest',
    });

    expect(parsed).toEqual({
      providerMode: 'chatgpt-codex',
      model: 'codex-mini-latest',
      models: ['codex-mini-latest', 'codex-pro-latest'],
      knowledgeGraphModel: 'codex-mini-latest',
      meetingNotesModel: 'codex-pro-latest',
    });
    expect(parsed).not.toHaveProperty('provider');
  });

  it('accepts rowboat configs without provider', () => {
    const parsed = LlmModelConfig.parse({
      providerMode: 'rowboat',
      model: 'gpt-5.4',
      models: ['gpt-5.4', 'gpt-5.4-mini'],
      knowledgeGraphModel: 'gpt-5.4-mini',
      meetingNotesModel: 'gpt-5.4',
    });

    expect(parsed).toEqual({
      providerMode: 'rowboat',
      model: 'gpt-5.4',
      models: ['gpt-5.4', 'gpt-5.4-mini'],
      knowledgeGraphModel: 'gpt-5.4-mini',
      meetingNotesModel: 'gpt-5.4',
    });
  });
});
