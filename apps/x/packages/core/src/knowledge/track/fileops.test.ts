import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';

const originalWorkDir = process.env.ROWBOAT_WORKDIR;

const trackNote = [
    '# Demo',
    '',
    '```track',
    'trackId: demo-track',
    'instruction: Keep this updated',
    'active: true',
    '```',
    '<!--track-target:demo-track-->',
    'Existing content',
    '<!--/track-target:demo-track-->',
].join('\n');

async function importFileopsModule() {
    vi.resetModules();
    return await import('./fileops.js');
}

describe('track fileops path handling', () => {
    afterEach(() => {
        if (originalWorkDir === undefined) {
            delete process.env.ROWBOAT_WORKDIR;
        } else {
            process.env.ROWBOAT_WORKDIR = originalWorkDir;
        }
        vi.resetModules();
    });

    it('reads track blocks from files inside knowledge', async () => {
        const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rowboat-track-'));
        process.env.ROWBOAT_WORKDIR = tempDir;
        await fs.mkdir(path.join(tempDir, 'knowledge'), { recursive: true });
        await fs.writeFile(path.join(tempDir, 'knowledge', 'note.md'), trackNote);

        const { fetchAll } = await importFileopsModule();
        const tracks = await fetchAll('note.md');

        expect(tracks).toHaveLength(1);
        expect(tracks[0].track.trackId).toBe('demo-track');
        expect(tracks[0].content).toBe('Existing content');
    });

    it('does not read files outside knowledge via relative traversal', async () => {
        const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rowboat-track-'));
        process.env.ROWBOAT_WORKDIR = tempDir;
        await fs.mkdir(path.join(tempDir, 'knowledge'), { recursive: true });
        await fs.writeFile(path.join(tempDir, 'outside.md'), trackNote);

        const { fetchAll } = await importFileopsModule();
        const tracks = await fetchAll('../outside.md');

        expect(tracks).toEqual([]);
    });

    it('rejects mutating files outside knowledge via relative traversal', async () => {
        const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rowboat-track-'));
        process.env.ROWBOAT_WORKDIR = tempDir;
        await fs.mkdir(path.join(tempDir, 'knowledge'), { recursive: true });
        const outsidePath = path.join(tempDir, 'outside.md');
        await fs.writeFile(outsidePath, trackNote);

        const { updateTrackBlock } = await importFileopsModule();

        await expect(updateTrackBlock('../outside.md', 'demo-track', { active: false }))
            .rejects
            .toThrow(/Unsafe knowledge file path/);
        expect(await fs.readFile(outsidePath, 'utf-8')).toBe(trackNote);
    });

    it('rejects absolute paths', async () => {
        const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rowboat-track-'));
        process.env.ROWBOAT_WORKDIR = tempDir;
        await fs.mkdir(path.join(tempDir, 'knowledge'), { recursive: true });
        const outsidePath = path.join(tempDir, 'outside.md');
        await fs.writeFile(outsidePath, trackNote);

        const { updateTrackBlock } = await importFileopsModule();

        await expect(updateTrackBlock(outsidePath, 'demo-track', { active: false }))
            .rejects
            .toThrow(/Unsafe knowledge file path/);
        expect(await fs.readFile(outsidePath, 'utf-8')).toBe(trackNote);
    });
});
