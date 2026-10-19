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

/**
 * SessionEngine manages stateful session memory and execution pipeline on the server.
 */
export class SessionEngine extends EventEmitter {
    constructor() {
        super();
        /** @type {Map<string, UserSession>} */
        this.sessions = new Map();
    }

    /**
     * Get or create a session by user key (or 'default' for single-user mode).
     * @param {string} [userId='default']
     * @returns {UserSession}
     */
    getSession(userId = 'default') {
        let session = this.sessions.get(userId);
        if (!session) {
            session = new UserSession(userId, this);
            this.sessions.set(userId, session);
        }
        return session;
    }
}

/**
 * UserSession holds active chat state, character context, and generation state.
 */
export class UserSession extends EventEmitter {
    /**
     * @param {string} userId
     * @param {SessionEngine} engine
     */
    constructor(userId, engine) {
        super();
        this.userId = userId;
        this.engine = engine;

        /** @type {string|null} */
        this.activeCharacterId = null;
        /** @type {string|null} */
        this.activeCharacterName = null;
        /** @type {string|null} */
        this.activeChatId = null;

        /** @type {ChatMessage[]} */
        this.chat = [];
        /** @type {Record<string, unknown>} */
        this.chatMetadata = {};
        /** @type {number} */
        this.stateVersion = 0;

        /** @type {'idle'|'generating'|'intercepting'} */
        this.generationState = 'idle';
        /** @type {AbortController|null} */
        this.activeAbortController = null;
    }

    /**
     * Synchronize client full state into the server engine.
     * @param {object} params
     * @param {string} [params.characterId]
     * @param {string} [params.characterName]
     * @param {string} [params.chatId]
     * @param {ChatMessage[]} [params.chat]
     * @param {Record<string, unknown>} [params.metadata]
     */
    syncFullState({ characterId, characterName, chatId, chat, metadata }) {
        if (characterId !== undefined) this.activeCharacterId = characterId;
        if (characterName !== undefined) this.activeCharacterName = characterName;
        if (chatId !== undefined) this.activeChatId = chatId;
        if (Array.isArray(chat)) this.chat = [...chat];
        if (metadata && typeof metadata === 'object') this.chatMetadata = { ...metadata };
        this.stateVersion++;

        this.emit('state:updated', {
            version: this.stateVersion,
            characterId: this.activeCharacterId,
            chatId: this.activeChatId,
            messageCount: this.chat.length,
        });

        return { success: true, version: this.stateVersion };
    }

    /**
     * Append a message to the active chat history.
     * @param {ChatMessage} message
     */
    appendMessage(message) {
        this.chat.push(message);
        this.stateVersion++;
        this.emit('message:appended', { message, index: this.chat.length - 1, version: this.stateVersion });
        return { success: true, index: this.chat.length - 1, version: this.stateVersion };
    }

    /**
     * Update an existing message by index.
     * @param {number} index
     * @param {Partial<ChatMessage>} updates
     */
    updateMessage(index, updates) {
        if (index >= 0 && index < this.chat.length) {
            this.chat[index] = { ...this.chat[index], ...updates };
            this.stateVersion++;
            this.emit('message:updated', { index, message: this.chat[index], version: this.stateVersion });
            return { success: true, index, version: this.stateVersion };
        }
        return { success: false, error: 'Index out of bounds' };
    }

    /**
     * Delete a message by index.
     * @param {number} index
     */
    deleteMessage(index) {
        if (index >= 0 && index < this.chat.length) {
            const removed = this.chat.splice(index, 1)[0];
            this.stateVersion++;
            this.emit('message:deleted', { index, removed, version: this.stateVersion });
            return { success: true, index, version: this.stateVersion };
        }
        return { success: false, error: 'Index out of bounds' };
    }

    /**
     * Get a lightweight summary snapshot of the session.
     */
    getSummary() {
        return {
            userId: this.userId,
            characterId: this.activeCharacterId,
            characterName: this.activeCharacterName,
            chatId: this.activeChatId,
            messageCount: this.chat.length,
            stateVersion: this.stateVersion,
            generationState: this.generationState,
        };
    }
}

export const sessionEngine = new SessionEngine();
export default sessionEngine;
