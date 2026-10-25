import { WebSocketServer } from 'ws';
import crypto, { randomUUID } from 'node:crypto';
import sessionEngine from './session-engine.js';
import WorldInfoEngine from './world-info-engine.js';
import PromptEngine from './prompt-engine.js';
import ticketManager from './ticket-manager.js';
import { getConfigValue } from '../util.js';
import storage from 'node-persist';
import { getUserDirectories } from '../users.js';
import SessionPersistence from './session-persistence.js';

const KEY_PREFIX = 'user:';
function toKey(handle) {
    return `${KEY_PREFIX}${handle}`;
}

function getAccountVersion(user) {
    if (!user) return '';
    return crypto.createHash('shake256', { outputLength: 8 })
        .update(JSON.stringify([user.handle, user.password, user.salt]))
        .digest('hex');
}

/**
 * Safe configuration reader that falls back gracefully when CLI args are not initialized.
 * @param {string} key
 * @param {any} defaultValue
 * @param {'boolean'|'number'|null} [typeConverter]
 * @returns {any}
 */
function getCoreConfig(key, defaultValue, typeConverter = null) {
    const envKey = 'SILLYTAVERN_' + String(key).toUpperCase().replace(/\./g, '_');
    if (envKey in process.env) {
        const val = process.env[envKey];
        if (typeConverter === 'boolean') {
            return String(val).toLowerCase() === 'true';
        }
        if (typeConverter === 'number') {
            const num = parseFloat(val);
            return isNaN(num) ? defaultValue : num;
        }
        return val;
    }
    if (!globalThis.COMMAND_LINE_ARGS) {
        return defaultValue;
    }
    return getConfigValue(key, defaultValue, typeConverter);
}

export class WebSocketBridge {
    constructor() {
        this.wss = new WebSocketServer({
            noServer: true,
            handleProtocols: (protocols, _req) => {
                if (protocols.has('st-core.v1')) {
                    return 'st-core.v1';
                }
                if (protocols.has('st-ticket')) {
                    return 'st-ticket';
                }
                return 'st-core.v1';
            },
        });
        /** @type {Map<string, Set<import('ws').WebSocket>>} userId -> Set<WebSocket> */
        this.userClients = new Map();
        /** @type {Map<string, { userId: string, ws: import('ws').WebSocket|null, jobId: string|null, coreRequestId: string|null, resolve: Function, timer: NodeJS.Timeout }>} interceptId -> resolver */
        this.pendingInterceptions = new Map();
        this.sessionPersistence = new SessionPersistence();

        this.#setupWss();
        this.#bindSessionEngine();
    }

