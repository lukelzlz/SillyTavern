import EventEmitter from 'node:events';

/**
 * @typedef {object} ChatMessage
 * @property {string} name
 * @property {boolean} is_user
 * @property {boolean} is_system
 * @property {string} send_date
 * @property {string} mes
 * @property {string[]} [swipes]
 * @property {number} [swipe_id]
 * @property {Record<string, unknown>} [extra]
 */

export const MAX_SESSIONS = 100;
export const MAX_PATCH_HISTORY = 100;
export const MAX_SPLICE_ITEMS = 500;
export const MAX_MESSAGE_LENGTH = 500000;
export const USER_ID_REGEX = /^[a-zA-Z0-9_\-@.]{1,64}$/;

/**
 * Validates a userId string.
 * @param {unknown} userId
 * @returns {boolean}
 */
export function isValidUserId(userId) {
    if (typeof userId !== 'string') return false;
    const trimmed = userId.trim();
    return trimmed.length > 0 && trimmed.length <= 64 && USER_ID_REGEX.test(trimmed);
}

/**
 * Validates whether a value can be structured-cloned without cyclical references,
 * functions, symbols, or undefined top-level payloads.
 * @param {unknown} val
 * @param {boolean} [isTopLevel=true]
 * @param {WeakSet<object>} [seen]
 * @returns {{ ok: boolean, error?: string }}
 */
export function validateCloneable(val, isTopLevel = true, seen = new WeakSet()) {
    if (val === null) return { ok: true };
    if (val === undefined) {
        if (isTopLevel) {
            return { ok: false, error: 'Cannot clone undefined value' };
        }
        return { ok: true };
    }
    const t = typeof val;
    if (t === 'function' || t === 'symbol') {
        return { ok: false, error: `Uncloneable type: ${t}` };
    }
    if (t !== 'object') {
        return { ok: true };
    }

    if (seen.has(/** @type {object} */ (val))) {
        return { ok: false, error: 'Cyclic reference detected' };
    }
    seen.add(/** @type {object} */ (val));

    try {
        if (Array.isArray(val)) {
            for (let i = 0; i < val.length; i++) {
                const res = validateCloneable(val[i], false, seen);
                if (!res.ok) return res;
            }
        } else if (val instanceof Set) {
            for (const item of val) {
                const res = validateCloneable(item, false, seen);
                if (!res.ok) return res;
            }
        } else if (val instanceof Map) {
            for (const [k, v] of val.entries()) {
                const kRes = validateCloneable(k, false, seen);
                if (!kRes.ok) return kRes;
                const vRes = validateCloneable(v, false, seen);
                if (!vRes.ok) return vRes;
            }
        } else {
            for (const key of Object.keys(val)) {
                const res = validateCloneable(val[key], false, seen);
                if (!res.ok) return res;
            }
        }
    } finally {
        seen.delete(/** @type {object} */ (val));
    }

    return { ok: true };
}

/**
 * Deep clones any structured-cloneable payload.
 * Returns structured result `{ success: boolean, data?: T, error?: string }`
 * without throwing uncaught exceptions or leaking cyclic/unsupported structures.
 * @template T
 * @param {T} val
 * @returns {{ success: boolean, data?: T, error?: string }}
 */
export function clonePayload(val) {
    const check = validateCloneable(val);
    if (!check.ok) {
        return { success: false, error: check.error };
    }
    try {
        return { success: true, data: structuredClone(val) };
    } catch (err) {
        return { success: false, error: err.message || String(err) };
    }
}

/**
 * Safely caps string length without breaking UTF-16 surrogate pairs.
 * If the cutoff falls on a high surrogate, trims 1 extra character.
 * @param {string} str
 * @param {number} max
 * @returns {string}
 */
export function safeTruncateSurrogate(str, max) {
    if (typeof str !== 'string' || str.length <= max) return str;
    let end = max;
    const code = str.charCodeAt(end - 1);
    if (code >= 0xD800 && code <= 0xDBFF) {
        end--;
    }
    return str.slice(0, end);
}

/**
 * SessionEngine manages stateful session memory and execution pipeline on the server.
 */
