import EventEmitter from 'node:events';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { GenerationJob, JOB_STATUS } from './job.js';
import { SyntheticResponse, createSyntheticRequest } from './synthetic-response.js';
import defaultSessionEngine from '../session-engine.js';
import defaultWsBridge from '../ws-bridge.js';
import { getConfigValue, setConfigFilePath } from '../../util.js';

let defaultGenerateHandlerPromise = null;

/**
 * Lazily loads the mature chat-completions gateway with config fallback.
 * @returns {Promise<(req: any, res: any) => Promise<any>>}
 */
export async function getDefaultGenerateHandler() {
    if (!defaultGenerateHandlerPromise) {
        defaultGenerateHandlerPromise = (async () => {
            try {
                try {
                    const currentDir = path.dirname(fileURLToPath(import.meta.url));
                    const defaultConfigPath = path.resolve(currentDir, '../../../default/config.yaml');
                    setConfigFilePath(defaultConfigPath);
                } catch {
                    // Ignore if already set
                }
                const mod = await import('../../endpoints/backends/chat-completions.js');
                return mod.handleGenerate;
            } catch (err) {
                console.error('[JobManager] Failed to load chat-completions gateway:', err);
                return null;
            }
        })();
    }
    return defaultGenerateHandlerPromise;
}

/**
 * Safe configuration reader supporting environment variables and config.yaml.
 * @param {string} key
 * @param {any} defaultValue
 * @param {'boolean'|'number'|null} [typeConverter]
 * @returns {any}
 */