    #setupWss() {
        this.wss.on('connection', async (ws, _request, { userHandle } = {}) => {
            const userId = userHandle || 'default';
            ws.userId = userId;
            ws.isAlive = true;
            const session = sessionEngine.getSession(userId);
            ws.sessionHydration = this.sessionPersistence.hydrate(userId, session);

            let clients = this.userClients.get(userId);
            if (!clients) {
                clients = new Set();
                this.userClients.set(userId, clients);
            }
            clients.add(ws);

            ws.on('pong', () => {
                ws.isAlive = true;
            });

            ws.on('message', async (data) => {
                await ws.sessionHydration;
                // Fail-closed verification: check if user still valid before handling message
                if (userId !== 'default') {
                    const valid = await this.#verifyUserValid(userId);
                    if (!valid) {
                        this.terminateUserConnections(userId, 4001, 'Session Revoked');
                        return;
                    }
                }
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

            // Send initial handshake frame bound to authenticated user after durable state hydration.
            await ws.sessionHydration;
            if (ws.readyState !== 1) {
                return;
            }
            let activeJob = null;
            try {
                const { jobManager } = await import('./generation/job-manager.js');
                activeJob = jobManager.getActiveJob(userId)?.toJSON() || null;
            } catch {
                // The bridge remains usable when the optional generation
                // manager cannot be loaded during an isolated test startup.
            }
            ws.send(JSON.stringify({
                type: 'handshake',
                status: 'authenticated',
                userId,
                summary: session.getSummary(),
                capabilities: {
                    orchestrator: getCoreConfig('core.generation.orchestratorEnabled', true, 'boolean'),
                    serverPromptAssembly: getCoreConfig('core.generation.serverPromptAssemblyEnabled', true, 'boolean'),
                    browserPromptHandoff: getCoreConfig('core.generation.browserPromptHandoffEnabled', false, 'boolean'),
                    promptInterception: getCoreConfig('core.generation.pluginInterceptionEnabled', false, 'boolean'),
                },
                activeJob,
            }));
        });

        // Periodic heartbeat & fail-closed account verification
        this.heartbeatTimer = setInterval(async () => {
            for (const client of this.wss.clients) {
                if (!client.isAlive) {
                    client.terminate();
                    continue;
                }

                if (client.userId && client.userId !== 'default') {
                    const valid = await this.#verifyUserValid(client.userId);
                    if (!valid) {
                        this.terminateUserConnections(client.userId, 4001, 'Session Revoked');
                        continue;
                    }
                }

                client.isAlive = false;
                client.ping();
            }
        }, 30000);
        if (this.heartbeatTimer && typeof this.heartbeatTimer.unref === 'function') {
            this.heartbeatTimer.unref();
        }
    }

    #bindSessionEngine() {
        // Forward authoritative session events to all connected clients for that user.
        const forwardedEvents = [
            'state:updated',
            'state:snapshot',
            'state:patch',
            'message:appended',
            'message:updated',
            'message:deleted',
            'chat:spliced',
            'metadata:updated',
        ];

        for (const eventName of forwardedEvents) {
            sessionEngine.on(eventName, (payload) => {
                const userId = payload?.userId || 'default';
                this.broadcastEvent(userId, eventName, payload);

                if (eventName === 'state:patch') {
                    this.sessionPersistence.scheduleSave(userId, sessionEngine.getSession(userId));
                }

                // Preserve the historical event name consumed by extensions.
                if (eventName === 'message:appended') {
                    this.broadcastEvent(userId, 'MESSAGE_RECEIVED', payload);
                }
            });
        }
    }

    /**
     * Checks if the given Origin header is trusted.
     * Enforces fixed configuration and avoids Host header reflection.
     * @param {string} origin
     * @param {import('http').Server | import('https').Server} server
     * @returns {boolean}
     */
    #isOriginAllowed(origin, server) {
        if (!origin || typeof origin !== 'string') {
            return false;
        }