export class SessionEngine extends EventEmitter {
    constructor() {
        super();
        /** @type {Map<string, UserSession>} */
        this.sessions = new Map();
        /** @type {number} Monotonically increasing access sequence counter */
        this.accessSequence = 0;
    }

    /**
     * Increment and return the next access sequence number.
     * @returns {number}
     */
    nextSequence() {
        return ++this.accessSequence;
    }

    /**
     * Get or create a session by user key (or 'default' for single-user mode).
     * @param {string} [userId='default']
     * @returns {UserSession}
     */
    getSession(userId) {
        const rawId = userId ?? 'default';
        if (!isValidUserId(rawId)) {
            throw new TypeError(`Invalid userId: "${String(userId)}" does not match format ${USER_ID_REGEX}`);
        }
        const key = String(rawId);
        let session = this.sessions.get(key);
        if (!session) {
            this.#pruneSessions();
            if (this.sessions.size >= MAX_SESSIONS) {
                throw new Error(`SessionEngine capacity reached: maximum of ${MAX_SESSIONS} concurrent sessions reached`);
            }
            session = new UserSession(key, this);
            this.sessions.set(key, session);
        }
        session.touch();
        return session;
    }

    /**
     * Delete an existing session by user key.
     * @param {string} [userId]
     * @returns {boolean}
     */
    deleteSession(userId) {
        const rawId = userId ?? 'default';
        if (!isValidUserId(rawId)) return false;
        const key = String(rawId);
        const session = this.sessions.get(key);
        if (session) {
            session.cleanup();
            return this.sessions.delete(key);
        }
        return false;
    }

    /**
     * Prune oldest sessions if session count exceeds or reaches bound.
     * Hard max policy:
     * 1. Evaluates all non-default sessions.
     * 2. Prefers oldest idle session by monotonic accessSequence.
     * 3. If all non-default are generating, evicts oldest generating session and aborts it.
     */
    #pruneSessions() {
        if (this.sessions.size < MAX_SESSIONS) return;

        let candidate = null;

        // Pass 1: Oldest idle session (excluding default)
        for (const [key, session] of this.sessions.entries()) {
            if (key === 'default') continue;
            if (session.generationState === 'idle') {
                if (!candidate || session.accessSequence < candidate.accessSequence) {
                    candidate = session;
                }
            }
        }

        // Pass 2: If none idle, evict oldest generating session (excluding default)
        if (!candidate) {
            for (const [key, session] of this.sessions.entries()) {
                if (key === 'default') continue;
                if (!candidate || session.accessSequence < candidate.accessSequence) {
                    candidate = session;
                }
            }
        }

        if (candidate) {
            candidate.cleanup();
            this.sessions.delete(candidate.userId);
        }
    }
}

/**
 * UserSession holds active chat state, character context, and generation state.
 */
export class UserSession extends EventEmitter {
    /**
     * @param {string} userId
     * @param {SessionEngine} [engine]
     */
    constructor(userId, engine) {
        super();
        this.userId = userId;
        /** @type {SessionEngine|null} */
        this.engine = engine || null;

        /** @type {boolean} Destruction flag */
        this.destroyed = false;

        /** @type {string|null} */
        this.activeCharacterId = null;
        /** @type {string|null} */
        this.activeCharacterName = null;
        /** @type {string|null} */
        this.activeChatId = null;

        /** @type {ChatMessage[]} */
        this.chat = [];
        /** @type {Record<string, unknown>} */
        this.chatMetadata = { variables: {} };
        /** @type {number} */
        this.stateVersion = 0;

        /** @type {'idle'|'generating'|'intercepting'} */
        this.generationState = 'idle';
        /** @type {AbortController|null} */
        this.activeAbortController = null;

        /** @type {number} Monotonic access sequence position */
        this.accessSequence = this.engine ? this.engine.nextSequence() : 0;

        /** @type {object[]} Bounded circular patch history for gap tracking */
        this.patchHistory = [];

        /** @type {boolean} Internal reentrancy guard for applyPatch */
        this.isApplyingPatch = false;
    }

    touch() {
        if (this.destroyed) return;
        if (this.engine) {
            this.accessSequence = this.engine.nextSequence();
        }
    }

