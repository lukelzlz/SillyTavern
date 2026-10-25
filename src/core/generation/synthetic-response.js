import { Writable } from 'node:stream';
import EventEmitter from 'node:events';

/**
 * Extracts incremental text delta from a parsed provider SSE JSON chunk.
 * @param {any} data
 * @returns {string}
 */
export function extractDelta(data) {
    if (!data || typeof data !== 'object') {
        return '';
    }

    // 1. Claude delta
    if (typeof data.delta?.text === 'string') {
        return data.delta.text;
    }
    if (typeof data.content_block?.text === 'string') {
        return data.content_block.text;
    }

    // 2. OpenAI / DeepSeek / Mistral / OpenRouter / xAI choices
    if (Array.isArray(data.choices) && data.choices.length > 0) {
        const choice = data.choices[0];
        if (typeof choice?.delta?.content === 'string') {
            return choice.delta.content;
        }
        if (typeof choice?.text === 'string') {
            return choice.text;
        }
        if (typeof choice?.message?.content === 'string') {
            return choice.message.content;
        }
    }

    // 3. Google Vertex / MakerSuite candidates
    if (Array.isArray(data.candidates) && data.candidates.length > 0) {
        const candidate = data.candidates[0];
        const parts = candidate?.content?.parts;
        if (Array.isArray(parts)) {
            const textParts = parts
                .filter((p) => !p?.thought && typeof p?.text === 'string')
                .map((p) => p.text);
            if (textParts.length > 0) {
                return textParts.join('');
            }
        }
    }

    // 4. Cohere message content
    if (typeof data.delta?.message?.content?.text === 'string') {
        return data.delta.message.content.text;
    }
    if (typeof data.delta?.message?.tool_plan === 'string') {
        return data.delta.message.tool_plan;
    }

    // 5. Generic root text
    if (typeof data.text === 'string') {
        return data.text;
    }

    return '';
}

/**
 * Extracts provider reasoning/thinking text without mixing it into visible
 * assistant content.
 * @param {any} data
 * @returns {string}
 */
export function extractReasoningDelta(data) {
    if (!data || typeof data !== 'object') {
        return '';
    }
    if (typeof data.reasoning_content === 'string') return data.reasoning_content;
    if (typeof data.reasoning === 'string') return data.reasoning;
    if (typeof data.delta?.reasoning_content === 'string') return data.delta.reasoning_content;
    if (typeof data.delta?.reasoning === 'string') return data.delta.reasoning;
    if (typeof data.delta?.thinking === 'string') return data.delta.thinking;
    if (typeof data.choices?.[0]?.delta?.reasoning_content === 'string') return data.choices[0].delta.reasoning_content;
    if (typeof data.choices?.[0]?.delta?.reasoning === 'string') return data.choices[0].delta.reasoning;
    if (typeof data.choices?.[0]?.delta?.thinking === 'string') return data.choices[0].delta.thinking;
    if (Array.isArray(data.candidates)) {
        return data.candidates[0]?.content?.parts
            ?.filter((part) => part?.thought === true && typeof part?.text === 'string')
            .map((part) => part.text)
            .join('') || '';
    }
    return '';
}

/**
 * Extracts tool-call deltas from OpenAI-compatible provider chunks.
 * @param {any} data
 * @returns {object[]}
 */
export function extractToolCallDeltas(data) {
    const toolCalls = data?.choices?.[0]?.delta?.tool_calls;
    return Array.isArray(toolCalls) ? toolCalls.filter((call) => call && typeof call === 'object') : [];
}

/**
 * Extracts a provider finish reason when present.
 * @param {any} data
 * @returns {string|null}
 */
export function extractFinishReason(data) {
    const reason = data?.choices?.[0]?.finish_reason ?? data?.finish_reason;
    return typeof reason === 'string' ? reason : null;
}

/**
 * Extracts complete text from non-streaming response body.
 * @param {any} body
 * @returns {string}
 */
export function extractFullTextFromBody(body) {
    if (!body) return '';
    if (typeof body === 'string') return body;

    if (Array.isArray(body.choices) && body.choices.length > 0) {
        const choice = body.choices[0];
        if (typeof choice?.message?.content === 'string') {
            return choice.message.content;
        }
        if (typeof choice?.text === 'string') {
            return choice.text;
        }
    }

    if (Array.isArray(body.content) && body.content.length > 0) {
        const block = body.content.find((b) => b?.type === 'text' && typeof b?.text === 'string');
        if (block) return block.text;
    }

    if (Array.isArray(body.candidates) && body.candidates.length > 0) {
        const parts = body.candidates[0]?.content?.parts;
        if (Array.isArray(parts)) {
            return parts.filter((p) => typeof p?.text === 'string').map((p) => p.text).join('');
        }
    }

    return '';
}

