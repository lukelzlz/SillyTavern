import { eventSource, token } from '../../script.js';

/**
 * Creates a typed bridge error that can be classified by callers without
 * relying on the human-readable message.
 * @param {string} message
 * @param {string} code
 * @returns {Error & { code: string }}
 */
function createBridgeError(message, code) {
    return Object.assign(new Error(message), { code });
}

/**
 * BridgeClient handles WebSocket connection to the server Headless Core,
 * bridging server-side state, events, and intercept handshakes.
 */
export class BridgeClient {
    constructor() {
        /** @type {WebSocket|null} */
        this.ws = null;
        this.isConnected = false;
        this.isReady = false;
        this.connectionState = 'DISCONNECTED';
        this.capabilities = {};
        /** @type {Array<{ resolve: Function, reject: Function, timer: NodeJS.Timeout }>} */
        this.readyWaiters = [];
        this.reconnectAttempts = 0;
        this.reconnectTimer = null;

        /** @type {Map<string, { resolve: Function, reject: Function, timer: NodeJS.Timeout }>} */
        this.pendingRpc = new Map();

        /** @type {Map<string, { resolve: Function, reject: Function, timer: NodeJS.Timeout }>} */
        this.pendingJobRequests = new Map();

        /** @type {Map<string, { enqueue: Function, getLastSeq: Function, isInitialized: Function, timeoutMs: number, recoveryPromise: Promise|null }>} */
        this.generationListeners = new Map();
        /** @type {object|null} Current server-reported active generation job. */
        this.activeGenerationJob = null;
        /** @type {Promise<any>|null} In-flight remote abort request. */
        this.activeGenerationAbortPromise = null;

        /** @type {number} Number of server-originated events currently being projected. */
        this.remoteEventDepth = 0;

        /** @type {{ chat: any[], chatMetadata: Record<string, unknown>, version: number, onSync?: Function, onGenerationState?: Function, onGenerationError?: Function, generationState: string|null, snapshotMeta: object, serverInitialized: boolean, dirty: boolean }|null} */
        this.stateBinding = null;

        this.init();
    }

    /**
     * True while a server-originated event is being projected into the local UI.
     * Local lifecycle listeners use this to avoid echoing remote state back to the server.
     */
    get isApplyingRemoteEvent() {
        return this.remoteEventDepth > 0;
    }

    init() {
        // The client is imported through script.js and st-context.js, which
        // form a deliberate module cycle. Defer the first read of script.js
        // exports until the module graph has finished initialization.
        queueMicrotask(() => this.connect());
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
            this.connectionState = 'CONNECTING';
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
                // A disabled/unauthenticated bridge is an intentional native
                // transport fallback. Retry only transient server failures.
                this.isConnected = false;
                this.isReady = false;
                this.connectionState = 'DISCONNECTED';
                if (![401, 403].includes(ticketRes.status)) {
                    this.scheduleReconnect();
                }
                return;
            }

            const ticketData = await ticketRes.json();
            if (!ticketData.ok || !ticketData.ticket) {
                this.isConnected = false;
                this.isReady = false;
                this.connectionState = 'DISCONNECTED';
                this.scheduleReconnect();
                return;
            }

            // Connect using Sec-WebSocket-Protocol (st-core.v1, ticket.<ticket>)
            this.ws = new WebSocket(this.getWsUrl(), ['st-core.v1', `ticket.${ticketData.ticket}`]);

            this.ws.onopen = () => {
                console.log('[Core Bridge] Connected to SillyTavern Headless Core');
                this.isConnected = true;
                this.isReady = false;
                this.connectionState = 'OPEN';
                this.capabilities = {};
                this.reconnectAttempts = 0;
                this.reconnectTimer = null;
                if (this.stateBinding) {
                    this.reconcileBoundStateAfterReconnect().catch((error) => {
                        console.warn('[Core Bridge] Failed to refresh bound state:', error);
                    });
                }
                this.recoverGenerationListeners().catch((error) => {
                    console.warn('[Core Bridge] Failed to recover generation streams:', error);
                });
            };

            this.ws.onmessage = (event) => {
                this.handleMessage(event.data);
            };

