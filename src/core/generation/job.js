import EventEmitter from 'node:events';
import crypto from 'node:crypto';

/**
 * Generation job lifecycle status constants.
 */
export const JOB_STATUS = Object.freeze({
    QUEUED: 'QUEUED',
    PREPARING: 'PREPARING',
    INTERCEPTING_PLUGINS: 'INTERCEPTING_PLUGINS',
    STREAMING: 'STREAMING',
    COMPLETED: 'COMPLETED',
    ABORTED: 'ABORTED',
    FAILED: 'FAILED',
});

/**
 * Terminal statuses that cannot be transitioned out of.
 */
export const TERMINAL_STATUSES = Object.freeze(new Set([
    JOB_STATUS.COMPLETED,
    JOB_STATUS.ABORTED,
    JOB_STATUS.FAILED,
]));

/**
 * Allowed strict state transitions.
 */
export const ALLOWED_TRANSITIONS = Object.freeze({
    [JOB_STATUS.QUEUED]: Object.freeze([
        JOB_STATUS.PREPARING,
        JOB_STATUS.ABORTED,
        JOB_STATUS.FAILED,
    ]),
    [JOB_STATUS.PREPARING]: Object.freeze([
        JOB_STATUS.INTERCEPTING_PLUGINS,
        JOB_STATUS.STREAMING,
        JOB_STATUS.ABORTED,
        JOB_STATUS.FAILED,
    ]),
    [JOB_STATUS.INTERCEPTING_PLUGINS]: Object.freeze([
        JOB_STATUS.STREAMING,
        JOB_STATUS.ABORTED,
        JOB_STATUS.FAILED,
    ]),
    [JOB_STATUS.STREAMING]: Object.freeze([
        JOB_STATUS.COMPLETED,
        JOB_STATUS.ABORTED,
        JOB_STATUS.FAILED,
    ]),
    [JOB_STATUS.COMPLETED]: Object.freeze([]),
    [JOB_STATUS.ABORTED]: Object.freeze([]),
    [JOB_STATUS.FAILED]: Object.freeze([]),
});

/**
 * Generation Job managing the full lifecycle of a single text generation request.
 */