/**
 * Synthetic Express Response implementation for server-side generation background jobs.
 * Piped from mature chat-completions gateway, survives client network disconnection,
 * and intercepts SSE/text stream tokens without triggering premature abort.
 */
export class SyntheticResponse extends Writable {
    /**
     * @param {import('./job.js').GenerationJob} job
     * @param {object} [options]
     */
    constructor(job, options = {}) {
        super(options);

        this.job = job;
        this.statusCode = 200;
        this.statusMessage = 'OK';
        /** @type {Map<string, any>} */
        this.headers = new Map();
        this.headersSent = false;

        /** @type {EventEmitter} Synthetic socket decoupled from client network */
        this.socket = new EventEmitter();

        /** @type {string} Incomplete SSE line buffer */
        this._sseBuffer = '';

        /** @type {string} Captured raw text for error diagnosis */
        this._rawErrorBuffer = '';

        this._setupAbortBridge();
    }

    _setupAbortBridge() {
        if (!this.job || !this.job.abortController) {
            return;
        }

        const onAbort = () => {
            try {
                this.socket.emit('close');
            } catch {
                // Ignore
            }
        };

        if (this.job.abortController.signal.aborted) {
            onAbort();
        } else {
            this.job.abortController.signal.addEventListener('abort', onAbort, { once: true });
        }
    }

    /**
     * Express compatibility: Set status code.
     * @param {number} code
     * @returns {this}
     */
    status(code) {
        this.statusCode = Number(code) || 200;
        return this;
    }

    /**
     * Express compatibility: Send status code and finish.
     * @param {number} code
     * @returns {this}
     */
    sendStatus(code) {
        this.statusCode = Number(code) || 200;
        this.end();
        return this;
    }

    /**
     * Express compatibility: Set HTTP response header.
     * @param {string} name
     * @param {any} value
     * @returns {this}
     */
    setHeader(name, value) {
        this.headers.set(String(name).toLowerCase(), value);
        return this;
    }

    set(name, value) {
        return this.setHeader(name, value);
    }

    header(name, value) {
        return this.setHeader(name, value);
    }

    /**
     * Express compatibility: Get HTTP response header.
     * @param {string} name
     * @returns {any}
     */
    getHeader(name) {
        return this.headers.get(String(name).toLowerCase());
    }

    /**
     * Express compatibility: Check if HTTP response header is set.
     * @param {string} name
     * @returns {boolean}
     */
    hasHeader(name) {
        return this.headers.has(String(name).toLowerCase());
    }

    /**
     * Express compatibility: Remove HTTP response header.
     * @param {string} name
     * @returns {this}
     */
    removeHeader(name) {
        this.headers.delete(String(name).toLowerCase());
        return this;
    }

    /**
     * Express compatibility: Non-streaming or direct JSON response handler.
     * @param {any} body
     * @returns {this}
     */
    send(body) {
        this.headersSent = true;

        if (this.job.isTerminal()) {
            return this;
        }

        const isErrorStatus = this.statusCode >= 400;
        const hasErrorProperty = body && typeof body === 'object' && (body.error || body.quota_error);

        if (isErrorStatus || hasErrorProperty) {
            const errMsg = typeof body?.error === 'string'
                ? body.error
                : body?.error?.message || `Gateway returned HTTP ${this.statusCode}`;
            this.job.fail(new Error(errMsg));
            this.emit('finish');
            return this;
        }

        // Success non-streaming completion
        this._captureProviderMetadata(body);
        const text = extractFullTextFromBody(body);
        if (text) {
            this.job.appendChunk(text);
        }

        this.job.complete();
        this.emit('finish');
        return this;
    }

    /**
     * Express compatibility: JSON response handler.
     * @param {any} body
     * @returns {this}
     */
    json(body) {
        return this.send(body);
    }

    /**
     * Stream Writable implementation. Captures SSE chunks from forwardFetchResponse.
     * @param {any} chunk
     * @param {BufferEncoding} encoding
     * @param {(error?: Error | null) => void} callback
     */
    _write(chunk, encoding, callback) {
        this.headersSent = true;

        if (this.job.isTerminal()) {
            callback();
            return;
        }

        const text = Buffer.isBuffer(chunk) ? chunk.toString('utf-8') : String(chunk);

        if (this.statusCode >= 400) {
            this._rawErrorBuffer += text;
            callback();
            return;
        }

        this._sseBuffer += text;
        const lines = this._sseBuffer.split(/\r?\n/);
        // Retain last incomplete line in buffer
        this._sseBuffer = lines.pop() || '';

        for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed || trimmed.startsWith(':')) {
                continue;
            }

