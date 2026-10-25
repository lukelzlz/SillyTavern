/* global globalThis */

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, test } from '@jest/globals';
import SessionPersistence from '../src/core/session-persistence.js';
import { SessionEngine } from '../src/core/session-engine.js';

describe('SessionPersistence', () => {
    const temporaryRoots = [];

    afterEach(async () => {
        delete globalThis.DATA_ROOT;
        await Promise.all(temporaryRoots.splice(0).map(root => fs.rm(root, { recursive: true, force: true })));
    });

    test('persists and restores a session snapshot with its version', async () => {
        const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'st-core-session-'));
        temporaryRoots.push(dataRoot);
        globalThis.DATA_ROOT = dataRoot;

        const userId = `persist-${Date.now()}`;
        const persistence = new SessionPersistence({ debounceMs: 1 });
        const sourceSession = new SessionEngine().getSession(userId);
        sourceSession.syncFullState({
            characterId: 'character-1',
            characterName: 'Character',
            chatId: 'chat-1',
            chat: [{ name: 'User', is_user: true, is_system: false, mes: 'Hello' }],
            metadata: { variables: { mood: 'calm' } },
        });
        sourceSession.appendMessage({ name: 'Character', is_user: false, is_system: false, mes: 'Hi' });

        await expect(persistence.save(userId, sourceSession)).resolves.toBe(true);

        const restoredSession = new SessionEngine().getSession(userId);
        await expect(persistence.hydrate(userId, restoredSession)).resolves.toBe(true);
        expect(restoredSession.getSnapshot()).toMatchObject({
            userId,
            version: sourceSession.getSnapshot().version,
            characterId: 'character-1',
            chatId: 'chat-1',
            chat: expect.arrayContaining([
                expect.objectContaining({ mes: 'Hello' }),
                expect.objectContaining({ mes: 'Hi' }),
            ]),
            chatMetadata: { variables: { mood: 'calm' } },
        });

        persistence.close();
    });

    test('restores a durable version without emitting an intermediate version', async () => {
        const engine = new SessionEngine();
        const session = engine.getSession(`restore-${Date.now()}`);
        const events = [];
        session.on('state:patch', (payload) => events.push(payload.version));

        const result = session.restoreSnapshot({
            chat: [{ name: 'User', is_user: true, is_system: false, mes: 'Restored' }],
            metadata: {},
            stateVersion: 10,
        });

        expect(result).toEqual({ success: true, version: 10 });
        expect(events).toEqual([]);
        expect(session.appendMessage({ name: 'Assistant', is_user: false, is_system: false, mes: 'Next' }).version).toBe(11);
    });

    test('close flushes debounced session saves', async () => {
        const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'st-core-session-flush-'));
        temporaryRoots.push(dataRoot);
        globalThis.DATA_ROOT = dataRoot;

        const userId = `flush-${Date.now()}`;
        const persistence = new SessionPersistence({ debounceMs: 10000 });
        const session = new SessionEngine().getSession(userId);
        session.appendMessage({ name: 'User', is_user: true, is_system: false, mes: 'Flush me' });
        persistence.scheduleSave(userId, session);

        await persistence.close();

        const filePath = persistence.getFilePath(userId);
        await expect(fs.access(filePath)).resolves.toBeUndefined();
    });
});
