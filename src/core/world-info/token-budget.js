/**
 * TokenizerUnavailableError
 * Thrown when neither an exact recorded token count nor a valid real tokenizer adapter is provided.
 * In accordance with ADR-003, heuristic character-count estimation is strictly forbidden.
 */
export class TokenizerUnavailableError extends Error {
    /**
     * @param {string} [message]
     */
    constructor(message = 'Fail-Closed: No real tokenizer adapter or recorded token count available for the given text. Rule-based or character-length estimations are strictly prohibited.') {
        super(message);
        this.name = 'TokenizerUnavailableError';
    }
}

/**
 * Base abstract interface for token budget estimation.
 */
export class ITokenBudgetEstimator {
    /**
     * Count tokens for a given string.
     * @param {string} text
     * @returns {Promise<number>}
     */
    async countTokens(text) {
        throw new TokenizerUnavailableError();
    }

    /**
     * Check if candidate addition overflows the budget limit.
     * @param {string} currentAccumulatedText
     * @param {string} candidateAddition
     * @param {number} budgetLimit 0 or negative means unlimited
     * @returns {Promise<{ overflow: boolean, projectedTokens: number }>}
     */
    async checkOverflow(currentAccumulatedText, candidateAddition, budgetLimit) {
        if (!budgetLimit || budgetLimit <= 0) {
            const projectedTokens = await this.countTokens(candidateAddition);
            return { overflow: false, projectedTokens };
        }

        const combinedText = `${currentAccumulatedText}${candidateAddition}\n`;
        const projectedTokens = await this.countTokens(combinedText);
        return {
            overflow: projectedTokens >= budgetLimit,
            projectedTokens,
        };
    }
}

/**
 * Fail-Closed Token Estimator
 * Default implementation when no tokenizer or recorded counts are available.
 */
export class FailClosedTokenEstimator extends ITokenBudgetEstimator {
    /**
     * @override
     */
    async countTokens(text) {
        throw new TokenizerUnavailableError();
    }
}

/**
 * Recorded Token Estimator
 * Uses a deterministic map of recorded token counts for offline differential testing.
 * Strict Fail-Closed: throws TokenizerUnavailableError if a text segment is not in the recording map.
 */
export class RecordedTokenEstimator extends ITokenBudgetEstimator {
    /**
     * @param {Record<string, number> | Map<string, number>} recordedMap
     * @param {(text: string) => Promise<number> | number} [fallbackTokenizer]
     */
    constructor(recordedMap = {}, fallbackTokenizer = null) {
        super();
        this.recordedMap = recordedMap instanceof Map ? recordedMap : new Map(Object.entries(recordedMap));
        this.fallbackTokenizer = fallbackTokenizer;
    }

    /**
     * @param {string} text
     * @returns {Promise<number>}
     */
    async countTokens(text) {
        if (text === '') return 0;

        if (this.recordedMap.has(text)) {
            return this.recordedMap.get(text);
        }

        // Check normalized key (trimmed or with normalized newlines)
        const normalized = text.replace(/\r\n/g, '\n');
        if (this.recordedMap.has(normalized)) {
            return this.recordedMap.get(normalized);
        }

        if (typeof this.fallbackTokenizer === 'function') {
            return await this.fallbackTokenizer(text);
        }

        throw new TokenizerUnavailableError(
            `Fail-Closed: Recorded token count missing for text segment [${text.slice(0, 30)}...] (length: ${text.length}). Character estimations are prohibited.`,
        );
    }
}

/**
 * Real Tokenizer Adapter
 * Integrates with an authentic tokenizer implementation (e.g. TikToken, SentencePiece).
 */
export class TokenizerAdapterEstimator extends ITokenBudgetEstimator {
    /**
     * @param {(text: string) => Promise<number> | number} countTokensFn
     */
    constructor(countTokensFn) {
        super();
        if (typeof countTokensFn !== 'function') {
            throw new TokenizerUnavailableError('TokenizerAdapterEstimator requires a valid tokenizer function.');
        }
        this.countTokensFn = countTokensFn;
    }

    /**
     * @param {string} text
     * @returns {Promise<number>}
     */
    async countTokens(text) {
        if (text === '') return 0;
        return await this.countTokensFn(text);
    }
}

/**
 * Factory helper for creating an appropriate token budget estimator.
 * @param {object} [options]
 * @param {Record<string, number> | Map<string, number>} [options.recordedTokens]
 * @param {(text: string) => Promise<number> | number} [options.tokenizer]
 * @returns {ITokenBudgetEstimator}
 */
export function createTokenEstimator(options = {}) {
    if (options.recordedTokens) {
        return new RecordedTokenEstimator(options.recordedTokens, options.tokenizer);
    }
    if (typeof options.tokenizer === 'function') {
        return new TokenizerAdapterEstimator(options.tokenizer);
    }
    return new FailClosedTokenEstimator();
}
