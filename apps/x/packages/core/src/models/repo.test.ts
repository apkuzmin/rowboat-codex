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
    expect(config.model).toBe('gpt-4.1');
    expect(persisted.providerMode).toBe('byok');
    expect(persisted.model).toBe('gpt-4.1');
  });
});
