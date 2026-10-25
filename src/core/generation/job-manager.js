import EventEmitter from 'node:events';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { GenerationJob, JOB_STATUS } from './job.js';
import { SyntheticResponse, createSyntheticRequest } from './synthetic-response.js';
import defaultSessionEngine from '../session-engine.js';
import defaultWsBridge from '../ws-bridge.js';
import { PromptAssembler } from '../prompt/prompt-assembler.js';
import { validateCorePromptContext } from '../prompt/context-schema.js';
import { createPromptTokenizer, DualTrackTokenizer } from '../prompt/tokenizer-adapter.js';
import { getConfigFilePath, getConfigValue, setConfigFilePath } from '../../util.js';

let defaultGenerateHandlerPromise = null;

function invalidGenerationRequest(message) {
    const error = new Error(message);
    error.name = 'InvalidGenerationRequestError';
    Object.assign(error, { status: 400, statusCode: 400 });
    return error;
}

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
                    if (!getConfigFilePath()) {
                        setConfigFilePath(defaultConfigPath);
                    }
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
        /** @type {Map<string, string>} User/request idempotency key -> Job ID */
        this.requestJobs = new Map();

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
     * Whether jobs carrying an explicit canonical prompt context should be
     * assembled by the server before plugin interception and gateway dispatch.
     * @returns {boolean}
     */
    isServerPromptAssemblyEnabled() {
        return getGenerationConfig('core.generation.serverPromptAssemblyEnabled', true, 'boolean');
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
     * Returns the explicit prompt ownership mode for a request. Legacy jobs
     * without a mode retain their previous behavior.
     * @param {object} body
     * @returns {'client_final'|'server_context'|'legacy'}
     */
    getPromptMode(body = {}) {
        if (body?.core_prompt_mode === 'client_final' || body?.core_prompt_mode === 'server_context') {
            return body.core_prompt_mode;
        }
        if (body?.core_prompt_context && typeof body.core_prompt_context === 'object' && !Array.isArray(body.core_prompt_context)) {
            return 'server_context';
        }
        return 'legacy';
    }

    /**
     * Validates the mutually exclusive prompt ownership contract.
     * @param {object} body
     * @private
     */
    validateGenerationBody(body = {}) {
        const explicitMode = body?.core_prompt_mode;
        if (explicitMode !== undefined && !['client_final', 'server_context'].includes(explicitMode)) {
            throw invalidGenerationRequest(`Unsupported core prompt mode: ${String(explicitMode)}`);
        }

        const mode = this.getPromptMode(body);
        const hasContext = Boolean(body?.core_prompt_context && typeof body.core_prompt_context === 'object' && !Array.isArray(body.core_prompt_context));
        const hasMessages = Array.isArray(body?.messages);

        if (mode === 'server_context' && !hasContext) {
            throw invalidGenerationRequest('server_context prompt mode requires core_prompt_context.');
        }

        if (mode === 'server_context') {
            if (!this.isServerPromptAssemblyEnabled()) {
                throw invalidGenerationRequest('server_context prompt mode is unavailable while server prompt assembly is disabled.');
            }
            const validation = validateCorePromptContext(body.core_prompt_context);
            if (!validation.valid) {
                throw invalidGenerationRequest(`Invalid core_prompt_context: ${validation.issues.join('; ')}`);
            }
        }

        if (mode === 'client_final' && hasContext) {
            throw invalidGenerationRequest('client_final prompt mode cannot include core_prompt_context.');
        }

        if (mode === 'client_final' && !hasMessages) {
            throw invalidGenerationRequest('client_final prompt mode requires messages.');
        }
    }

    /**
     * Builds a stable per-user request idempotency key.
     * @param {string} userId
     * @param {object} body
     * @returns {string|null}
     * @private
     */
    getRequestKey(userId, body = {}) {
        if (typeof body?.core_request_id !== 'string' || body.core_request_id.trim().length === 0) {
            return null;
        }
        return `${String(userId || 'default')}:${body.core_request_id}`;
    }

    /**
     * Creates and starts a new generation job in the background.
     * Enforces fail-closed concurrency lock: single active job per user.
     * @param {object} options
     * @param {string} [options.userId='default']
     * @param {object} [options.body={}]
     * @param {object} [options.req=null]
     * @param {boolean} [options.deferStart=false]
     * @returns {Promise<GenerationJob>}
     */
    async createJob({ userId = 'default', body = {}, req = null, deferStart = false } = {}) {
        const normalizedUser = String(userId || 'default');
        const requestBody = body && typeof body === 'object' && !Array.isArray(body) ? body : {};
        this.validateGenerationBody(requestBody);

        const requestKey = this.getRequestKey(normalizedUser, requestBody);
        if (requestKey) {
            const existingJobId = this.requestJobs.get(requestKey);
            const existingJob = existingJobId ? this.jobs.get(existingJobId) : null;
            if (existingJob) {
                return existingJob;
            }
            this.requestJobs.delete(requestKey);
        }

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
            chatId: requestBody?.chatId || null,
            characterId: requestBody?.characterId || null,
            characterName: requestBody?.characterName || null,
            requestBody,
            capacity,
        });

        this.jobs.set(job.id, job);
        if (requestKey) {
            this.requestJobs.set(requestKey, job.id);
        }
        this.activeUserJobs.set(normalizedUser, job.id);

        this._bindJobEvents(job);

        if (!deferStart) {
            this.startJob(job, req);
        }

        return job;
    }

    /**
     * Starts a previously created job. WS callers can defer this until after
     * the creation response has been written, avoiding a fast-provider race.
     * @param {GenerationJob} job
     * @param {object} [req]
     * @returns {boolean}
     */
    startJob(job, req = null) {
        if (!job || job.executionStarted) {
            return false;
        }

        job.executionStarted = true;
        this._executeJob(job, req).catch((err) => {
            console.error(`[JobManager] Error executing job ${job.id}:`, err);
            if (!job.isTerminal()) {
                job.fail(err);
            }
        });
        return true;
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

        job.on('reasoning', (data) => {
            if (this.wsBridge) {
                this.wsBridge.broadcastEvent(userId, 'generation:reasoning', data);
            }
            this.emit('reasoning', { job, ...data });
        });

        job.on('toolCall', (data) => {
            if (this.wsBridge) {
                this.wsBridge.broadcastEvent(userId, 'generation:tool_call', data);
            }
            this.emit('toolCall', { job, ...data });
        });

        job.on('usage', (data) => {
            if (this.wsBridge) {
                this.wsBridge.broadcastEvent(userId, 'generation:usage', data);
            }
            this.emit('usage', { job, ...data });
        });

        // Successful completion
        job.on('completed', (data) => {
            this._releaseUserLock(userId, job.id);
            this._settleSession(job);

            if (this.wsBridge) {
                this.wsBridge.broadcastEvent(userId, 'generation:completed', {
                    jobId: job.id,
                    fullText: data.fullText,
                    lastSeq: job.lastSeq,
                    tokenStats: data.tokenStats,
                    reasoningText: data.reasoningText,
                    toolCallDeltas: data.toolCallDeltas,
                    finishReason: data.finishReason,
                });
                this.wsBridge.broadcastEvent(userId, 'job:completed', {
                    type: 'job:completed',
                    jobId: job.id,
                    fullText: data.fullText,
                    lastSeq: job.lastSeq,
                    tokenStats: data.tokenStats,
                    reasoningText: data.reasoningText,
                    toolCallDeltas: data.toolCallDeltas,
                    finishReason: data.finishReason,
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
            this._rollbackSession(job);

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
                if (typeof session.setGenerationState === 'function') {
                    session.setGenerationState('generating', job.abortController);
                } else {
                    session.generationState = 'generating';
                    session.activeAbortController = job.abortController;
                }
            } catch {
                // Ignore if session engine lookup fails
            }
        }

        await this._preparePrompt(job);

        // Step 2: INTERCEPTING_PLUGINS (Optional plugin handshake with 3000ms timeout guard)
        const pluginInterceptionEnabled = getGenerationConfig('core.generation.pluginInterceptionEnabled', false, 'boolean');
        const promptMode = this.getPromptMode(job.requestBody);
        if (pluginInterceptionEnabled
            && promptMode !== 'client_final'
            && !job.requestBody?.core_prompt_ready_handled
            && job.requestBody?.core_prompt_interception !== false
            && this.wsBridge
            && Array.isArray(job.requestBody?.messages)) {
            try {
                job.transition(JOB_STATUS.INTERCEPTING_PLUGINS);
                const timeoutMs = this.getPluginInterceptionTimeoutMs();

                const modifiedPrompt = await this.wsBridge.requestInterception(
                    job.userId,
                    'chat_completion_prompt_ready',
                    {
                        jobId: job.id,
                        chat: job.requestBody.messages,
                        dryRun: false,
                    },
                    timeoutMs,
                    {
                        targetWs: originalReq?.coreBridgeSocket || null,
                        jobId: job.id,
                        coreRequestId: typeof job.requestBody?.core_request_id === 'string'
                            ? job.requestBody.core_request_id
                            : null,
                    },
                );

                if (Array.isArray(modifiedPrompt)) {
                    job.requestBody.messages = modifiedPrompt;
                } else if (Array.isArray(modifiedPrompt?.chat)) {
                    job.requestBody.messages = modifiedPrompt.chat;
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
     * Optionally assembles a canonical server-owned prompt. Jobs without an
     * explicit context retain the existing client-prepared request path so
     * legacy HTTP callers remain compatible during the migration.
     * @param {GenerationJob} job
     * @returns {Promise<void>}
     * @private
     */
    async _preparePrompt(job) {
        if (!this.isServerPromptAssemblyEnabled()) {
            return;
        }

        if (job.requestBody?.core_prompt_ready_handled || this.getPromptMode(job.requestBody) === 'client_final') {
            // The browser already owns the prompt-ready lifecycle for this
            // request. Do not rebuild its final prompt underneath an already
            // executed client plugin hook.
            return;
        }

        const context = job.requestBody?.core_prompt_context;
        if (!context || typeof context !== 'object' || Array.isArray(context)) {
            return;
        }

        const productionTokenizer = createPromptTokenizer({
            source: context.settings?.source,
            model: context.settings?.model,
        });
        const assembled = await PromptAssembler.assemble(context, productionTokenizer
            ? { tokenizer: new DualTrackTokenizer({ tokenizer: productionTokenizer }) }
            : {});
        if (!Array.isArray(assembled?.chat)) {
            throw new Error('Server prompt assembly did not return a chat message array.');
        }

        job.requestBody.messages = assembled.chat;
        job.requestBody.core_prompt_metadata = assembled.metadata || null;
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

            if (job.chatId && String(session.activeChatId || '') !== String(job.chatId)) {
                console.warn(`[JobManager] Skipping settlement for job ${job.id}: active chat changed from ${job.chatId} to ${session.activeChatId || '(none)'}`);
                if (typeof session.setGenerationState === 'function') {
                    session.setGenerationState('idle', null);
                } else {
                    session.generationState = 'idle';
                    session.activeAbortController = null;
                }
                return;
            }

            if (job.fullText && job.fullText.trim().length > 0) {
                const characterName = job.characterName || session.activeCharacterName || 'Assistant';
                const generationMarker = typeof job.requestBody?.core_generation_job_id === 'string'
                    ? job.requestBody.core_generation_job_id
                    : null;
                const message = {
                    name: characterName,
                    is_user: false,
                    is_system: false,
                    send_date: new Date().toISOString(),
                    mes: job.fullText,
                    ...(generationMarker ? { extra: { core_generation_job_id: generationMarker } } : {}),
                };

                const existingIndex = generationMarker
                    ? session.chat.findLastIndex((item) => item?.extra?.core_generation_job_id === generationMarker)
                    : -1;

                if (existingIndex >= 0) {
                    session.updateMessage(existingIndex, message);
                } else {
                    session.appendMessage(message);
                }
            }

            if (typeof session.setGenerationState === 'function') {
                session.setGenerationState('idle', null);
            } else {
                session.generationState = 'idle';
                session.activeAbortController = null;
            }
        } catch (err) {
            console.error(`[JobManager] Failed to settle session for job ${job.id}:`, err);
        }
    }

    /**
     * Rolls back a failed generation without persisting partial assistant
     * text. A client-created placeholder is removed when it carries the
     * generation marker; successful and explicitly aborted jobs use the
     * normal settlement path above.
     * @param {GenerationJob} job
     * @private
     */
    _rollbackSession(job) {
        if (!this.sessionEngine) {
            return;
        }

        try {
            const session = this.sessionEngine.getSession(job.userId);
            const chatMatches = !job.chatId || String(session.activeChatId || '') === String(job.chatId);
            const generationMarker = typeof job.requestBody?.core_generation_job_id === 'string'
                ? job.requestBody.core_generation_job_id
                : null;
            if (generationMarker && chatMatches) {
                const existingIndex = session.chat.findLastIndex((item) => item?.extra?.core_generation_job_id === generationMarker);
                if (existingIndex >= 0) {
                    session.deleteMessage(existingIndex);
                }
            }

            if (typeof session.setGenerationState === 'function') {
                session.setGenerationState('idle', null);
            } else {
                session.generationState = 'idle';
                session.activeAbortController = null;
            }
        } catch (err) {
            console.error(`[JobManager] Failed to rollback session for job ${job.id}:`, err);
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
                const requestKey = this.getRequestKey(job.userId, job.requestBody);
                if (requestKey && this.requestJobs.get(requestKey) === id) {
                    this.requestJobs.delete(requestKey);
                }
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
        this.requestJobs.clear();
        this.activeUserJobs.clear();
    }
}

export const jobManager = new JobManager();
export default jobManager;
