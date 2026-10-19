import { eventSource } from '../script.js';

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

        this.init();
    }

    init() {
        this.connect();
    }

    getWsUrl() {
        const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
        return `${protocol}//${window.location.host}/api/bridge/ws`;
    }

    connect() {
        if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) {
            return;
        }

        try {
            this.ws = new WebSocket(this.getWsUrl());

            this.ws.onopen = () => {
                console.log('[Core Bridge] Connected to SillyTavern Headless Core');
                this.isConnected = true;
                this.reconnectAttempts = 0;
            };

            this.ws.onmessage = (event) => {
                this.handleMessage(event.data);
            };

            this.ws.onclose = () => {
                this.isConnected = false;
                this.scheduleReconnect();
            };

            this.ws.onerror = (err) => {
                console.warn('[Core Bridge] WebSocket error:', err);
                this.ws.close();
            };
        } catch (e) {
            console.error('[Core Bridge] Connection failed:', e);
            this.scheduleReconnect();
        }
    }

    scheduleReconnect() {
        if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
        const delay = Math.min(1000 * Math.pow(1.5, this.reconnectAttempts), 15000);
        this.reconnectAttempts++;
        this.reconnectTimer = setTimeout(() => {
            console.log(`[Core Bridge] Reconnecting (attempt ${this.reconnectAttempts})...`);
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

            // 2. Event broadcast from server -> trigger local eventSource for extensions
            if (msg.type === 'event') {
                const { event, data } = msg;
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
}

export const coreBridge = new BridgeClient();
if (typeof window !== 'undefined') {
    window.coreBridge = coreBridge;
}
export default coreBridge;
