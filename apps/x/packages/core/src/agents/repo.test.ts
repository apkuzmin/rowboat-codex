import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';

const originalWorkDir = process.env.ROWBOAT_WORKDIR;

async function importRepoModule() {
    vi.resetModules();
    return await import('./repo.js');
}

describe('FSAgentsRepo', () => {
    afterEach(() => {
        if (originalWorkDir === undefined) {
            delete process.env.ROWBOAT_WORKDIR;
        } else {
            process.env.ROWBOAT_WORKDIR = originalWorkDir;
        }
        vi.resetModules();
    });

    it('lists frontmatter agents without requiring a name field', async () => {
        const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rowboat-agents-'));
        process.env.ROWBOAT_WORKDIR = tempDir;
        await fs.mkdir(path.join(tempDir, 'agents'), { recursive: true });
        await fs.writeFile(path.join(tempDir, 'agents', 'demo.md'), [
            '---',
            'description: Demo agent',
            'model: gpt-5.4',
            '---',
            'Follow the user instructions.',
        ].join('\n'));

        const { FSAgentsRepo } = await importRepoModule();
        const agents = await new FSAgentsRepo().list();

        expect(agents).toHaveLength(1);
        expect(agents[0]).toMatchObject({
            name: 'demo',
            description: 'Demo agent',
            model: 'gpt-5.4',
            instructions: 'Follow the user instructions.',
        });
    });

    it('fetches frontmatter agents with the name derived from the id', async () => {
        const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rowboat-agents-'));
        process.env.ROWBOAT_WORKDIR = tempDir;
        await fs.mkdir(path.join(tempDir, 'agents'), { recursive: true });
        await fs.writeFile(path.join(tempDir, 'agents', 'demo.md'), [
            '---',
            'description: Demo agent',
            '---',
            'Body instructions.',
        ].join('\n'));

        const { FSAgentsRepo } = await importRepoModule();
        const agent = await new FSAgentsRepo().fetch('demo');

        expect(agent).toMatchObject({
            name: 'demo',
            description: 'Demo agent',
            instructions: 'Body instructions.',
        });
    });

    it('keeps legacy plain markdown agents readable', async () => {
        const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rowboat-agents-'));
        process.env.ROWBOAT_WORKDIR = tempDir;
        await fs.mkdir(path.join(tempDir, 'agents'), { recursive: true });
        await fs.writeFile(path.join(tempDir, 'agents', 'plain.md'), 'Plain instructions.');

        const { FSAgentsRepo } = await importRepoModule();
        const agent = await new FSAgentsRepo().fetch('plain');

        expect(agent).toMatchObject({
            name: 'plain',
            instructions: 'Plain instructions.',
        });
    });
});
