import { WebSocketServer } from 'ws';
import { randomUUID } from 'node:crypto';
import sessionEngine from './session-engine.js';
import WorldInfoEngine from './world-info-engine.js';
import PromptEngine from './prompt-engine.js';

export class WebSocketBridge {
    constructor() {
        this.wss = new WebSocketServer({ noServer: true });
        /** @type {Map<string, Set<import('ws').WebSocket>>} userId -> Set<WebSocket> */
        this.userClients = new Map();
        /** @type {Map<string, { resolve: Function, timer: NodeJS.Timeout }>} interceptId -> resolver */
        this.pendingInterceptions = new Map();

        this.#setupWss();
        this.#bindSessionEngine();
    }

    #setupWss() {
        this.wss.on('connection', (ws, request) => {
            // Default user association (can be expanded via auth tokens/cookies)
            const userId = 'default';
            ws.userId = userId;
            ws.isAlive = true;

            let clients = this.userClients.get(userId);
            if (!clients) {
                clients = new Set();
                this.userClients.set(userId, clients);
            }
            clients.add(ws);

            ws.on('pong', () => {
                ws.isAlive = true;
            });

            ws.on('message', (data) => {
                this.#handleMessage(ws, data);
            });

            ws.on('close', () => {
                const set = this.userClients.get(userId);
                if (set) {
                    set.delete(ws);
                    if (set.size === 0) {
                        this.userClients.delete(userId);
                    }
                }
            });

            // Send initial handshake
            ws.send(JSON.stringify({
                type: 'handshake',
                status: 'connected',
                userId,
                summary: sessionEngine.getSession(userId).getSummary(),
            }));
        });

        // Periodic heartbeat
        this.heartbeatTimer = setInterval(() => {
            for (const client of this.wss.clients) {
                if (!client.isAlive) {
                    client.terminate();
                    continue;
                }
                client.isAlive = false;
                client.ping();
            }
        }, 30000);
    }

    #bindSessionEngine() {
        // Forward session events to all connected clients for that user
        sessionEngine.on('message:appended', ({ message, index, version }) => {
            this.broadcastEvent('default', 'MESSAGE_RECEIVED', { message, index, version });
        });
    }

    /**
     * Attach WebSocket upgrade handler to an HTTP/HTTPS server instance.
     * @param {import('http').Server | import('https').Server} server
     */
    attachServer(server) {
        server.on('upgrade', (request, socket, head) => {
            try {
                const url = new URL(request.url, `http://${request.headers.host || 'localhost'}`);
                if (url.pathname === '/api/bridge/ws') {
                    this.wss.handleUpgrade(request, socket, head, (ws) => {
                        this.wss.emit('connection', ws, request);
                    });
                }
            } catch (err) {
                socket.destroy();
            }
        });
    }

    #handleMessage(ws, rawData) {
        try {
            const msg = JSON.parse(rawData.toString());
            const { type, id } = msg;

            if (type === 'ping') {
                ws.send(JSON.stringify({ type: 'pong', timestamp: Date.now() }));
                return;
            }

            if (type === 'intercept_ack') {
                const { interceptId, payload } = msg;
                const pending = this.pendingInterceptions.get(interceptId);
                if (pending) {
                    clearTimeout(pending.timer);
                    this.pendingInterceptions.delete(interceptId);
                    pending.resolve(payload);
                }
                return;
            }

            if (type === 'rpc') {
                this.#handleRpc(ws, id, msg.method, msg.params);
            }
        } catch (error) {
            console.error('[WS Bridge] Failed to handle message:', error);
        }
    }

    #handleRpc(ws, id, method, params = {}) {
        const session = sessionEngine.getSession(ws.userId);
        let result;
        let error;

        try {
            switch (method) {
                case 'syncFullState':
                    result = session.syncFullState(params);
                    break;
                case 'appendMessage':
                    result = session.appendMessage(params.message);
                    break;
                case 'updateMessage':
                    result = session.updateMessage(params.index, params.updates);
                    break;
                case 'deleteMessage':
                    result = session.deleteMessage(params.index);
                    break;
                case 'getSessionSummary':
                    result = session.getSummary();
                    break;
                case 'scanWorldInfo':
                    result = WorldInfoEngine.scan(params);
                    break;
                case 'assemblePrompt':
                    result = PromptEngine.assemble(params);
                    break;
                default:
                    error = `Unknown method: ${method}`;
            }
        } catch (e) {
            error = e.message || String(e);
        }

        ws.send(JSON.stringify({
            type: 'rpc_result',
            id,
            result,
            error,
        }));
    }

    /**
     * Broadcast an event to all connected clients for a user.
     * @param {string} userId
     * @param {string} eventName
     * @param {unknown} data
     */
    broadcastEvent(userId, eventName, data) {
        const clients = this.userClients.get(userId);
        if (!clients || clients.size === 0) return;

        const payload = JSON.stringify({
            type: 'event',
            event: eventName,
            data,
        });

        for (const ws of clients) {
            if (ws.readyState === ws.OPEN) {
                ws.send(payload);
            }
        }
    }

    /**
     * Request client-side interception (e.g. for plugins to inspect/modify prompt before generation).
     * @param {string} userId
     * @param {string} eventName
     * @param {any} payload
     * @param {number} [timeoutMs=3000]
     * @returns {Promise<any>}
     */
    requestInterception(userId, eventName, payload, timeoutMs = 3000) {
        const clients = this.userClients.get(userId);
        if (!clients || clients.size === 0) {
            // No client connected to intercept, proceed immediately
            return Promise.resolve(payload);
        }

        const interceptId = randomUUID();
        const msg = JSON.stringify({
            type: 'intercept_req',
            interceptId,
            event: eventName,
            payload,
        });

        return new Promise((resolve) => {
            const timer = setTimeout(() => {
                this.pendingInterceptions.delete(interceptId);
                console.warn(`[WS Bridge] Interception ${interceptId} (${eventName}) timed out, resolving default`);
                resolve(payload);
            }, timeoutMs);

            this.pendingInterceptions.set(interceptId, { resolve, timer });

            // Send to the first active client for the user (primary UI)
            for (const ws of clients) {
                if (ws.readyState === ws.OPEN) {
                    ws.send(msg);
                    break;
                }
            }
        });
    }

    close() {
        if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
        this.wss.close();
    }
}

export const wsBridge = new WebSocketBridge();
export default wsBridge;