export function getGenerationConfig(key, defaultValue, typeConverter = null) {
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

/**
 * Generation Orchestrator & Server Job Manager.
 * Coordinates multi-user background generation jobs, enforces fail-closed concurrency locks,
 * dispatches streaming token events over WebSocket, enables stream catch-up on reconnection,
 * and settles completed messages into SessionEngine.
 */
export class JobManager extends EventEmitter {
    /**
     * @param {object} [options]
     * @param {(req: any, res: any) => Promise<any>} [options.generateHandler]
     * @param {import('../session-engine.js').SessionEngine} [options.sessionEngine]
     * @param {import('../ws-bridge.js').WebSocketBridge} [options.wsBridge]
     */
    constructor({
        generateHandler = null,
        sessionEngine = defaultSessionEngine,
        wsBridge = defaultWsBridge,
    } = {}) {
        super();

        /** @type {((req: any, res: any) => Promise<any>)|null} */
        this.generateHandler = generateHandler;
        /** @type {import('../session-engine.js').SessionEngine} */
        this.sessionEngine = sessionEngine;
        /** @type {import('../ws-bridge.js').WebSocketBridge} */
        this.wsBridge = wsBridge;

        /** @type {Map<string, string>} User ID -> active Job ID concurrency map */
        this.activeUserJobs = new Map();

        /** @type {Map<string, GenerationJob>} All jobs in memory indexed by Job ID */
        this.jobs = new Map();

        /** @type {NodeJS.Timeout|null} Periodic GC timer */
        this._gcTimer = setInterval(() => {
            this.purgeStaleJobs();
        }, 60000);

        if (this._gcTimer && typeof this._gcTimer.unref === 'function') {
            this._gcTimer.unref();
        }
    }

    /**
     * Gets configured stream chunk ring buffer capacity.
     * @returns {number}
     */
    getRingBufferSize() {
        return getGenerationConfig('core.generation.streamChunkRingBufferSize', 2048, 'number');
    }

    /**
     * Gets job retention duration in seconds before memory GC.
     * @returns {number}
     */
    getJobRetentionSeconds() {
        return getGenerationConfig('core.generation.jobRetentionSeconds', 300, 'number');
    }

    /**
     * Gets plugin prompt interception timeout in milliseconds.
     * @returns {number}
     */
    getPluginInterceptionTimeoutMs() {
        return getGenerationConfig('core.generation.pluginInterceptionTimeoutMs', 3000, 'number');
    }

    /**
     * Checks if a user has an active, non-terminal generation job.
     * @param {string} userId
     * @returns {boolean}
     */
    hasActiveJob(userId) {
        const normalizedUser = String(userId || 'default');
        const activeJobId = this.activeUserJobs.get(normalizedUser);
        if (!activeJobId) {
            return false;
        }

        const job = this.jobs.get(activeJobId);
        if (!job || job.isTerminal()) {
            this.activeUserJobs.delete(normalizedUser);
            return false;
        }

        return true;
    }

    /**
     * Gets the current active job for a user, or null if none.
     * @param {string} userId
     * @returns {GenerationJob|null}
     */
    getActiveJob(userId) {
        const normalizedUser = String(userId || 'default');
        const activeJobId = this.activeUserJobs.get(normalizedUser);
        if (!activeJobId) {
            return null;
        }

        const job = this.jobs.get(activeJobId);
        if (!job || job.isTerminal()) {
            this.activeUserJobs.delete(normalizedUser);
            return null;
        }

        return job;
    }

    /**
     * Retrieves a job by ID.
     * @param {string} jobId
     * @returns {GenerationJob|null}
     */
    getJob(jobId) {
        if (!jobId || typeof jobId !== 'string') {
            return null;
        }
        return this.jobs.get(jobId) || null;
    }

    /**
     * Creates and starts a new generation job in the background.
     * Enforces fail-closed concurrency lock: single active job per user.
     * @param {object} options
     * @param {string} [options.userId='default']
     * @param {object} [options.body={}]
     * @param {object} [options.req=null]
     * @returns {Promise<GenerationJob>}
     */
    async createJob({ userId = 'default', body = {}, req = null } = {}) {
        const normalizedUser = String(userId || 'default');

        // Fail-Closed Concurrency Guard (Active Job Limit = 1)
        if (this.hasActiveJob(normalizedUser)) {
            const err = new Error('Another generation job is currently in progress.');
            err.name = 'ActiveJobConflictError';
            // @ts-ignore
            err.status = 409;
            // @ts-ignore
            err.statusCode = 409;
            throw err;
        }

        const capacity = this.getRingBufferSize();
        const job = new GenerationJob({
            userId: normalizedUser,
            chatId: body?.chatId || null,
            characterId: body?.characterId || null,
            characterName: body?.characterName || null,
            requestBody: body || {},
            capacity,
        });

        this.jobs.set(job.id, job);
        this.activeUserJobs.set(normalizedUser, job.id);

        this._bindJobEvents(job);

        // Start background execution daemon (unawaited by HTTP endpoint)
        this._executeJob(job, req).catch((err) => {
            console.error(`[JobManager] Error executing job ${job.id}:`, err);
            if (!job.isTerminal()) {
                job.fail(err);
            }
        });

        return job;
    }

    /**
     * Binds job events to WebSocket bridge broadcast and lifecycle handlers.
     * @param {GenerationJob} job
     * @private
     */
    _bindJobEvents(job) {
        const userId = job.userId;

        // Streaming token chunks
        job.on('token', (chunk) => {
            if (this.wsBridge) {
                this.wsBridge.broadcastEvent(userId, 'generation:token', {
                    jobId: job.id,
                    seq: chunk.seq,
                    delta: chunk.delta,
                    accumulatedLength: job.fullText.length,
                    fullText: job.fullText,
                });
                this.wsBridge.broadcastEvent(userId, 'job:chunk', {
                    type: 'job:chunk',
                    jobId: job.id,
                    seq: chunk.seq,
                    delta: chunk.delta,
                    accumulatedLength: job.fullText.length,
                });
            }
            this.emit('token', { job, chunk });
        });

        // Successful completion
        job.on('completed', (data) => {
            this._releaseUserLock(userId, job.id);
            this._settleSession(job);

            if (this.wsBridge) {
                this.wsBridge.broadcastEvent(userId, 'generation:completed', {
                    jobId: job.id,
                    fullText: data.fullText,
                    tokenStats: data.tokenStats,
                });
                this.wsBridge.broadcastEvent(userId, 'job:completed', {
                    type: 'job:completed',
                    jobId: job.id,
                    fullText: data.fullText,
                    tokenStats: data.tokenStats,
                });
            }
            this.emit('completed', { job, ...data });
        });

        // Explicit user abort
        job.on('aborted', (data) => {
            this._releaseUserLock(userId, job.id);
            this._settleSession(job);

            if (this.wsBridge) {
                this.wsBridge.broadcastEvent(userId, 'generation:aborted', {
                    jobId: job.id,
                    fullText: data.fullText,
                    reason: data.reason,
                });
                this.wsBridge.broadcastEvent(userId, 'job:aborted', {
                    type: 'job:aborted',
                    jobId: job.id,
                    fullText: data.fullText,
                    reason: data.reason,
                });
            }
            this.emit('aborted', { job, ...data });
        });

        // Job failure
        job.on('failed', (data) => {
            this._releaseUserLock(userId, job.id);
            this._settleSession(job);

            if (this.wsBridge) {
                this.wsBridge.broadcastEvent(userId, 'generation:failed', {
                    jobId: job.id,
                    error: data.error,
                });
                this.wsBridge.broadcastEvent(userId, 'job:failed', {
                    type: 'job:failed',
                    jobId: job.id,
                    error: data.error,
                });
            }
            this.emit('failed', { job, ...data });
        });
    }

    /**
     * Executes the generation job lifecycle asynchronously in the background.
     * @param {GenerationJob} job
     * @param {object} [originalReq]
     * @private
     */
    async _executeJob(job, originalReq = {}) {
        // Step 1: PREPARING
        job.transition(JOB_STATUS.PREPARING);

        if (this.wsBridge) {
            this.wsBridge.broadcastEvent(job.userId, 'generation:started', {
                jobId: job.id,
                status: job.status,
                characterId: job.characterId,
                chatId: job.chatId,
            });
            this.wsBridge.broadcastEvent(job.userId, 'job:created', {
                type: 'job:created',
                jobId: job.id,
                state: job.status,
            });
        }

        // Mirror generation state in SessionEngine
        if (this.sessionEngine) {
            try {
                const session = this.sessionEngine.getSession(job.userId);
                session.generationState = 'generating';
                session.activeAbortController = job.abortController;
            } catch {
                // Ignore if session engine lookup fails
            }
        }

        // Step 2: INTERCEPTING_PLUGINS (Optional plugin handshake with 3000ms timeout guard)
        const pluginInterceptionEnabled = getGenerationConfig('core.generation.pluginInterceptionEnabled', false, 'boolean');
        if (pluginInterceptionEnabled && this.wsBridge && Array.isArray(job.requestBody?.messages)) {
            try {
                job.transition(JOB_STATUS.INTERCEPTING_PLUGINS);
                const timeoutMs = this.getPluginInterceptionTimeoutMs();

                const modifiedPrompt = await this.wsBridge.requestInterception(
                    job.userId,
                    'job:plugin_intercept',
                    {
                        jobId: job.id,
                        prompt: job.requestBody.messages,
                    },
                    timeoutMs,
                );

                if (Array.isArray(modifiedPrompt)) {
                    job.requestBody.messages = modifiedPrompt;
                }
            } catch (pluginErr) {
                console.warn(`[JobManager] Plugin interception failed for job ${job.id}, falling back:`, pluginErr);
            }
        }

        if (job.isTerminal()) {
            return;
        }

        // Step 3: STREAMING via mature chat-completions gateway
        job.transition(JOB_STATUS.STREAMING);

        const syntheticReq = createSyntheticRequest(job, originalReq);
        const syntheticRes = new SyntheticResponse(job);

        // Forward explicit cancellation signal to synthetic socket
        job.abortController.signal.addEventListener('abort', () => {
            try {
                syntheticReq.socket.emit('close');
                syntheticRes.socket.emit('close');
            } catch {
                // Ignore
            }
        }, { once: true });

        // Invoke mature chat-completions gateway
        const handler = this.generateHandler || (await getDefaultGenerateHandler());
        if (!handler) {
            throw new Error('Chat completions generator handler unavailable.');
        }
        await handler(syntheticReq, syntheticRes);
    }

    /**
     * Explicitly aborts an active job.
     * @param {string} jobId
     * @param {string} [reason='User aborted']
     * @returns {GenerationJob|null}
     */
    abortJob(jobId, reason = 'User aborted') {
        const job = this.getJob(jobId);
        if (!job) {
            return null;
        }

        if (!job.isTerminal()) {
            job.abort(reason);
        }

        this._releaseUserLock(job.userId, job.id);
        return job;
    }

    /**
     * Releases user concurrency lock if matching job.
     * @param {string} userId
     * @param {string} jobId
     * @private
     */
    _releaseUserLock(userId, jobId) {
        const normalizedUser = String(userId || 'default');
        if (this.activeUserJobs.get(normalizedUser) === jobId) {
            this.activeUserJobs.delete(normalizedUser);
        }
    }

    /**
     * Settles the generated message into SessionEngine.
     * Appends assistant message if non-empty text was generated.
     * @param {GenerationJob} job
     * @private
     */
    _settleSession(job) {
        if (!this.sessionEngine) {
            return;
        }

        try {
            const session = this.sessionEngine.getSession(job.userId);
            if (!session) {
                return;
            }

            if (job.fullText && job.fullText.trim().length > 0) {
                const characterName = job.characterName || session.activeCharacterName || 'Assistant';
                session.appendMessage({
                    name: characterName,
                    is_user: false,
                    is_system: false,
                    send_date: new Date().toISOString(),
                    mes: job.fullText,
                });
            }

            session.generationState = 'idle';
            session.activeAbortController = null;
        } catch (err) {
            console.error(`[JobManager] Failed to settle session for job ${job.id}:`, err);
        }
    }

    /**
     * Removes completed/aborted/failed jobs that exceed retention duration.
     */
    purgeStaleJobs() {
        const retentionMs = this.getJobRetentionSeconds() * 1000;
        const now = Date.now();

        for (const [id, job] of this.jobs.entries()) {
            if (job.isTerminal() && job.completedAt && (now - job.completedAt > retentionMs)) {
                this.jobs.delete(id);
                this._releaseUserLock(job.userId, id);
            }
        }
    }

    /**
     * Closes the JobManager and releases any interval timers.
     */
    close() {
        if (this._gcTimer) {
            clearInterval(this._gcTimer);
            this._gcTimer = null;
        }
        for (const job of this.jobs.values()) {
            if (!job.isTerminal()) {
                job.abort('JobManager shutting down');
            }
        }
        this.jobs.clear();
        this.activeUserJobs.clear();
    }
}

export const jobManager = new JobManager();
export default jobManager;