export class GenerationJob extends EventEmitter {
    /**
     * @param {object} options
     * @param {string} [options.id]
     * @param {string} [options.userId='default']
     * @param {string|null} [options.chatId=null]
     * @param {string|null} [options.characterId=null]
     * @param {string|null} [options.characterName=null]
     * @param {object} [options.requestBody={}]
     * @param {number} [options.capacity=2048]
     */
    constructor({
        id,
        userId = 'default',
        chatId = null,
        characterId = null,
        characterName = null,
        requestBody = {},
        capacity = 2048,
    } = {}) {
        super();

        this.id = id || `job_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
        this.userId = String(userId || 'default');
        this.chatId = chatId || null;
        this.characterId = characterId || null;
        this.characterName = characterName || null;
        this.requestBody = requestBody || {};

        /** @type {string} */
        this.status = JOB_STATUS.QUEUED;

        /** @type {number} */
        this.createdAt = Date.now();
        /** @type {number} */
        this.updatedAt = this.createdAt;
        /** @type {number|null} */
        this.completedAt = null;

        /** @type {AbortController} */
        this.abortController = new AbortController();
        /** @type {string|null} */
        this.abortReason = null;
        /** @type {string|null} */
        this.error = null;

        /** @type {string} Full accumulated generated text */
        this.fullText = '';

        /** @type {{ promptTokens: number, completionTokens: number }} */
        this.tokenStats = {
            promptTokens: 0,
            completionTokens: 0,
        };

        /** @type {number} Monotonically increasing sequence number */
        this.lastSeq = 0;

        /** @type {number} Ring buffer maximum capacity */
        this.capacity = Number.isInteger(capacity) && capacity > 0 ? capacity : 2048;

        /** @type {Array<{ seq: number, delta: string, timestamp: number }>} */
        this.ringBuffer = [];
    }

    /**
     * Checks if job is in a terminal state.
     * @returns {boolean}
     */
    isTerminal() {
        return TERMINAL_STATUSES.has(this.status);
    }

    /**
     * Transition the job to a new status.
     * Throws an Error if transition is not permitted.
     * @param {string} nextStatus
     * @returns {this}
     */
    transition(nextStatus) {
        if (this.status === nextStatus) {
            return this;
        }

        const allowed = ALLOWED_TRANSITIONS[this.status] || [];
        if (!allowed.includes(nextStatus)) {
            const err = new Error(`Illegal state transition from ${this.status} to ${nextStatus}`);
            err.name = 'IllegalStateTransitionError';
            throw err;
        }

        const prevStatus = this.status;
        this.status = nextStatus;
        this.updatedAt = Date.now();

        this.emit('stateChange', {
            jobId: this.id,
            from: prevStatus,
            to: nextStatus,
            job: this,
        });

        return this;
    }

    /**
     * Appends a streaming token chunk to the ring buffer and accumulated text.
     * @param {string} delta
     * @returns {{ seq: number, delta: string, timestamp: number } | null}
     */
    appendChunk(delta) {
        if (this.isTerminal()) {
            return null;
        }
        if (typeof delta !== 'string' || delta.length === 0) {
            return null;
        }

        const seq = ++this.lastSeq;
        const entry = {
            seq,
            delta,
            timestamp: Date.now(),
        };

        this.ringBuffer.push(entry);
        if (this.ringBuffer.length > this.capacity) {
            this.ringBuffer.shift();
        }

        this.fullText += delta;
        this.updatedAt = entry.timestamp;

        this.emit('token', entry);
        return entry;
    }

    /**
     * Retrieves missed chunks for catch-up stream replay.
     * @param {number|string} [lastSeq=0]
     * @returns {{ chunks: Array<{ seq: number, delta: string, timestamp: number }>, fromSeq: number, toSeq: number, minSeq: number, maxSeq: number, hasMissedChunks: boolean }}
     */
    getCatchupChunks(lastSeq = 0) {
        const parsedLastSeq = Math.max(0, parseInt(String(lastSeq), 10) || 0);
        const chunks = this.ringBuffer.filter((chunk) => chunk.seq > parsedLastSeq);
        const minSeq = this.ringBuffer.length > 0 ? this.ringBuffer[0].seq : 0;
        const maxSeq = this.ringBuffer.length > 0 ? this.ringBuffer[this.ringBuffer.length - 1].seq : 0;

        return {
            chunks,
            fromSeq: parsedLastSeq + 1,
            toSeq: maxSeq,
            minSeq,
            maxSeq,
            hasMissedChunks: parsedLastSeq > 0 && minSeq > 0 && parsedLastSeq < minSeq - 1,
        };
    }

    /**
     * Marks the job as successfully completed.
     * @param {Partial<{ promptTokens: number, completionTokens: number }>} [tokenStats]
     * @returns {this}
     */
    complete(tokenStats = null) {
        if (this.isTerminal()) {
            return this;
        }

        if (tokenStats && typeof tokenStats === 'object') {
            this.tokenStats = {
                promptTokens: Number(tokenStats.promptTokens) || this.tokenStats.promptTokens,
                completionTokens: Number(tokenStats.completionTokens) || this.tokenStats.completionTokens,
            };
        }

        this.completedAt = Date.now();
        this.transition(JOB_STATUS.COMPLETED);

        this.emit('completed', {
            jobId: this.id,
            fullText: this.fullText,
            tokenStats: this.tokenStats,
        });

        return this;
    }

    /**
     * Explicitly aborts the job.
     * @param {string} [reason='User aborted']
     * @returns {this}
     */
    abort(reason = 'User aborted') {
        if (this.isTerminal()) {
            return this;
        }

        this.abortReason = reason || 'User aborted';
        this.completedAt = Date.now();

        try {
            this.abortController.abort(this.abortReason);
        } catch {
            // Ignore if abortController already triggered
        }

        this.transition(JOB_STATUS.ABORTED);

        this.emit('aborted', {
            jobId: this.id,
            reason: this.abortReason,
            fullText: this.fullText,
        });

        return this;
    }

    /**
     * Marks the job as failed due to an error.
     * @param {Error|string} err
     * @returns {this}
     */
    fail(err) {
        if (this.isTerminal()) {
            return this;
        }

        this.error = err instanceof Error ? err.message : String(err || 'Unknown error');
        this.completedAt = Date.now();

        this.transition(JOB_STATUS.FAILED);

        this.emit('failed', {
            jobId: this.id,
            error: this.error,
            fullText: this.fullText,
        });

        return this;
    }

    /**
     * Serializes job state for API responses.
     */
    toJSON() {
        return {
            id: this.id,
            userId: this.userId,
            chatId: this.chatId,
            characterId: this.characterId,
            characterName: this.characterName,
            status: this.status,
            createdAt: this.createdAt,
            updatedAt: this.updatedAt,
            completedAt: this.completedAt,
            lastSeq: this.lastSeq,
            fullText: this.fullText,
            fullTextLength: this.fullText.length,
            tokenStats: this.tokenStats,
            error: this.error,
            abortReason: this.abortReason,
        };
    }
}

export default GenerationJob;
