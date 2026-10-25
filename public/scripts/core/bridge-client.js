import { eventSource, token } from '../../script.js';

/**
 * BridgeClient handles WebSocket connection to the server Headless Core,
 * bridging server-side state, events, and intercept handshakes.
 */
export class BridgeClient {
    constructor() {
        /** @type {WebSocket|null} */
        this.ws = null;
        this.isConnected = false;
        this.reconnectAttempts = 0;
        this.reconnectTimer = null;

        /** @type {Map<string, { resolve: Function, reject: Function, timer: NodeJS.Timeout }>} */
        this.pendingRpc = new Map();

        /** @type {Map<string, { resolve: Function, reject: Function, timer: NodeJS.Timeout }>} */
        this.pendingJobRequests = new Map();

        /** @type {{ chat: any[], chatMetadata: Record<string, unknown>, version: number, onSync?: Function, snapshotMeta: object, serverInitialized: boolean }|null} */
        this.stateBinding = null;

        this.init();
    }

    init() {
        this.connect();
    }

    getWsUrl() {
        const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
        return `${protocol}//${window.location.host}/api/bridge/ws`;
    }

    async connect() {
        if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) {
            return;
        }

        try {
            // Request short-lived single-use ticket via protected HTTP POST
            const headers = { 'Content-Type': 'application/json' };
            if (token) {
                headers['X-CSRF-Token'] = token;
            }

            const ticketRes = await fetch('/api/core/auth/ticket', {
                method: 'POST',
                headers,
            });

            if (!ticketRes.ok) {
                // If core transport is disabled or unauthenticated, halt and fallback to native route
                this.isConnected = false;
                this.scheduleReconnect();
                return;
            }

            const ticketData = await ticketRes.json();
            if (!ticketData.ok || !ticketData.ticket) {
                this.isConnected = false;
                this.scheduleReconnect();
                return;
            }

            // Connect using Sec-WebSocket-Protocol (st-core.v1, ticket.<ticket>)
            this.ws = new WebSocket(this.getWsUrl(), ['st-core.v1', `ticket.${ticketData.ticket}`]);

            this.ws.onopen = () => {
                console.log('[Core Bridge] Connected to SillyTavern Headless Core');
                this.isConnected = true;
                this.reconnectAttempts = 0;
                if (this.stateBinding) {
                    const syncPromise = this.stateBinding.serverInitialized
                        ? this.refreshBoundState()
                        : this.bootstrapBoundState();
                    syncPromise.catch((error) => {
                        console.warn('[Core Bridge] Failed to refresh bound state:', error);
                    });
                }
            };

            this.ws.onmessage = (event) => {
                this.handleMessage(event.data);
            };

            this.ws.onclose = (event) => {
                this.isConnected = false;
                for (const pending of this.pendingJobRequests.values()) {
                    clearTimeout(pending.timer);
                    pending.reject(new Error('[Core Bridge] WebSocket disconnected during generation operation'));
                }
                this.pendingJobRequests.clear();
                // If closed due to Session Revoked (4001), do not attempt reconnection
                if (event.code === 4001) {
                    console.warn('[Core Bridge] WebSocket connection revoked; halting reconnection.');
                    return;
                }
                this.scheduleReconnect();
            };

            this.ws.onerror = () => {
                if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) {
                    this.ws.close();
                }
            };
        } catch {
            this.scheduleReconnect();
        }
    }

    scheduleReconnect() {
        if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
        // P0 Security: Stop reconnection when bridge upgrade is disabled/rejected to avoid log spam
        if (this.reconnectAttempts >= 1) {
            return;
        }
        this.reconnectAttempts++;
        this.reconnectTimer = setTimeout(() => {
            this.connect();
        }, 2000);
    }

    async handleMessage(rawData) {
        try {
            const msg = JSON.parse(rawData);

            // 1. RPC Response
            if (msg.type === 'rpc_result') {
                const pending = this.pendingRpc.get(msg.id);
                if (pending) {
                    clearTimeout(pending.timer);
                    this.pendingRpc.delete(msg.id);
                    if (msg.error) {
                        pending.reject(new Error(msg.error));
                    } else {
                        pending.resolve(msg.result);
                    }
                }
                return;
            }

            // 1b. Generation operation response. Background job events are
            // delivered without requestId and continue through the event bus.
            if (msg.requestId && this.pendingJobRequests.has(msg.requestId)) {
                const pending = this.pendingJobRequests.get(msg.requestId);
                clearTimeout(pending.timer);
                this.pendingJobRequests.delete(msg.requestId);
                if (msg.type === 'job:failed') {
                    pending.reject(new Error(msg.error || 'Generation operation failed'));
                } else {
                    pending.resolve(msg);
                }
                return;
            }

            // 2. Event broadcast from server -> trigger local eventSource for extensions
            if (msg.type === 'event') {
                const { event, data } = msg;
                await this.applyStateEvent(event, data);
                if (eventSource && typeof eventSource.emit === 'function') {
                    // Transparently trigger local event listeners
                    await eventSource.emit(event, data);
                }
                return;
            }

            // 3. Interception Request (e.g. CHAT_COMPLETION_PROMPT_READY)
            if (msg.type === 'intercept_req') {
                const { interceptId, event, payload } = msg;
                try {
                    if (eventSource && typeof eventSource.emit === 'function') {
                        // Pass payload to client plugins to examine/mutate
                        await eventSource.emit(event, payload);
                    }
                } catch (e) {
                    console.error(`[Core Bridge] Interception hook error for ${event}:`, e);
                } finally {
                    // Acknowledge back to server with the (potentially modified) payload
                    this.send({
                        type: 'intercept_ack',
                        interceptId,
                        payload,
                    });
                }
                return;
            }

            // 4. Initial handshake
            if (msg.type === 'handshake') {
                console.log('[Core Bridge] Handshake complete:', msg.summary);
            }
        } catch (e) {
            console.error('[Core Bridge] Error parsing message:', e);
        }
    }

    /**
     * Binds the current UI state containers as a server-authoritative projection.
     * The arrays/objects are mutated in place so existing DOM and plugin references remain valid.
     * @param {{ chat: any[], chatMetadata?: Record<string, unknown>, characterId?: string|null, characterName?: string|null, chatId?: string|null, onSync?: Function, bootstrap?: boolean }} binding
     * @returns {Promise<void>}
     */
    async bindState({ chat, chatMetadata = {}, characterId = null, characterName = null, chatId = null, onSync, bootstrap = true } = {}) {
        if (!Array.isArray(chat)) {
            throw new TypeError('[Core Bridge] bindState requires a chat array');
        }
        if (!chatMetadata || typeof chatMetadata !== 'object' || Array.isArray(chatMetadata)) {
            throw new TypeError('[Core Bridge] bindState requires a chatMetadata object');
        }

        this.stateBinding = {
            chat,
            chatMetadata,
            version: 0,
            onSync,
            snapshotMeta: { characterId, characterName, chatId },
            serverInitialized: !bootstrap,
        };

        if (this.isConnected) {
            if (bootstrap) {
                await this.bootstrapBoundState();
            } else {
                await this.refreshBoundState();
            }
        }
    }

    /**
     * Removes the current state projection binding.
     */
    unbindState() {
        this.stateBinding = null;
    }

    /**
     * Applies an authoritative state event received from the server.
     * @param {string} event
     * @param {any} data
     * @returns {Promise<void>}
     */
    async applyStateEvent(event, data) {
        const binding = this.stateBinding;
        if (!binding || typeof event !== 'string') {
            return;
        }

        if (event === 'state:snapshot' && data?.snapshot) {
            this.applyStateSnapshot(data.snapshot, data.version);
            return;
        }

        if (event === 'state:patch' && data?.patch) {
            const version = Number(data.version);
            if (Number.isInteger(version) && version <= binding.version) {
                return;
            }
            if (Number.isInteger(version) && version !== binding.version + 1) {
                await this.refreshBoundState();
                return;
            }
            this.applyStatePatch(data.patch, version);
        }
    }

    /**
     * Applies a complete server snapshot while preserving bound object identity.
     * @param {any} snapshot
     * @param {number} [version]
     */
    applyStateSnapshot(snapshot, version = snapshot?.version) {
        const binding = this.stateBinding;
        if (!binding || !snapshot || typeof snapshot !== 'object') {
            return;
        }

        const nextChat = Array.isArray(snapshot.chat) ? snapshot.chat : [];
        binding.chat.splice(0, binding.chat.length, ...nextChat);

        for (const key of Object.keys(binding.chatMetadata)) {
            delete binding.chatMetadata[key];
        }
        const nextMetadata = snapshot.chatMetadata && typeof snapshot.chatMetadata === 'object'
            ? snapshot.chatMetadata
            : {};
        Object.assign(binding.chatMetadata, nextMetadata);

        binding.version = Number.isInteger(version) ? version : Number(snapshot.version) || binding.version;
        binding.serverInitialized = true;
        if (typeof binding.onSync === 'function') {
            binding.onSync({ type: 'snapshot', version: binding.version });
        }
    }

    /**
     * Applies one versioned server patch to the bound projection.
     * @param {any} patch
     * @param {number} [version]
     */
    applyStatePatch(patch, version = patch?.version) {
        const binding = this.stateBinding;
        if (!binding || !patch || typeof patch !== 'object') {
            return false;
        }

        switch (patch.op) {
            case 'append':
                binding.chat.push(patch.message);
                break;
            case 'update':
                if (!Number.isInteger(patch.index) || patch.index < 0 || patch.index >= binding.chat.length) {
                    return false;
                }
                binding.chat[patch.index] = { ...binding.chat[patch.index], ...(patch.updates || patch.message || {}) };
                break;
            case 'delete':
                if (!Number.isInteger(patch.index) || patch.index < 0 || patch.index >= binding.chat.length) {
                    return false;
                }
                binding.chat.splice(patch.index, 1);
                break;
            case 'splice':
                binding.chat.splice(patch.start, patch.deleteCount, ...(Array.isArray(patch.items) ? patch.items : []));
                break;
            case 'setMetadata': {
                const updates = patch.updates && typeof patch.updates === 'object' ? patch.updates : {};
                if (updates.variables && typeof updates.variables === 'object' && !Array.isArray(updates.variables)) {
                    binding.chatMetadata.variables ??= {};
                    for (const [key, value] of Object.entries(updates.variables)) {
                        if (value === null || value === undefined) {
                            delete binding.chatMetadata.variables[key];
                        } else {
                            binding.chatMetadata.variables[key] = value;
                        }
                    }
                }
                for (const [key, value] of Object.entries(updates)) {
                    if (key !== 'variables') {
                        binding.chatMetadata[key] = value;
                    }
                }
                break;
            }
            default:
                return false;
        }

        binding.version = Number.isInteger(version) ? version : binding.version + 1;
        binding.serverInitialized = true;
        if (typeof binding.onSync === 'function') {
            binding.onSync({ type: 'patch', operation: patch.op, version: binding.version });
        }
        return true;
    }

    /**
     * Refreshes the projection after a missed or out-of-order patch.
     */
    async refreshBoundState() {
        if (!this.stateBinding || !this.isConnected) {
            return;
        }
        const snapshot = await this.call('getStateSnapshot');
        this.applyStateSnapshot(snapshot, snapshot?.version);
    }

    /**
     * Makes the current browser state the initial server state for the binding.
     * This is intentionally explicit so enabling the bridge never overwrites a loaded chat with an empty server session.
     */
    async bootstrapBoundState() {
        const binding = this.stateBinding;
        if (!binding || !this.isConnected) {
            return;
        }

        const result = await this.call('syncFullState', {
            ...binding.snapshotMeta,
            chat: binding.chat,
            metadata: binding.chatMetadata,
        });

        if (!result?.success) {
            throw new Error(result?.error || '[Core Bridge] Failed to bootstrap server state');
        }

        binding.version = Number(result.version) || binding.version;
        binding.serverInitialized = true;
        if (typeof binding.onSync === 'function') {
            binding.onSync({ type: 'bootstrap', version: binding.version });
        }
    }

    send(data) {
        if (this.ws && this.ws.readyState === WebSocket.OPEN) {
            this.ws.send(JSON.stringify(data));
            return true;
        }
        return false;
    }

    /**
     * Call an RPC method on the server Headless Core.
     * @param {string} method
     * @param {Record<string, unknown>} params
     * @param {number} [timeoutMs=5000]
     * @returns {Promise<any>}
     */
    call(method, params = {}, timeoutMs = 5000) {
        return new Promise((resolve, reject) => {
            const id = Math.random().toString(36).slice(2);
            const timer = setTimeout(() => {
                this.pendingRpc.delete(id);
                reject(new Error(`[Core Bridge] RPC call '${method}' timed out after ${timeoutMs}ms`));
            }, timeoutMs);

            this.pendingRpc.set(id, { resolve, reject, timer });

            const sent = this.send({
                type: 'rpc',
                id,
                method,
                params,
            });

            if (!sent) {
                clearTimeout(timer);
                this.pendingRpc.delete(id);
                reject(new Error('[Core Bridge] WebSocket is not connected'));
            }
        });
    }

    /**
     * Synchronize client full state to server.
     * @param {object} state
     */
    syncFullState(state) {
        return this.call('syncFullState', state);
    }

    /**
     * Synchronize a newly appended message to server.
     * @param {any} message
     */
    appendMessage(message) {
        return this.call('appendMessage', { message });
    }

    updateMessage(index, updates) {
        return this.call('updateMessage', { index, updates });
    }

    deleteMessage(index) {
        return this.call('deleteMessage', { index });
    }

    spliceChat(start, deleteCount, items = []) {
        return this.call('spliceChat', { start, deleteCount, items });
    }

    updateMetadata(updates) {
        return this.call('updateMetadata', { updates });
    }

    getStateSnapshot() {
        return this.call('getStateSnapshot');
    }

    /**
     * Starts a server-side background generation job.
     * @param {Record<string, unknown>} payload
     * @param {number} [timeoutMs=5000]
     * @returns {Promise<{ type: string, jobId: string, state: string, requestId: string }>}
     */
    startGeneration(payload = {}, timeoutMs = 5000) {
        return this.requestJobOperation('generate:start', payload, timeoutMs);
    }

    /**
     * Aborts a server-side generation job owned by the current user.
     * @param {string} jobId
     * @param {string} [reason='User aborted']
     * @param {number} [timeoutMs=5000]
     * @returns {Promise<{ type: string, jobId: string, status: string, requestId: string }>}
     */
    abortGeneration(jobId, reason = 'User aborted', timeoutMs = 5000) {
        return this.requestJobOperation('generate:abort', { jobId, reason }, timeoutMs);
    }

    /**
     * Reconnects to a server-side generation stream and retrieves missed chunks.
     * @param {string} jobId
     * @param {number} [lastSeq=0]
     * @param {number} [timeoutMs=5000]
     * @returns {Promise<{ type: string, jobId: string, chunks: Array, requestId: string }>}
     */
    reconnectGeneration(jobId, lastSeq = 0, timeoutMs = 5000) {
        return this.requestJobOperation('generate:reconnect', { jobId, lastSeq }, timeoutMs);
    }

    requestJobOperation(type, payload, timeoutMs) {
        return new Promise((resolve, reject) => {
            const requestId = Math.random().toString(36).slice(2);
            const timer = setTimeout(() => {
                this.pendingJobRequests.delete(requestId);
                reject(new Error(`[Core Bridge] Generation operation '${type}' timed out after ${timeoutMs}ms`));
            }, timeoutMs);

            this.pendingJobRequests.set(requestId, { resolve, reject, timer });
            const sent = this.send({ type, id: requestId, payload });
            if (!sent) {
                clearTimeout(timer);
                this.pendingJobRequests.delete(requestId);
                reject(new Error('[Core Bridge] WebSocket is not connected'));
            }
        });
    }
}

export const coreBridge = new BridgeClient();
if (typeof window !== 'undefined') {
    window.coreBridge = coreBridge;
}
export default coreBridge;
