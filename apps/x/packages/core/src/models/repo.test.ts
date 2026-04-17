import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';

const originalWorkDir = process.env.ROWBOAT_WORKDIR;

async function importRepoModule() {
  vi.resetModules();
  return await import('./repo.js');
}

describe('FSModelConfigRepo', () => {
  afterEach(async () => {
    if (originalWorkDir === undefined) {
      delete process.env.ROWBOAT_WORKDIR;
    } else {
      process.env.ROWBOAT_WORKDIR = originalWorkDir;
    }
    vi.resetModules();
  });

  it('falls back to the default config when models.json is corrupt', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rowboat-models-'));
    process.env.ROWBOAT_WORKDIR = tempDir;

    const configDir = path.join(tempDir, 'config');
    await fs.mkdir(configDir, { recursive: true });
    await fs.writeFile(path.join(configDir, 'models.json'), '{"providerMode":"chatgpt-codex"');

    const { FSModelConfigRepo } = await importRepoModule();
    const repo = new FSModelConfigRepo();

    const config = await repo.getConfig();
    const persisted = JSON.parse(await fs.readFile(path.join(configDir, 'models.json'), 'utf8')) as {
      providerMode: string;
      model: string;
    };

    expect(config.providerMode).toBe('byok');
    expect(config.model).toBe('gpt-5.4');
    expect(persisted.providerMode).toBe('byok');
    expect(persisted.model).toBe('gpt-5.4');
  });

  it('reads legacy account-backed configs that still include a top-level provider', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rowboat-models-'));
    process.env.ROWBOAT_WORKDIR = tempDir;

    const configDir = path.join(tempDir, 'config');
    await fs.mkdir(configDir, { recursive: true });
    await fs.writeFile(path.join(configDir, 'models.json'), JSON.stringify({
      providerMode: 'rowboat',
      provider: { flavor: 'openai' },
      model: 'gpt-5.4',
      models: ['gpt-5.4', 'gpt-5.4-mini'],
      knowledgeGraphModel: 'gpt-5.4-mini',
      meetingNotesModel: 'gpt-5.4',
      providers: {
        openai: {
          apiKey: 'secret',
          model: 'gpt-5.4',
        },
      },
    }, null, 2));

    const { FSModelConfigRepo } = await importRepoModule();
    const repo = new FSModelConfigRepo();
    const config = await repo.getConfig();

    expect(config.providerMode).toBe('rowboat');
    expect(config.model).toBe('gpt-5.4');
    expect(config.models).toEqual(['gpt-5.4', 'gpt-5.4-mini']);
    expect(config).not.toHaveProperty('provider');
  });

  it('does not restore a top-level provider when saving account-backed configs', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rowboat-models-'));
    process.env.ROWBOAT_WORKDIR = tempDir;

    const configDir = path.join(tempDir, 'config');
    await fs.mkdir(configDir, { recursive: true });
    await fs.writeFile(path.join(configDir, 'models.json'), JSON.stringify({
      providerMode: 'chatgpt-codex',
      provider: { flavor: 'openai' },
      model: 'codex-legacy',
      providers: {
        openai: {
          apiKey: 'secret',
          baseURL: 'https://api.openai.com/v1',
          model: 'gpt-5.4',
          models: ['gpt-5.4'],
        },
      },
    }, null, 2));

    const { FSModelConfigRepo } = await importRepoModule();
    const repo = new FSModelConfigRepo();

    await repo.setConfig({
      providerMode: 'rowboat',
      model: 'gpt-5.4',
      models: ['gpt-5.4', 'gpt-5.4-mini'],
      knowledgeGraphModel: 'gpt-5.4-mini',
      meetingNotesModel: 'gpt-5.4',
    });

    const persisted = JSON.parse(await fs.readFile(path.join(configDir, 'models.json'), 'utf8')) as Record<string, unknown>;

    expect(persisted.providerMode).toBe('rowboat');
    expect(persisted.model).toBe('gpt-5.4');
    expect(persisted.models).toEqual(['gpt-5.4', 'gpt-5.4-mini']);
    expect(persisted.knowledgeGraphModel).toBe('gpt-5.4-mini');
    expect(persisted.meetingNotesModel).toBe('gpt-5.4');
    expect(persisted).not.toHaveProperty('provider');
    expect(persisted.providers).toEqual({
      openai: {
        apiKey: 'secret',
        baseURL: 'https://api.openai.com/v1',
        model: 'gpt-5.4',
        models: ['gpt-5.4'],
      },
    });
  });
});
