import crypto from 'node:crypto';

/**
 * Dual-track tokenizer adapter.
 * Track A: Lookup recorded token counts (offline golden fixtures).
 * Track B: True model tokenizer instance/callback.
 * Fail-Closed: Throws an explicit error if a count is missing and no tokenizer is available.
 * Heuristic/character-length estimations (e.g., length / 4) are strictly prohibited.
 */
export class DualTrackTokenizer {
    /**
     * @param {object} [options]
     * @param {Record<string, number>} [options.recordedTokenCounts]
     * @param {{ countAsync?: Function, count?: Function }} [options.tokenizer]
     */
    constructor({ recordedTokenCounts = {}, tokenizer = null } = {}) {
        this.recordedTokenCounts = recordedTokenCounts || {};
        this.tokenizer = tokenizer;
    }

    /**
     * Compute SHA-256 hash of a string.
     * @param {string} text
     * @returns {string}
     */
    static hash(text) {
        if (typeof text !== 'string') {
            text = JSON.stringify(text ?? '');
        }
        return crypto.createHash('sha256').update(text).digest('hex');
    }

    /**
     * Build lookup keys for a message or content.
     * @param {object|string} item
     * @param {string} [identifier]
     * @returns {string[]}
     */
    static getLookupKeys(item, identifier = '') {
        const keys = [];

        if (identifier) {
            keys.push(identifier);
        }

        if (typeof item === 'string') {
            const h = DualTrackTokenizer.hash(item);
            keys.push(h);
            keys.push(item);
            return keys;
        }

        if (!item || typeof item !== 'object') {
            return keys;
        }

        if (item.identifier) {
            keys.push(item.identifier);
        }

        const role = item.role || 'system';
        const rawContent = Array.isArray(item.content)
            ? JSON.stringify(item.content)
            : String(item.content ?? '');
        const contentHash = DualTrackTokenizer.hash(rawContent);

        keys.push(`${role}:${contentHash}`);
        keys.push(contentHash);

        if (item.name) {
            keys.push(`${role}:${item.name}:${contentHash}`);
        }

        if (item.tool_calls) {
            const toolCallsStr = typeof item.tool_calls === 'string'
                ? item.tool_calls
                : JSON.stringify(item.tool_calls);
            const toolHash = DualTrackTokenizer.hash(toolCallsStr);
            keys.push(`${role}:tool_calls:${toolHash}`);
            keys.push(`tool_calls:${toolHash}`);
        }

        keys.push(rawContent);

        return keys;
    }

    /**
     * Count tokens for a given message or content item.
     * @param {object|string} item
     * @param {string} [identifier]
     * @returns {Promise<number>}
     */
    async countAsync(item, identifier = '') {
        return this.countSync(item, identifier);
    }

    /**
     * Synchronous count lookup.
     * @param {object|string} item
     * @param {string} [identifier]
     * @returns {number}
     */
    countSync(item, identifier = '') {
        const candidateKeys = DualTrackTokenizer.getLookupKeys(item, identifier);

        for (const key of candidateKeys) {
            if (Object.prototype.hasOwnProperty.call(this.recordedTokenCounts, key)) {
                return this.recordedTokenCounts[key];
            }
        }

        if (this.tokenizer) {
            if (typeof this.tokenizer.count === 'function') {
                return this.tokenizer.count(item);
            }
            if (typeof this.tokenizer.countAsync === 'function') {
                const res = this.tokenizer.countAsync(item);
                if (res instanceof Promise) {
                    throw new Error('[DualTrackTokenizer] Tokenizer provided async method in countSync context.');
                }
                return res;
            }
        }

        const candidateList = candidateKeys.filter(Boolean).join(', ');
        throw new Error(
            `[DualTrackTokenizer] Fail-Closed: No recorded token count found for keys [${candidateList}] and no tokenizer available. Heuristic estimation is strictly prohibited.`,
        );
    }
}