    /**
     * Cleans up running controllers, unbinds engine, sets destroyed flag, and clears listeners.
     */
    cleanup() {
        this.destroyed = true;
        this.engine = null;
        if (this.activeAbortController) {
            try {
                this.activeAbortController.abort();
            } catch {
                // Ignore abort errors
            }
            this.activeAbortController = null;
        }
        this.generationState = 'idle';
        this.removeAllListeners();
    }

    /**
     * Internal helper to record bounded patch history.
     * @param {object} patch
     */
    #recordPatch(patch) {
        const cloned = clonePayload(patch);
        if (!cloned.success) return;
        this.patchHistory.push(cloned.data);
        if (this.patchHistory.length > MAX_PATCH_HISTORY) {
            this.patchHistory.shift();
        }
    }

    /**
     * Internal helper to emit an event on both this session and the parent engine with userId.
     * Emits a deep cloned copy so listener mutations do not corrupt internal state.
     * @param {string} eventName
     * @param {Record<string, unknown>} payload
     */
    #emitEvent(eventName, payload) {
        if (this.destroyed) return;
        this.touch();
        const cloned = clonePayload({ userId: this.userId, ...payload });
        if (!cloned.success) return;
        this.emit(eventName, cloned.data);
        if (this.engine) {
            this.engine.emit(eventName, cloned.data);
        }
    }

    /**
     * Synchronize client full state into the server engine.
     * Completely replaces full state (no stale metadata keys remain),
     * clears patchHistory, records a single authoritative snapshot patch, and emits snapshot events.
     * @param {object} params
     * @param {string|null} [params.characterId]
     * @param {string|null} [params.characterName]
     * @param {string|null} [params.chatId]
     * @param {ChatMessage[]} [params.chat]
     * @param {Record<string, unknown>} [params.metadata]
     */
    syncFullState({ characterId, characterName, chatId, chat, metadata } = {}, { emitEvents = true } = {}) {
        if (this.destroyed) {
            return { success: false, error: 'Session is destroyed' };
        }
        this.touch();

        const clonedMetaRes = metadata !== undefined && metadata !== null ? clonePayload(metadata) : { success: true, data: {} };
        if (!clonedMetaRes.success) {
            return { success: false, error: `Invalid metadata payload: ${clonedMetaRes.error}` };
        }

        const safeChat = [];
        if (Array.isArray(chat)) {
            for (const m of chat) {
                if (!m || typeof m !== 'object' || Array.isArray(m)) continue;
                const mRes = clonePayload(m);
                if (!mRes.success) {
                    return { success: false, error: `Invalid message in chat array: ${mRes.error}` };
                }
                const clonedMsg = mRes.data;
                if (typeof clonedMsg.mes === 'string' && clonedMsg.mes.length > MAX_MESSAGE_LENGTH) {
                    clonedMsg.mes = safeTruncateSurrogate(clonedMsg.mes, MAX_MESSAGE_LENGTH);
                }
                safeChat.push(clonedMsg);
            }
        }

        this.activeCharacterId = (characterId !== undefined && characterId !== null) ? String(characterId) : null;
        this.activeCharacterName = (characterName !== undefined && characterName !== null) ? String(characterName) : null;
        this.activeChatId = (chatId !== undefined && chatId !== null) ? String(chatId) : null;
        this.chat = safeChat;

        if (metadata && typeof metadata === 'object' && !Array.isArray(metadata)) {
            const safeMetadata = clonedMetaRes.data;
            const variables = (safeMetadata.variables && typeof safeMetadata.variables === 'object' && !Array.isArray(safeMetadata.variables))
                ? { ...safeMetadata.variables }
                : {};
            delete safeMetadata.variables;
            this.chatMetadata = {
                ...safeMetadata,
                variables,
            };
        } else {
            this.chatMetadata = { variables: {} };
        }

        this.stateVersion++;

        // Clear historical incremental patches to prevent replaying obsolete state
        this.patchHistory = [];

        const snapshot = this.getSnapshot();
        const patch = { op: 'snapshot', snapshot, version: this.stateVersion };
        this.#recordPatch(patch);

        if (emitEvents) {
            this.#emitEvent('state:updated', {
                version: this.stateVersion,
                characterId: this.activeCharacterId,
                chatId: this.activeChatId,
                messageCount: this.chat.length,
            });

            this.#emitEvent('state:snapshot', {
                snapshot,
                version: this.stateVersion,
            });

            this.#emitEvent('state:patch', {
                patch,
                version: this.stateVersion,
            });
        }

        return { success: true, version: this.stateVersion };
    }

    /**
     * Restore a durable snapshot while preserving its version for future
     * patches. This is intentionally separate from syncFullState so client
     * supplied state can never choose the authoritative server version.
     * @param {object} snapshot
     * @returns {{ success: boolean, version?: number, error?: string }}
     */
    restoreSnapshot(snapshot = {}) {
        const restoredVersion = Number(snapshot.stateVersion ?? snapshot.version);
        const result = this.syncFullState(snapshot, { emitEvents: false });
        if (!result.success) {
            return result;
        }

        if (Number.isSafeInteger(restoredVersion) && restoredVersion >= 0) {
            this.stateVersion = restoredVersion;
            this.patchHistory = [];
        }
        return { success: true, version: this.stateVersion };
    }

    /**
     * Append a message to the active chat history.
     * @param {ChatMessage} message
     */
    appendMessage(message) {
        if (this.destroyed) {
            return { success: false, error: 'Session is destroyed' };
        }
        this.touch();
        if (!message || typeof message !== 'object' || Array.isArray(message)) {
            return { success: false, error: 'Invalid message payload' };
        }

        const cloneRes = clonePayload(message);
        if (!cloneRes.success) {
            return { success: false, error: `Uncloneable message: ${cloneRes.error}` };
        }
        const safeMessage = cloneRes.data;

        if (typeof safeMessage.mes === 'string' && safeMessage.mes.length > MAX_MESSAGE_LENGTH) {
            safeMessage.mes = safeTruncateSurrogate(safeMessage.mes, MAX_MESSAGE_LENGTH);
        }

        this.chat.push(safeMessage);
        this.stateVersion++;
        const index = this.chat.length - 1;

        const patch = { op: 'append', message: safeMessage, index, version: this.stateVersion };
        this.#recordPatch(patch);

        this.#emitEvent('message:appended', { message: safeMessage, index, version: this.stateVersion });
        this.#emitEvent('state:patch', { patch, version: this.stateVersion });

        return { success: true, index, version: this.stateVersion };
    }

    /**
     * Update an existing message by index.
     * @param {number} index
     * @param {Partial<ChatMessage>} updates
     */
    updateMessage(index, updates) {
        if (this.destroyed) {
            return { success: false, error: 'Session is destroyed' };
        }
        this.touch();
        if (!Number.isInteger(index) || index < 0 || index >= this.chat.length) {
            return { success: false, error: 'Index out of bounds' };
        }
        if (!updates || typeof updates !== 'object' || Array.isArray(updates)) {
            return { success: false, error: 'Invalid updates payload' };
        }

        const cloneRes = clonePayload(updates);
        if (!cloneRes.success) {
            return { success: false, error: `Uncloneable updates: ${cloneRes.error}` };
        }
        const safeUpdates = cloneRes.data;

        if (typeof safeUpdates.mes === 'string' && safeUpdates.mes.length > MAX_MESSAGE_LENGTH) {
            safeUpdates.mes = safeTruncateSurrogate(safeUpdates.mes, MAX_MESSAGE_LENGTH);
        }

        this.chat[index] = { ...this.chat[index], ...safeUpdates };
        this.stateVersion++;

        const patch = {
            op: 'update',
            index,
            updates: safeUpdates,
            message: this.chat[index],
            version: this.stateVersion,
        };
        this.#recordPatch(patch);

        this.#emitEvent('message:updated', {
            index,
            updates: safeUpdates,
            message: this.chat[index],
            version: this.stateVersion,
        });
        this.#emitEvent('state:patch', { patch, version: this.stateVersion });

        return { success: true, index, version: this.stateVersion };
    }

    /**
     * Delete a message by index.
     * @param {number} index
     */
    deleteMessage(index) {
        if (this.destroyed) {
            return { success: false, error: 'Session is destroyed' };
        }
        this.touch();
        if (!Number.isInteger(index) || index < 0 || index >= this.chat.length) {
            return { success: false, error: 'Index out of bounds' };
        }

        const removed = this.chat.splice(index, 1)[0];
        this.stateVersion++;

        const patch = {
            op: 'delete',
            index,
            remainingCount: this.chat.length,
            removed,
            version: this.stateVersion,
        };
        this.#recordPatch(patch);

        this.#emitEvent('message:deleted', {
            index,
            remainingCount: this.chat.length,
            removed,
            version: this.stateVersion,
        });
        this.#emitEvent('state:patch', { patch, version: this.stateVersion });

        return { success: true, index, remainingCount: this.chat.length, version: this.stateVersion };
    }

    /**
     * Splice messages in the active chat using native Array.prototype.splice semantics.
     * @param {number} start
     * @param {number} [deleteCount]
     * @param {ChatMessage[]} [items=[]]
     */
    spliceChat(start, deleteCount, items = []) {
        if (this.destroyed) {
            return { success: false, error: 'Session is destroyed' };
        }
        this.touch();
        if (!Number.isInteger(start)) return { success: false, error: 'Invalid start parameter' };

        const rawItems = Array.isArray(items) ? items : [];
        const safeItems = [];
        for (const item of rawItems.slice(0, MAX_SPLICE_ITEMS)) {
            if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
            const itemRes = clonePayload(item);
            if (!itemRes.success) {
                return { success: false, error: `Uncloneable item: ${itemRes.error}` };
            }
            const cloned = itemRes.data;
            if (typeof cloned.mes === 'string' && cloned.mes.length > MAX_MESSAGE_LENGTH) {
                cloned.mes = safeTruncateSurrogate(cloned.mes, MAX_MESSAGE_LENGTH);
            }
            safeItems.push(cloned);
        }

        let removed;
        if (deleteCount === undefined) {
            removed = this.chat.splice(start);
        } else {
            if (!Number.isInteger(deleteCount)) {
                return { success: false, error: 'Invalid deleteCount parameter' };
            }
            removed = this.chat.splice(start, deleteCount, ...safeItems);
        }

        this.stateVersion++;

        const patch = {
            op: 'splice',
            start,
            deleteCount,
            items: safeItems,
            removed,
            remainingCount: this.chat.length,
            version: this.stateVersion,
        };
        this.#recordPatch(patch);

        this.#emitEvent('chat:spliced', {
            start,
            deleteCount,
            items: safeItems,
            removed,
            remainingCount: this.chat.length,
            version: this.stateVersion,
        });
        this.#emitEvent('state:patch', { patch, version: this.stateVersion });

        const clonedRemoved = clonePayload(removed);
        return {
            success: true,
            removed: clonedRemoved.success ? clonedRemoved.data : [],
            count: this.chat.length,
            version: this.stateVersion,
        };
    }

    /**
     * Incrementally update chat metadata with support for variable deletion semantics.
     * When a variable key's value is null or undefined, the key is deleted.
     * @param {Record<string, unknown>} updates
     */
    updateMetadata(updates) {
        if (this.destroyed) {
            return { success: false, error: 'Session is destroyed' };
        }
        this.touch();
        if (!updates || typeof updates !== 'object' || Array.isArray(updates)) {
            return { success: false, error: 'Invalid updates payload' };
        }

        const cloneRes = clonePayload(updates);
        if (!cloneRes.success) {
            return { success: false, error: `Uncloneable updates payload: ${cloneRes.error}` };
        }
        const safeUpdates = cloneRes.data;

        if (safeUpdates.variables && typeof safeUpdates.variables === 'object' && !Array.isArray(safeUpdates.variables)) {
            this.chatMetadata.variables = this.chatMetadata.variables || {};
            for (const [k, v] of Object.entries(safeUpdates.variables)) {
                if (v === null || v === undefined) {
                    delete this.chatMetadata.variables[k];
                } else {
                    this.chatMetadata.variables[k] = v;
                }
            }
            const rest = { ...safeUpdates };
            delete rest.variables;
            Object.assign(this.chatMetadata, rest);
        } else {
            Object.assign(this.chatMetadata, safeUpdates);
        }

        this.stateVersion++;

        const patch = { op: 'setMetadata', updates: safeUpdates, version: this.stateVersion };
        this.#recordPatch(patch);

        this.#emitEvent('metadata:updated', { updates: safeUpdates, metadata: this.chatMetadata, version: this.stateVersion });
        this.#emitEvent('state:patch', { patch, version: this.stateVersion });

        return { success: true, version: this.stateVersion };
    }

    /**
     * Updates the server-owned generation lifecycle without exposing an
     * AbortController to the serialized snapshot or remote clients.
     * @param {'idle'|'generating'|'intercepting'} generationState
     * @param {AbortController|null} [activeAbortController=null]
     */
    setGenerationState(generationState, activeAbortController = null) {
        if (this.destroyed) {
            return { success: false, error: 'Session is destroyed' };
        }
        if (!['idle', 'generating', 'intercepting'].includes(generationState)) {
            return { success: false, error: 'Invalid generation state' };
        }

        this.touch();
        this.generationState = generationState;
        this.activeAbortController = activeAbortController;
        this.stateVersion++;

        const patch = { op: 'generationState', generationState, version: this.stateVersion };
        this.#recordPatch(patch);
        this.#emitEvent('state:patch', { patch, version: this.stateVersion });

        return { success: true, version: this.stateVersion };
    }

    /**
     * Apply a generic state patch with anti-reentrancy and strict current+1 version check.
     * @param {object} patch
     * @param {string} patch.op
     * @param {number} [patch.version]
     */
    applyPatch(patch) {
        if (this.destroyed) {
            return { success: false, error: 'Session is destroyed' };
        }
        if (this.isApplyingPatch) {
            return { success: false, error: 'Reentrancy detected' };
        }
        if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
            return { success: false, error: 'Invalid patch object' };
        }

        // RES-02: Strictly accept ONLY patch.version === this.stateVersion + 1 starting from version=0
        if (typeof patch.version === 'number') {
            const expectedVersion = this.stateVersion + 1;
            if (patch.version !== expectedVersion) {
                const isStale = patch.version <= this.stateVersion;
                return {
                    success: false,
                    error: isStale ? 'Stale patch version' : 'Version gap detected',
                    stale: isStale,
                    dropped: isStale,
                    gap: !isStale,
                };
            }
        }

        this.isApplyingPatch = true;
        try {
            switch (patch.op) {
                case 'append':
                    return this.appendMessage(patch.message);
                case 'update':
                    return this.updateMessage(patch.index, patch.updates || patch.message);
                case 'delete':
                    return this.deleteMessage(patch.index);
                case 'splice':
                    return this.spliceChat(patch.start, patch.deleteCount, patch.items);
                case 'setMetadata':
                    return this.updateMetadata(patch.updates);
                case 'generationState':
                    return this.setGenerationState(patch.generationState);
                case 'snapshot':
                    return this.syncFullState(patch.snapshot || patch);
                default:
                    return { success: false, error: `Unsupported patch op: ${patch.op}` };
            }
        } finally {
            this.isApplyingPatch = false;
        }
    }

    /**
     * Get a full versioned snapshot of the session state.
     * Returns a structured cloned copy completely decoupled from internal memory.
     */
    getSnapshot() {
        this.touch();
        const cloneRes = clonePayload({
            userId: this.userId,
            version: this.stateVersion,
            stateVersion: this.stateVersion,
            characterId: this.activeCharacterId,
            characterName: this.activeCharacterName,
            chatId: this.activeChatId,
            chat: this.chat,
            chatMetadata: this.chatMetadata,
            generationState: this.generationState,
        });
        return cloneRes.success ? cloneRes.data : {};
    }

    /**
     * Alias for getSnapshot.
     */
    getStateSnapshot() {
        return this.getSnapshot();
    }

    /**
     * Get a lightweight summary snapshot of the session.
     */
    getSummary() {
        this.touch();
        const cloneRes = clonePayload({
            userId: this.userId,
            characterId: this.activeCharacterId,
            characterName: this.activeCharacterName,
            chatId: this.activeChatId,
            messageCount: this.chat.length,
            stateVersion: this.stateVersion,
            generationState: this.generationState,
        });
        return cloneRes.success ? cloneRes.data : {};
    }
}

export const sessionEngine = new SessionEngine();
export default sessionEngine;