        try {
            // 1. Explicitly configured trustedOrigins whitelist
            const trustedOrigins = getCoreConfig('core.transport.trustedOrigins', [], null) || [];
            if (Array.isArray(trustedOrigins) && trustedOrigins.includes(origin)) {
                return true;
            }

            const originUrl = new URL(origin);

            // 2. Resolve fixed server bound port
            let serverPort = null;
            if (server && typeof server.address === 'function') {
                const addr = server.address();
                if (addr && typeof addr === 'object') {
                    serverPort = addr.port;
                }
            }
            if (!serverPort) {
                serverPort = getCoreConfig('port', 8000, 'number');
            }

            const originPort = originUrl.port ? Number(originUrl.port) : (originUrl.protocol === 'https:' ? 443 : 80);

            // 3. Local loopback addresses matching server port
            const isLocalHost = ['localhost', '127.0.0.1', '::1', '[::1]'].includes(originUrl.hostname);
            if (isLocalHost && originPort === Number(serverPort)) {
                return true;
            }

            // 4. Fixed configured listen address (NOT reflecting Host header)
            const configuredIpv4 = getCoreConfig('listenAddress.ipv4', null);
            if (configuredIpv4 && configuredIpv4 !== '0.0.0.0' && originUrl.hostname === configuredIpv4 && originPort === Number(serverPort)) {
                return true;
            }

            return false;
        } catch {
            return false;
        }
    }

    /**
     * Verifies that the user still exists, is enabled, and account version matches.
     * @param {string} userHandle
     * @param {string} [expectedVersion]
     * @returns {Promise<boolean>}
     */
    async #verifyUserValid(userHandle, expectedVersion) {
        if (userHandle === 'default') {
            return true;
        }

        try {
            if (typeof storage.getItem !== 'function') {
                return true;
            }
            const user = await storage.getItem(toKey(userHandle));
            if (!user || user.enabled === false) {
                return false;
            }
            if (expectedVersion && typeof getAccountVersion === 'function') {
                if (getAccountVersion(user) !== expectedVersion) {
                    return false;
                }
            }
            return true;
        } catch {
            return false;
        }
    }

    /**
     * Attach authenticated WebSocket upgrade handler to an HTTP/HTTPS server instance.
     * @param {import('http').Server | import('https').Server} server
     */
    attachServer(server) {
        server.on('upgrade', async (request, socket, head) => {
            try {
                const hostHeader = request.headers.host || 'localhost';
                const url = new URL(request.url, `http://${hostHeader}`);
                const cleanPath = url.pathname.replace(/\/+$/, '') || '/';
                if (cleanPath !== '/api/bridge/ws') {
                    // Not our path, allow other upgrade handlers to process it
                    return;
                }

                // Helper to reject upgrade with standard HTTP response and close socket
                const rejectUpgrade = (statusCode, statusText, bodyMessage) => {
                    if (socket.writable) {
                        socket.write(
                            'HTTP/1.1 ' + statusCode + ' ' + statusText + '\r\n' +
                            'Connection: close\r\n' +
                            'Content-Type: text/plain\r\n' +
                            'Content-Length: ' + Buffer.byteLength(bodyMessage) + '\r\n\r\n' +
                            bodyMessage,
                        );
                    }
                    socket.destroy();
                };

                // 1. Feature Flag Guard (Default Closed)
                const isEnabled = getCoreConfig('core.transport.enabled', false, 'boolean');
                if (!isEnabled) {
                    return rejectUpgrade(403, 'Forbidden', 'Forbidden: Core WebSocket Bridge upgrade is disabled.\r\n');
                }

                // 2. Reject Query String Parameter Probe / Spoofing (CWE-598)
                if (url.searchParams.has('ticket') || url.searchParams.has('userId') || url.searchParams.has('token') || url.search) {
                    return rejectUpgrade(403, 'Forbidden', 'Forbidden: Query parameter authentication is forbidden.\r\n');
                }

                // 3. Strict Origin Verification ("固定配置 Origin 规则，不反射 Host")
                const origin = request.headers.origin;
                const allowMissingOrigin = getCoreConfig('core.transport.allowMissingOrigin', false, 'boolean');

                if (!origin) {
                    if (!allowMissingOrigin) {
                        return rejectUpgrade(403, 'Forbidden', 'Forbidden: Missing Origin header.\r\n');
                    }
                } else if (!this.#isOriginAllowed(origin, server)) {
                    return rejectUpgrade(403, 'Forbidden', 'Forbidden: Origin is not trusted.\r\n');
                }

                // 4. Subprotocol negotiation & Ticket extraction
                const subprotocolsHeader = request.headers['sec-websocket-protocol'];
                if (!subprotocolsHeader) {
                    return rejectUpgrade(403, 'Forbidden', 'Forbidden: Missing Sec-WebSocket-Protocol authentication header.\r\n');
                }

                const protocols = subprotocolsHeader.split(',').map(s => s.trim());
                let ticketToken = null;
                for (const proto of protocols) {
                    if (proto.startsWith('ticket.')) {
                        ticketToken = proto.slice('ticket.'.length);
                        break;
                    } else if (proto.startsWith('st-ticket.')) {
                        ticketToken = proto.slice('st-ticket.'.length);
                        break;
                    }
                }

                if (!ticketToken) {
                    return rejectUpgrade(403, 'Forbidden', 'Forbidden: Invalid or missing ticket in Sec-WebSocket-Protocol header.\r\n');
                }

                // 5. Consume ticket atomically (prevents replay)
                const ticketData = ticketManager.consumeTicket(ticketToken);
                if (!ticketData) {
                    return rejectUpgrade(403, 'Forbidden', 'Forbidden: Invalid or expired ticket.\r\n');
                }

                const userHandle = ticketData.userHandle;

                // 6. Account Status Verification
                const userValid = await this.#verifyUserValid(userHandle, ticketData.accountVersion);
                if (!userValid) {
                    return rejectUpgrade(403, 'Forbidden', 'Forbidden: User account revoked or invalid.\r\n');
                }

                // 7. Capacity & Rate Limit Guard
                const maxTotal = getCoreConfig('core.transport.maxTotalConnections', 100, 'number');
                if (this.wss.clients.size >= maxTotal) {
                    return rejectUpgrade(429, 'Too Many Requests', 'Too Many Requests: Server WebSocket capacity reached.\r\n');
                }

                const maxPerUser = getCoreConfig('core.transport.maxConnectionsPerUser', 5, 'number');
                const existingUserClients = this.userClients.get(userHandle);
                if (existingUserClients && existingUserClients.size >= maxPerUser) {
                    return rejectUpgrade(429, 'Too Many Requests', 'Too Many Requests: Per-user WebSocket connection limit reached.\r\n');
                }

                // 8. Complete WebSocket Upgrade (echos only st-core.v1)
                this.wss.handleUpgrade(request, socket, head, (ws) => {
                    this.wss.emit('connection', ws, request, { userHandle });
                });
            } catch (err) {
                console.error('[WS Bridge] Upgrade error:', err);
                socket.destroy();
            }
        });
    }

    /**
     * Actively terminates all active WebSocket connections for a user and revokes their pending tickets.
     * @param {string} userHandle
     * @param {number} [code=4001]
     * @param {string} [reason='Session Revoked']
     */
    terminateUserConnections(userHandle, code = 4001, reason = 'Session Revoked') {
        const clients = this.userClients.get(userHandle);
        if (clients) {
            for (const ws of clients) {
                try {
                    ws.close(code, reason);
                } catch {
                    // Ignore
                }
            }
            this.userClients.delete(userHandle);
        }
        ticketManager.revokeUserTickets(userHandle);
    }

    async #handleMessage(ws, rawData) {
        try {
            const msg = JSON.parse(rawData.toString());
            const { type, id } = msg;

            if (type === 'ping') {
                ws.send(JSON.stringify({ type: 'pong', timestamp: Date.now() }));
                return;
            }

            if (type === 'intercept_ack') {
                const { interceptId, payload, jobId, coreRequestId } = msg;
                const pending = this.pendingInterceptions.get(interceptId);
                if (pending
                    && pending.userId === ws.userId
                    && (!pending.ws || pending.ws === ws)
                    && (!pending.jobId || pending.jobId === jobId)
                    && (!pending.coreRequestId || pending.coreRequestId === coreRequestId)) {
                    clearTimeout(pending.timer);
                    this.pendingInterceptions.delete(interceptId);
                    pending.resolve(payload);
                }
                return;
            }

            if (type === 'generate:start') {
                if (!getCoreConfig('core.generation.orchestratorEnabled', true, 'boolean')) {
                    ws.send(JSON.stringify({
                        type: 'job:failed',
                        requestId: id,
                        errorCode: 'ORCHESTRATOR_DISABLED',
                        error: 'Generation orchestrator is disabled.',
                    }));
                    return;
                }

                try {
                    const { jobManager } = await import('./generation/job-manager.js');
                    let userDirectories = {};
                    try {
                        userDirectories = getUserDirectories(ws.userId);
                    } catch {
                        // Unit/in-process callers may not initialize DATA_ROOT;
                        // the mature gateway will still receive the authenticated
                        // profile, while production startup always provides dirs.
                    }
                    const syntheticReq = {
                        user: {
                            profile: {
                                handle: ws.userId,
                                enabled: true,
                            },
                            directories: userDirectories,
                        },
                        headers: {},
                        session: {},
                        coreBridgeSocket: ws,
                    };
                    const job = await jobManager.createJob({
                        userId: ws.userId,
                        body: msg.payload || {},
                        req: syntheticReq,
                        deferStart: true,
                    });
                    ws.send(JSON.stringify({
                        type: 'job:created',
                        requestId: id,
                        jobId: job.id,
                        state: job.status,
                    }));
                    jobManager.startJob(job, syntheticReq);
                } catch (err) {
                    ws.send(JSON.stringify({
                        type: 'job:failed',
                        requestId: id,
                        errorCode: err.name === 'InvalidGenerationRequestError' ? 'INVALID_GENERATION_REQUEST' : undefined,
                        error: err.message || 'Failed to start generation job',
                    }));
                }
                return;
            }

            if (type === 'generate:abort') {
                const { jobManager } = await import('./generation/job-manager.js');
                const jobId = msg.payload?.jobId;
                const reason = msg.payload?.reason || 'User aborted';

                if (!getCoreConfig('core.generation.orchestratorEnabled', true, 'boolean')) {
                    ws.send(JSON.stringify({
                        type: 'job:failed',
                        requestId: id,
                        jobId,
                        error: 'Generation orchestrator is disabled.',
                    }));
                    return;
                }

                const job = jobManager.getJob(jobId);
                if (!job) {
                    ws.send(JSON.stringify({
                        type: 'job:failed',
                        requestId: id,
                        jobId,
                        error: 'Job not found.',
                    }));
                    return;
                }

                if (job.userId !== ws.userId) {
                    ws.send(JSON.stringify({
                        type: 'job:failed',
                        requestId: id,
                        jobId,
                        error: 'Unauthorized: You do not have access to this job.',
                    }));
                    return;
                }

                jobManager.abortJob(jobId, reason);
                ws.send(JSON.stringify({
                    type: 'job:aborted',
                    requestId: id,
                    jobId,
                    status: job.status,
                }));
                return;
            }

            if (type === 'generate:reconnect') {
                const { jobManager } = await import('./generation/job-manager.js');
                const jobId = msg.payload?.jobId;
                const lastSeq = msg.payload?.lastSeq;

                if (!getCoreConfig('core.generation.orchestratorEnabled', true, 'boolean')) {
                    ws.send(JSON.stringify({
                        type: 'job:failed',
                        requestId: id,
                        jobId,
                        error: 'Generation orchestrator is disabled.',
                    }));
                    return;
                }

                const job = jobManager.getJob(jobId);
                if (job && job.userId === ws.userId) {
                    const catchup = job.getCatchupChunks(lastSeq);
                    ws.send(JSON.stringify({
                        type: 'job:catchup',
                        requestId: id,
                        jobId: job.id,
                        fromSeq: catchup.fromSeq,
                        toSeq: catchup.toSeq,
                        minSeq: catchup.minSeq,
                        maxSeq: catchup.maxSeq,
                        hasMissedChunks: catchup.hasMissedChunks,
                        chunks: catchup.chunks,
                        status: job.status,
                        fullText: job.fullText,
                        lastSeq: job.lastSeq,
                        error: job.error,
                        abortReason: job.abortReason,
                        reasoningText: job.reasoningText,
                        toolCallDeltas: job.toolCallDeltas,
                        tokenStats: job.tokenStats,
                        finishReason: job.finishReason,
                    }));
                } else if (!job) {
                    ws.send(JSON.stringify({
                        type: 'job:failed',
                        requestId: id,
                        jobId,
                        error: 'Job not found.',
                    }));
                } else {
                    ws.send(JSON.stringify({
                        type: 'job:failed',
                        requestId: id,
                        jobId,
                        error: 'Unauthorized: You do not have access to this job.',
                    }));
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
                case 'spliceChat':
                    result = session.spliceChat(params.start, params.deleteCount, params.items);
                    break;
                case 'updateMetadata':
                    result = session.updateMetadata(params.updates);
                    break;
                case 'getSessionSummary':
                    result = session.getSummary();
                    break;
                case 'getStateSnapshot':
                    result = session.getSnapshot();
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
     * @param {{ targetWs?: import('ws').WebSocket|null, jobId?: string|null, coreRequestId?: string|null }} [options]
     * @returns {Promise<any>}
     */
    requestInterception(userId, eventName, payload, timeoutMs = 3000, { targetWs = null, jobId = null, coreRequestId = null } = {}) {
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
            jobId,
            coreRequestId,
            payload,
        });

        return new Promise((resolve) => {
            const timer = setTimeout(() => {
                this.pendingInterceptions.delete(interceptId);
                console.warn(`[WS Bridge] Interception ${interceptId} (${eventName}) timed out, resolving default`);
                resolve(payload);
            }, timeoutMs);

            const destination = targetWs && clients.has(targetWs)
                ? targetWs
                : [...clients].find((client) => client.readyState === client.OPEN);
            this.pendingInterceptions.set(interceptId, {
                userId,
                ws: destination || targetWs,
                jobId,
                coreRequestId,
                resolve,
                timer,
            });
            if (destination) {
                destination.send(msg);
            }
        });
    }

    close() {
        if (this.heartbeatTimer) {
            clearInterval(this.heartbeatTimer);
            this.heartbeatTimer = null;
        }
        for (const client of this.wss.clients) {
            try {
                client.terminate();
            } catch {
                // Ignore
            }
        }
        this.userClients.clear();
        this.pendingInterceptions.clear();
        this.sessionPersistence.close().catch((error) => {
            console.warn('[WS Bridge] Failed to flush core session persistence:', error.message || error);
        });
        this.wss.close();
    }
}

export const wsBridge = new WebSocketBridge();
export default wsBridge;