            this.ws.onclose = (event) => {
                this.isConnected = false;
                this.isReady = false;
                this.connectionState = 'DISCONNECTED';
                this.ws = null;
                for (const waiter of this.readyWaiters.splice(0)) {
                    clearTimeout(waiter.timer);
                    waiter.reject(createBridgeError(
                        '[Core Bridge] WebSocket disconnected before handshake completed',
                        'CORE_BRIDGE_UNAVAILABLE',
                    ));
                }
                for (const pending of this.pendingJobRequests.values()) {
                    clearTimeout(pending.timer);
                    pending.reject(createBridgeError(
                        '[Core Bridge] WebSocket disconnected during generation operation',
                        'CORE_BRIDGE_UNAVAILABLE',
                    ));
                }
                this.pendingJobRequests.clear();
                for (const pending of this.pendingRpc.values()) {
                    clearTimeout(pending.timer);
                    pending.reject(createBridgeError(
                        '[Core Bridge] WebSocket disconnected during RPC operation',
                        'CORE_BRIDGE_UNAVAILABLE',
                    ));
                }
                this.pendingRpc.clear();
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
        if (this.reconnectTimer) {
            return;
        }
        // Retry transient disconnects with bounded exponential backoff. The
        // explicit 401/403 ticket path above intentionally does not retry.
        const attempt = this.reconnectAttempts;
        this.reconnectAttempts = Math.min(attempt + 1, 8);
        const delay = Math.min(2000 * (2 ** attempt), 30000);
        this.reconnectTimer = setTimeout(() => {
            this.reconnectTimer = null;
            this.connect();
        }, delay);
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
                    const error = new Error(msg.error || 'Generation operation failed');
                    if (msg.errorCode === 'ORCHESTRATOR_DISABLED'
                        || /orchestrator is disabled/i.test(String(msg.error || ''))) {
                        Object.assign(error, { code: 'CORE_GENERATION_DISABLED' });
                    }
                    pending.reject(error);
                } else {
                    pending.resolve(msg);
                }
                return;
            }

            // 2. Event broadcast from server -> trigger local eventSource for extensions
            if (msg.type === 'event') {
                const { event, data } = msg;
                this.dispatchGenerationEvent(event, data);
                await this.applyStateEvent(event, data);
                if (eventSource && typeof eventSource.emit === 'function') {
                    // Transparently trigger local event listeners
                    this.remoteEventDepth++;
                    try {
                        await eventSource.emit(event, data);
                    } finally {
                        this.remoteEventDepth--;
                    }
                }
                return;
            }

            // 3. Interception Request (e.g. CHAT_COMPLETION_PROMPT_READY)
            if (msg.type === 'intercept_req') {
                const { interceptId, event, payload, jobId, coreRequestId } = msg;
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
                        jobId,
                        coreRequestId,
                        payload,
                    });
                }
                return;
            }

            // 4. Initial handshake
            if (msg.type === 'handshake') {
                console.log('[Core Bridge] Handshake complete:', msg.summary);
                this.capabilities = msg.capabilities || {};
                // Job snapshots use id; live events and UI controls use jobId.
                // Normalize at the boundary before exposing readiness or recovering streams.
                const jobId = [msg.activeJob?.jobId, msg.activeJob?.id]
                    .find(id => typeof id === 'string' && id.trim().length > 0);
                this.activeGenerationJob = jobId ? { ...msg.activeJob, jobId } : null;
                this.isReady = true;
                this.connectionState = 'READY';
                for (const waiter of this.readyWaiters.splice(0)) {
                    clearTimeout(waiter.timer);
                    waiter.resolve();
                }
                this.recoverGenerationListeners().catch((error) => {
                    console.warn('[Core Bridge] Failed to recover generation streams after handshake:', error);
                });
                if (this.activeGenerationJob && eventSource && typeof eventSource.emit === 'function') {
                    await eventSource.emit('generation:active', this.activeGenerationJob);
                }
            }
        } catch (e) {
            console.error('[Core Bridge] Error parsing message:', e);
        }
    }

    /**
     * Binds the current UI state containers as a server-authoritative projection.
     * The arrays/objects are mutated in place so existing DOM and plugin references remain valid.
     * @param {{ chat: any[], chatMetadata?: Record<string, unknown>, characterId?: string|null, characterName?: string|null, chatId?: string|null, onSync?: Function, onGenerationState?: Function, onGenerationError?: Function, bootstrap?: boolean }} binding
     * @returns {Promise<void>}
     */
    async bindState({ chat, chatMetadata = {}, characterId = null, characterName = null, chatId = null, onSync, onGenerationState, onGenerationError, bootstrap = true } = {}) {
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
            onGenerationState,
            onGenerationError,
            generationState: null,
            snapshotMeta: { characterId, characterName, chatId },
            serverInitialized: !bootstrap,
            dirty: false,
        };

        if (this.isConnected) {
            if (bootstrap) {
                await this.bootstrapOrRefreshBoundState();
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
        binding.dirty = false;
        this.notifyGenerationState(snapshot.generationState);
        if (typeof binding.onSync === 'function') {
            binding.onSync({ type: 'snapshot', version: binding.version });
        }
    }

    /**
     * Projects the server-owned generation lifecycle into the local UI binding.
     * The callback is deliberately isolated from state patch processing so a
     * stale or malformed remote value cannot break the chat projection.
     * @param {unknown} generationState
     */
    notifyGenerationState(generationState) {
        const binding = this.stateBinding;
        if (!binding || typeof generationState !== 'string' || !['idle', 'generating', 'intercepting'].includes(generationState)) {
            return;
        }

        const changed = binding.generationState !== generationState;
        binding.generationState = generationState;
        if (changed && typeof binding.onGenerationState === 'function') {
            try {
                binding.onGenerationState(generationState);
            } catch (error) {
                console.warn('[Core Bridge] Failed to project generation state:', error);
            }
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
            case 'append': {
                const marker = patch.message?.extra?.core_generation_job_id;
                const existingIndex = marker
                    ? binding.chat.findLastIndex((message) => message?.extra?.core_generation_job_id === marker)
                    : -1;
                if (existingIndex >= 0) {
                    binding.chat[existingIndex] = patch.message;
                } else {
                    binding.chat.push(patch.message);
                }
                break;
            }
            case 'update': {
                const marker = patch.updates?.core_generation_job_id || patch.message?.extra?.core_generation_job_id;
                const markerIndex = marker
                    ? binding.chat.findLastIndex((message) => message?.extra?.core_generation_job_id === marker)
                    : -1;
                const index = markerIndex >= 0 ? markerIndex : patch.index;
                if (!Number.isInteger(index) || index < 0 || index >= binding.chat.length) {
                    return false;
                }
                binding.chat[index] = { ...binding.chat[index], ...(patch.updates || patch.message || {}) };
                break;
            }
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
            case 'generationState':
                // The generation lifecycle is server-owned. Project it through
                // the optional UI callback without exposing the server's
                // AbortController to the browser.
                if (typeof patch.generationState !== 'string' || !['idle', 'generating', 'intercepting'].includes(patch.generationState)) {
                    return false;
                }
                this.notifyGenerationState(patch.generationState);
                break;
            default:
                return false;
        }

        binding.version = Number.isInteger(version) ? version : binding.version + 1;
        binding.serverInitialized = true;
        binding.dirty = false;
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
        binding.dirty = false;
        if (typeof binding.onSync === 'function') {
            binding.onSync({ type: 'bootstrap', version: binding.version });
        }
    }

    /**
     * Chooses a safe initial synchronization direction. A non-empty server
     * session for the same chat wins after a page refresh so a completed
     * background generation cannot be overwritten by stale browser state.
     * Empty/new server sessions still bootstrap from the currently loaded UI.
     */
    async bootstrapOrRefreshBoundState() {
        const binding = this.stateBinding;
        if (!binding || !this.isConnected) {
            return;
        }

        const snapshot = await this.getStateSnapshot();
        const sameIdentity = (left, right) => (left == null && right == null) || String(left) === String(right);
        const sameCharacter = sameIdentity(snapshot?.characterId, binding.snapshotMeta.characterId);
        const sameChat = sameIdentity(snapshot?.chatId, binding.snapshotMeta.chatId);
        const serverHasState = Number(snapshot?.version) > 0
            && sameCharacter
            && sameChat
            && Array.isArray(snapshot?.chat);

        if (serverHasState) {
            this.applyStateSnapshot(snapshot, snapshot.version);
            return;
        }

        await this.bootstrapBoundState();
    }

    /**
     * Marks the locally bound state as changed while disconnected or while a
     * debounced sync is pending.
     */
    markBoundStateDirty() {
        if (this.stateBinding) {
            this.stateBinding.dirty = true;
        }
    }

    /**
     * Pushes the currently bound local state to the server without replacing
     * object identities used by the existing UI and extensions.
     */
    async syncBoundState() {
        const binding = this.stateBinding;
        if (!binding || !this.isConnected || this.isApplyingRemoteEvent) {
            return;
        }

        const result = await this.syncFullState({
            ...binding.snapshotMeta,
            chat: binding.chat,
            metadata: binding.chatMetadata,
        });

        if (!result?.success) {
            throw new Error(result?.error || '[Core Bridge] Failed to sync bound state');
        }

        binding.version = Number(result.version) || binding.version;
        binding.serverInitialized = true;
        binding.dirty = false;
        if (typeof binding.onSync === 'function') {
            binding.onSync({ type: 'sync', version: binding.version });
        }
    }

    /**
     * Reconciles a locally dirty projection after a reconnect without allowing
     * stale browser state to overwrite a server-side generation that completed
     * while the browser was suspended or offline.
     */
    async reconcileBoundStateAfterReconnect() {
        const binding = this.stateBinding;
        if (!binding || !this.isConnected) {
            return;
        }

        if (!binding.dirty) {
            if (binding.serverInitialized) {
                await this.refreshBoundState();
            } else {
                await this.bootstrapOrRefreshBoundState();
            }
            return;
        }

        const snapshot = await this.getStateSnapshot();
        const sameIdentity = (left, right) => (left == null && right == null) || String(left) === String(right);
        const sameChat = sameIdentity(snapshot?.chatId, binding.snapshotMeta.chatId);
        const sameCharacter = sameIdentity(snapshot?.characterId, binding.snapshotMeta.characterId);
        const serverVersion = Number(snapshot?.version) || 0;

        if (sameChat && sameCharacter && serverVersion > binding.version) {
            // The server may have completed a background job while the browser
            // was asleep. Its newer snapshot is authoritative.
            this.applyStateSnapshot(snapshot, snapshot.version);
            return;
        }

        if (sameChat && sameCharacter) {
            // No newer server patch exists for this identity. Preserve the
            // intentional local mutation and sync it as the next snapshot.
            await this.syncBoundState();
            return;
        }

        // The browser is now looking at a different chat/character. Bootstrap
        // that identity rather than overwriting it with the old server state.
        await this.bootstrapBoundState();
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
     * Retrieves a generation job snapshot for reconnect/catch-up recovery.
     * @param {string} jobId
     * @param {number} [lastSeq=0]
     * @returns {Promise<any>}
     */
    async getGenerationJob(jobId, lastSeq = 0) {
        const query = new URLSearchParams({ lastSeq: String(Math.max(0, Number(lastSeq) || 0)) });
        const response = await fetch(`/api/core/generation/jobs/${encodeURIComponent(jobId)}?${query.toString()}`, {
            method: 'GET',
            credentials: 'same-origin',
            headers: { Accept: 'application/json' },
        });

        if (!response.ok) {
            throw new Error(`[Core Bridge] Failed to retrieve generation job (${response.status})`);
        }

        return await response.json();
    }

    /**
     * Waits until the authenticated handshake has completed.
     * @param {number} [timeoutMs=5000]
     * @returns {Promise<void>}
     */
    waitUntilReady(timeoutMs = 5000) {
        if (this.isReady) {
            return Promise.resolve();
        }
        if (!this.isConnected) {
            return Promise.reject(createBridgeError(
                '[Core Bridge] WebSocket is not connected',
                'CORE_BRIDGE_UNAVAILABLE',
            ));
        }

        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                const index = this.readyWaiters.findIndex((waiter) => waiter.resolve === resolve);
                if (index >= 0) {
                    this.readyWaiters.splice(index, 1);
                }
                reject(createBridgeError(
                    `[Core Bridge] Handshake timed out after ${timeoutMs}ms`,
                    'CORE_BRIDGE_NOT_READY',
                ));
            }, timeoutMs);
            this.readyWaiters.push({ resolve, reject, timer });
        });
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
     * Starts a server-side job and returns an async stream compatible with the
     * native StreamingProcessor. The server owns the upstream request; closing
     * the browser connection does not abort it unless the caller's signal is
     * explicitly aborted.
     * @param {Record<string, unknown>} payload
     * @param {number} [timeoutMs=5000]
     * @param {AbortSignal|null} [signal=null]
     * @returns {Promise<{ jobId: string, stream: AsyncGenerator }>}
     */
    async startGenerationStream(payload = {}, timeoutMs = 5000, signal = null) {
        await this.waitUntilReady(timeoutMs);
        const created = await this.startGeneration(payload, timeoutMs);
        if (!created?.jobId) {
            throw new Error('[Core Bridge] Generation job did not return a job id');
        }

        return {
            jobId: created.jobId,
            stream: this.followGeneration(created.jobId, { timeoutMs, signal }),
        };
    }

    /**
     * Follows a server-side generation job, including the current snapshot so
     * a reconnect does not lose text emitted before the listener was attached.
     * @param {string} jobId
     * @param {{ timeoutMs?: number, signal?: AbortSignal|null }} [options]
     * @returns {AsyncGenerator<{ event: string, data: any }>}
     */
    followGeneration(jobId, { timeoutMs = 5000, signal = null } = {}) {
        const client = this;
        const state = {
            queue: [],
            waiters: [],
            lastEmittedText: '',
            lastSeq: 0,
            terminal: false,
            initialized: false,
        };

        const enqueue = (event, data) => {
            if (state.terminal) {
                return;
            }

            if ((event === 'generation:token' || event === 'generation:completed') && Number.isFinite(Number(data?.seq))) {
                state.lastSeq = Math.max(state.lastSeq, Number(data.seq));
            }

            const item = { event, data };
            const waiter = state.waiters.shift();
            if (waiter) {
                waiter(item);
            } else {
                state.queue.push(item);
            }
        };

        const listener = {
            enqueue,
            getLastSeq: () => state.lastSeq,
            isInitialized: () => state.initialized,
            timeoutMs,
            recoveryPromise: null,
        };
        this.generationListeners.set(jobId, listener);

        const waitForEvent = () => {
            if (state.queue.length > 0) {
                return Promise.resolve(state.queue.shift());
            }

            return new Promise((resolve) => {
                state.waiters.push(resolve);
            });
        };

        const replayCatchup = function* (catchup) {
            const chunks = Array.isArray(catchup?.chunks) ? catchup.chunks : [];
            const fullText = typeof catchup?.fullText === 'string' ? catchup.fullText : '';

            if (catchup?.hasMissedChunks && fullText) {
                if (fullText !== state.lastEmittedText) {
                    state.lastEmittedText = fullText;
                    yield {
                        event: 'generation:token',
                        data: {
                            jobId,
                            seq: Number(catchup.lastSeq) || Number(catchup.maxSeq) || state.lastSeq,
                            delta: fullText,
                            fullText,
                        },
                    };
                }
                state.lastSeq = Math.max(state.lastSeq, Number(catchup.lastSeq) || Number(catchup.maxSeq) || 0);
                return;
            }

            let replayText = state.lastEmittedText;
            for (const chunk of chunks) {
                const seq = Number(chunk?.seq) || 0;
                if (seq <= state.lastSeq) {
                    continue;
                }
                replayText += String(chunk?.delta || '');
                state.lastSeq = Math.max(state.lastSeq, seq);
                if (!replayText || replayText === state.lastEmittedText) {
                    continue;
                }
                state.lastEmittedText = replayText;
                yield {
                    event: 'generation:token',
                    data: {
                        jobId,
                        seq,
                        delta: chunk.delta,
                        fullText: replayText,
                    },
                };
            }

            if (fullText && fullText !== state.lastEmittedText) {
                state.lastEmittedText = fullText;
                yield {
                    event: 'generation:token',
                    data: {
                        jobId,
                        seq: Number(catchup.lastSeq) || Number(catchup.maxSeq) || state.lastSeq,
                        delta: fullText,
                        fullText,
                    },
                };
            }
        };

        const finishCatchup = (catchup) => {
            if (catchup?.status === 'COMPLETED') {
                state.terminal = true;
                return 'completed';
            }
            if (catchup?.status === 'ABORTED') {
                state.terminal = true;
                throw new Error(catchup.abortReason || 'Generation aborted');
            }
            if (catchup?.status === 'FAILED') {
                state.terminal = true;
                throw Object.assign(new Error(catchup.error || 'Generation failed'), { code: 'CORE_GENERATION_FAILED' });
            }
            return null;
        };

        const stream = (async function* () {
            const abortHandler = () => {
                client.abortGeneration(jobId, 'Client aborted generation', timeoutMs).catch(() => { });
            };

            if (signal) {
                if (signal.aborted) {
                    abortHandler();
                } else {
                    signal.addEventListener('abort', abortHandler, { once: true });
                }
            }

            try {
                const snapshot = await client.getGenerationJob(jobId, 0);
                const job = snapshot?.job;
                let recoveryNeeded = false;
                const catchup = await client.reconnectGeneration(jobId, 0, timeoutMs).catch(() => {
                    recoveryNeeded = true;
                    return null;
                });
                if (catchup) {
                    for (const item of replayCatchup(catchup)) {
                        yield item;
                    }
                    if (finishCatchup(catchup) === 'completed') {
                        return;
                    }
                } else if (job?.fullText) {
                    state.lastEmittedText = job.fullText;
                    state.lastSeq = Number(job.lastSeq) || 0;
                    yield {
                        event: 'generation:token',
                        data: {
                            jobId,
                            seq: job.lastSeq || 0,
                            delta: job.fullText,
                            fullText: job.fullText,
                        },
                    };
                }

                state.initialized = true;
                if (recoveryNeeded && client.isReady) {
                    client.recoverGenerationListener(jobId, listener);
                }

                if (job?.status === 'COMPLETED') {
                    state.terminal = true;
                    return;
                }
                if (job?.status === 'ABORTED') {
                    state.terminal = true;
                    throw new Error(job.abortReason || 'Generation aborted');
                }
                if (job?.status === 'FAILED') {
                    state.terminal = true;
                    throw Object.assign(new Error(job.error || 'Generation failed'), { code: 'CORE_GENERATION_FAILED' });
                }

                while (true) {
                    const item = await waitForEvent();
                    const data = item.data || {};

                    if (item.event === 'generation:catchup') {
                        for (const replayed of replayCatchup(data)) {
                            yield replayed;
                        }
                        if (finishCatchup(data) === 'completed') {
                            return;
                        }
                        continue;
                    }

                    if (item.event === 'generation:reconnect_error') {
                        continue;
                    }

                    if (item.event === 'generation:token') {
                        if (!data.fullText || data.fullText === state.lastEmittedText) {
                            continue;
                        }
                        state.lastEmittedText = data.fullText;
                        state.lastSeq = Math.max(state.lastSeq, Number(data.seq) || 0);
                        yield item;
                        continue;
                    }

                    if (item.event === 'generation:reasoning'
                        || item.event === 'generation:tool_call'
                        || item.event === 'generation:usage') {
                        yield item;
                        continue;
                    }

                    if (item.event === 'generation:completed') {
                        if (data.fullText && data.fullText !== state.lastEmittedText) {
                            state.lastEmittedText = data.fullText;
                            state.lastSeq = Math.max(state.lastSeq, Number(data.seq) || 0, Number(data.lastSeq) || 0);
                            yield {
                                event: 'generation:token',
                                data: {
                                    ...data,
                                    delta: data.fullText,
                                },
                            };
                        }
                        state.terminal = true;
                        return;
                    }

                    if (item.event === 'generation:aborted') {
                        state.terminal = true;
                        throw new Error(data.reason || 'Generation aborted');
                    }

                    if (item.event === 'generation:failed') {
                        state.terminal = true;
                        throw Object.assign(new Error(data.error || 'Generation failed'), { code: 'CORE_GENERATION_FAILED' });
                    }
                }
            } finally {
                if (signal) {
                    signal.removeEventListener('abort', abortHandler);
                }
                client.generationListeners.delete(jobId);
                for (const waiter of state.waiters.splice(0)) {
                    waiter({ event: 'generation:failed', data: { error: 'Generation stream closed' } });
                }
            }
        })();

        return stream;
    }

    dispatchGenerationEvent(event, data) {
        const jobId = data?.jobId;
        if (jobId) {
            if (event === 'generation:started') {
                this.activeGenerationJob = {
                    ...(this.activeGenerationJob?.jobId === jobId ? this.activeGenerationJob : {}),
                    ...data,
                    jobId,
                    status: data.status || 'PREPARING',
                };
            } else if (this.activeGenerationJob?.jobId === jobId) {
                this.activeGenerationJob = {
                    ...this.activeGenerationJob,
                    ...(data || {}),
                    status: event === 'generation:token'
                        ? 'STREAMING'
                        : event === 'generation:completed'
                            ? 'COMPLETED'
                            : event === 'generation:aborted'
                                ? 'ABORTED'
                                : event === 'generation:failed'
                                    ? 'FAILED'
                                    : this.activeGenerationJob.status,
                };
                if (['generation:completed', 'generation:aborted', 'generation:failed'].includes(event)) {
                    const failedJob = this.activeGenerationJob;
                    this.activeGenerationJob = null;
                    const binding = this.stateBinding;
                    // Matching and clearing the active job makes duplicate terminal
                    // frames harmless. Do not report a different chat's failure.
                    if (event === 'generation:failed' && binding?.onGenerationError
                        && String(failedJob.chatId ?? '') === String(binding.snapshotMeta.chatId ?? '')) {
                        try {
                            binding.onGenerationError(failedJob);
                        } catch (error) {
                            console.warn('[Core Bridge] Failed to report generation error:', error);
                        }
                    }
                }
            }
        }
        const listener = jobId ? this.generationListeners.get(jobId) : null;
        if (listener) {
            listener.enqueue(event, data);
        }
    }

    /**
     * Aborts the currently active server-side generation for this browser
     * session. This is used by a second tab that has the server-owned
     * generation UI but no local StreamingProcessor.
     * @param {string} [reason='User aborted']
     * @param {number} [timeoutMs=5000]
     * @returns {Promise<any>}
     */
    stopActiveGeneration(reason = 'User aborted', timeoutMs = 5000) {
        const jobId = this.activeGenerationJob?.jobId || this.activeGenerationJob?.id;
        if (!jobId) {
            return Promise.resolve(null);
        }
        if (this.activeGenerationAbortPromise) {
            return this.activeGenerationAbortPromise;
        }

        this.activeGenerationAbortPromise = this.abortGeneration(jobId, reason, timeoutMs)
            .finally(() => {
                this.activeGenerationAbortPromise = null;
            });
        return this.activeGenerationAbortPromise;
    }

    /**
     * Requests catch-up for generation streams that survived a temporary
     * WebSocket disconnect.
     */
    async recoverGenerationListeners() {
        if (!this.isReady) {
            return;
        }

        const recoveries = [];
        for (const [jobId, listener] of this.generationListeners.entries()) {
            const recovery = this.recoverGenerationListener(jobId, listener);
            if (recovery) {
                recoveries.push(recovery);
            }
        }
        await Promise.all(recoveries);
    }

    /**
     * Requests catch-up for one initialized generation stream. Returning the
     * shared promise prevents the handshake and initial stream setup race from
     * issuing duplicate reconnect operations.
     * @param {string} jobId
     * @param {object} listener
     * @returns {Promise<void>|null}
     */
    recoverGenerationListener(jobId, listener = this.generationListeners.get(jobId)) {
        if (!this.isReady || !listener?.isInitialized() || listener.recoveryPromise) {
            return null;
        }

        const recovery = this.reconnectGeneration(jobId, listener.getLastSeq(), listener.timeoutMs)
            .then((catchup) => listener.enqueue('generation:catchup', catchup))
            .catch((error) => listener.enqueue('generation:reconnect_error', { error: error.message }));
        listener.recoveryPromise = recovery.finally(() => {
            listener.recoveryPromise = null;
        });
        return listener.recoveryPromise;
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