            if (trimmed.startsWith('data:')) {
                const dataPayload = trimmed.slice(5).trim();
                if (dataPayload === '[DONE]') {
                    continue;
                }

                try {
                    const parsed = JSON.parse(dataPayload);
                    this._captureProviderMetadata(parsed);
                    const delta = extractDelta(parsed);
                    if (delta) {
                        this.job.appendChunk(delta);
                    }
                } catch {
                    // Non-JSON SSE payload: treat as raw delta if non-empty
                    if (dataPayload) {
                        this.job.appendChunk(dataPayload);
                    }
                }
            }
        }

        callback();
    }

    /**
     * Stream Writable finalize hook. Flushes remaining buffer and marks job completion.
     * @param {(error?: Error | null) => void} callback
     */
    _final(callback) {
        if (this.job.isTerminal()) {
            callback();
            return;
        }

        // Check if any error was buffered
        if (this.statusCode >= 400) {
            let errorMsg = `Gateway streaming failed with HTTP ${this.statusCode}`;
            if (this._rawErrorBuffer) {
                try {
                    const parsed = JSON.parse(this._rawErrorBuffer);
                    errorMsg = parsed?.error?.message || parsed?.error || errorMsg;
                } catch {
                    errorMsg = `${errorMsg}: ${this._rawErrorBuffer.slice(0, 200)}`;
                }
            }
            this.job.fail(new Error(errorMsg));
            callback();
            return;
        }

        // Flush any remaining line in SSE buffer
        if (this._sseBuffer.trim().startsWith('data:')) {
            const dataPayload = this._sseBuffer.trim().slice(5).trim();
            if (dataPayload && dataPayload !== '[DONE]') {
                try {
                    const parsed = JSON.parse(dataPayload);
                    this._captureProviderMetadata(parsed);
                    const delta = extractDelta(parsed);
                    if (delta) {
                        this.job.appendChunk(delta);
                    }
                } catch {
                    this.job.appendChunk(dataPayload);
                }
            }
        }

        if (!this.job.isTerminal()) {
            this.job.complete();
        }

        callback();
    }

    /**
     * Captures provider metadata shared by streaming and non-streaming paths.
     * @param {any} parsed
     * @private
     */
    _captureProviderMetadata(parsed) {
        if (!parsed || typeof parsed !== 'object') {
            return;
        }
        if (parsed.usage) {
            this.job.recordUsage(parsed.usage);
        }

        const reasoning = extractReasoningDelta(parsed);
        if (reasoning) {
            this.job.appendReasoning(reasoning);
        }

        for (const toolCall of extractToolCallDeltas(parsed)) {
            this.job.appendToolCall(toolCall);
        }

        const finishReason = extractFinishReason(parsed);
        if (finishReason) {
            this.job.finishReason = finishReason;
        }
    }
}

/**
 * Creates a synthetic Express request object for backend gateway invocation.
 * @param {import('./job.js').GenerationJob} job
 * @param {object} [originalReq={}]
 * @returns {object}
 */
export function createSyntheticRequest(job, originalReq = {}) {
    const socket = new EventEmitter();

    if (job.abortController) {
        job.abortController.signal.addEventListener('abort', () => {
            try {
                socket.emit('close');
            } catch {
                // Ignore
            }
        }, { once: true });
    }

    const headers = { ...(originalReq?.headers || {}) };
    const userProfile = originalReq?.user?.profile || {
        handle: job.userId || 'default',
        enabled: true,
    };
    const userDirectories = originalReq?.user?.directories || {};

    const body = { ...job.requestBody };
    // These fields are orchestration metadata, not provider request
    // parameters. Keep them available on GenerationJob for settlement and
    // diagnostics, but never leak them into the mature gateway.
    delete body.core_generation_job_id;
    delete body.core_request_id;
    delete body.core_prompt_mode;
    delete body.chatId;
    delete body.characterId;
    delete body.characterName;
    delete body.core_state_version;
    delete body.core_prompt_ready_handled;
    delete body.core_prompt_context;
    delete body.core_prompt_metadata;

    return {
        body,
        user: {
            profile: userProfile,
            directories: userDirectories,
        },
        socket,
        headers,
        session: originalReq?.session || {},
        query: originalReq?.query || {},
        get(name) {
            return this.headers[String(name).toLowerCase()];
        },
    };
}

export default SyntheticResponse;
