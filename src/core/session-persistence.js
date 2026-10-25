import fs from 'node:fs/promises';
import path from 'node:path';
import { getUserDirectories } from '../users.js';

const SNAPSHOT_VERSION = 1;

/**
 * Persists the current Headless Core session snapshot without touching the
 * native chat JSONL format. This is deliberately a small single-user adapter:
 * it survives server restarts and lets the bridge restore an in-flight chat,
 * while normal browser chat saving remains unchanged.
 */
export class SessionPersistence {
    constructor({ debounceMs = 100 } = {}) {
        this.debounceMs = debounceMs;
        this.pendingTimers = new Map();
        this.pendingSessions = new Map();
        this.writeQueues = new Map();
    }

    getFilePath(userId) {
        try {
            const directories = getUserDirectories(String(userId || 'default'));
            if (!directories?.root) {
                return null;
            }
            return path.join(directories.root, 'core-sessions', 'state.json');
        } catch {
            return null;
        }
    }

    /**
     * Hydrates a newly-created in-memory session. Existing live state always
     * wins, preventing a second tab from overwriting a newer session snapshot.
     * @param {string} userId
     * @param {import('./session-engine.js').UserSession} session
     * @returns {Promise<boolean>}
     */
    async hydrate(userId, session) {
        if (!session || session.getSnapshot().version > 0) {
            return false;
        }

        const filePath = this.getFilePath(userId);
        if (!filePath) {
            return false;
        }

        try {
            const raw = await fs.readFile(filePath, 'utf8');
            const persisted = JSON.parse(raw);
            const snapshot = persisted?.snapshot;
            if (persisted?.version !== SNAPSHOT_VERSION || !snapshot || typeof snapshot !== 'object') {
                return false;
            }

            if (snapshot.userId && snapshot.userId !== String(userId)) {
                return false;
            }

            const restore = session.restoreSnapshot
                ? session.restoreSnapshot.bind(session)
                : session.syncFullState.bind(session);
            const result = restore({
                characterId: snapshot.characterId,
                characterName: snapshot.characterName,
                chatId: snapshot.chatId,
                chat: snapshot.chat,
                metadata: snapshot.chatMetadata,
                stateVersion: snapshot.stateVersion,
                version: snapshot.version,
            });
            if (result?.success) {
                // JobManager state is intentionally process-local. A server
                // restart cannot resume an AbortController-backed job, so a
                // durable "generating" marker must not leave the new session
                // stuck in a phantom generation state.
                session.generationState = 'idle';
                session.activeAbortController = null;
            }
            return Boolean(result?.success);
        } catch (error) {
            if (error?.code !== 'ENOENT') {
                console.warn(`[Core Persistence] Failed to hydrate ${userId}:`, error.message || error);
            }
            return false;
        }
    }

    /**
     * Debounces writes caused by the SessionEngine event stream.
     * @param {string} userId
     * @param {import('./session-engine.js').UserSession} session
     */
    scheduleSave(userId, session) {
        const normalizedUser = String(userId || 'default');
        this.pendingSessions.set(normalizedUser, session);
        const previousTimer = this.pendingTimers.get(normalizedUser);
        if (previousTimer) {
            clearTimeout(previousTimer);
        }

        const timer = setTimeout(() => {
            this.pendingTimers.delete(normalizedUser);
            const pendingSession = this.pendingSessions.get(normalizedUser) || session;
            this.pendingSessions.delete(normalizedUser);
            this.save(normalizedUser, pendingSession).catch((error) => {
                console.warn(`[Core Persistence] Failed to save ${normalizedUser}:`, error.message || error);
            });
        }, this.debounceMs);
        if (typeof timer.unref === 'function') {
            timer.unref();
        }
        this.pendingTimers.set(normalizedUser, timer);
    }

    /**
     * Writes one versioned snapshot atomically and serializes concurrent writes.
     * @param {string} userId
     * @param {import('./session-engine.js').UserSession} session
     * @returns {Promise<boolean>}
     */
    async save(userId, session) {
        const filePath = this.getFilePath(userId);
        if (!filePath || !session) {
            return false;
        }

        const snapshot = session.getSnapshot();
        const payload = JSON.stringify({
            version: SNAPSHOT_VERSION,
            savedAt: Date.now(),
            snapshot,
        });

        const previousWrite = this.writeQueues.get(userId) || Promise.resolve();
        const nextWrite = previousWrite.catch(() => { }).then(async () => {
            const directory = path.dirname(filePath);
            await fs.mkdir(directory, { recursive: true });
            const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
            try {
                await fs.writeFile(tempPath, payload, 'utf8');
                await fs.rename(tempPath, filePath);
            } catch (error) {
                await fs.rm(tempPath, { force: true }).catch(() => { });
                throw error;
            }
        });

        this.writeQueues.set(userId, nextWrite);
        try {
            await nextWrite;
            return true;
        } finally {
            if (this.writeQueues.get(userId) === nextWrite) {
                this.writeQueues.delete(userId);
            }
        }
    }

    async flush() {
        for (const timer of this.pendingTimers.values()) {
            clearTimeout(timer);
        }
        this.pendingTimers.clear();

        const pendingSaves = [];
        for (const [userId, session] of this.pendingSessions.entries()) {
            pendingSaves.push(this.save(userId, session));
        }
        this.pendingSessions.clear();

        await Promise.all(pendingSaves);
        await Promise.all(this.writeQueues.values());
    }

    async close() {
        await this.flush();
    }
}

export default SessionPersistence;
