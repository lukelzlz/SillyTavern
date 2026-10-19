/**
 * World Info Selective Logic Enums
 */
export const WI_LOGIC = Object.freeze({
    AND_ANY: 0,
    AND_ALL: 1,
    NOT_ANY: 2,
    NOT_ALL: 3,
});

/**
 * World Info Position Enums
 */
export const WI_POSITION = Object.freeze({
    BEFORE_CHAR: 0,
    AFTER_CHAR: 1,
    AN_TOP: 2,
    AN_BOTTOM: 3,
    AT_DEPTH: 4,
    EM_TOP: 5,
    EM_BOTTOM: 6,
});

function escapeRegex(string) {
    return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function parseRegexFromString(str) {
    if (typeof str !== 'string') return null;
    const match = str.match(/^\/(.+)\/([a-z]*)$/i);
    if (!match) return null;
    try {
        return new RegExp(match[1], match[2]);
    } catch {
        return null;
    }
}

/**
 * High-performance server-side World Info scanning & matching engine.
 */
export class WorldInfoEngine {
    /**
     * Match a key against the scan text.
     * @param {string} haystack
     * @param {string} needle
     * @param {object} entry
     * @param {boolean} defaultMatchWholeWords
     * @returns {boolean}
     */
    static matchKey(haystack, needle, entry = {}, defaultMatchWholeWords = false) {
        if (!needle || !haystack) return false;

        const regex = parseRegexFromString(needle);
        if (regex) {
            return regex.test(haystack);
        }

        const caseSensitive = entry.caseSensitive ?? false;
        const matchWholeWords = entry.matchWholeWords ?? defaultMatchWholeWords;

        const searchHaystack = caseSensitive ? haystack : haystack.toLowerCase();
        const searchNeedle = caseSensitive ? needle : needle.toLowerCase();

        if (matchWholeWords) {
            const words = searchNeedle.split(/\s+/);
            if (words.length > 1) {
                return searchHaystack.includes(searchNeedle);
            }
            const boundaryRegex = new RegExp(`(?:^|\\W)(${escapeRegex(searchNeedle)})(?:$|\\W)`);
            return boundaryRegex.test(searchHaystack);
        }

        return searchHaystack.includes(searchNeedle);
    }

    /**
     * Test whether an entry should activate against the given text.
     * @param {object} entry
     * @param {string} text
     * @param {boolean} defaultMatchWholeWords
     * @returns {boolean}
     */
    static testEntry(entry, text, defaultMatchWholeWords = false) {
        if (entry.disable) return false;
        if (entry.constant) return true;

        const primaryKeys = Array.isArray(entry.key) ? entry.key : [];
        if (primaryKeys.length === 0) return false;

        // 1. Primary keys check (any match)
        const primaryMatched = primaryKeys.some(k => this.matchKey(text, String(k).trim(), entry, defaultMatchWholeWords));
        if (!primaryMatched) return false;

        // 2. Secondary keys check (selective filter)
        const secondaryKeys = Array.isArray(entry.keysecondary)
            ? entry.keysecondary
            : (Array.isArray(entry.secondary_keys) ? entry.secondary_keys : []);

        if (!entry.selective || secondaryKeys.length === 0) {
            return true;
        }

        const logic = entry.selectiveLogic ?? WI_LOGIC.AND_ANY;
        let anyMatch = false;
        let allMatch = true;

        for (const secKey of secondaryKeys) {
            const matched = this.matchKey(text, String(secKey).trim(), entry, defaultMatchWholeWords);
            if (matched) anyMatch = true;
            if (!matched) allMatch = false;

            if (logic === WI_LOGIC.AND_ANY && matched) return true;
            if (logic === WI_LOGIC.NOT_ALL && !matched) return true;
        }

        if (logic === WI_LOGIC.NOT_ANY) return !anyMatch;
        if (logic === WI_LOGIC.AND_ALL) return allMatch;

        return anyMatch;
    }

    /**
     * Scan entries against chat text with recursive cascade support.
     * @param {object} params
     * @param {object[]} params.entries Array of World Info entries
     * @param {string} params.text Primary chat text buffer
     * @param {object} [params.options]
     * @param {number} [params.options.maxRecursionSteps=3]
     * @param {number} [params.options.budget=0] 0 for unlimited
     * @param {boolean} [params.options.matchWholeWords=false]
     * @param {string} [params.options.trigger='normal']
     * @returns {object}
     */
    static scan({ entries = [], text = '', options = {} }) {
        const startTime = Date.now();
        const maxRecursionSteps = options.maxRecursionSteps ?? 3;
        const budget = options.budget ?? 0;
        const matchWholeWords = options.matchWholeWords ?? false;
        const trigger = options.trigger || 'normal';

        /** @type {Map<string, object>} */
        const activatedEntries = new Map();
        let currentScanText = text;
        let pass = 0;

        // Filter out entries whose triggers don't match (if triggers configured)
        const eligibleEntries = entries.filter(e => {
            if (Array.isArray(e.triggers) && e.triggers.length > 0) {
                return e.triggers.includes(trigger);
            }
            return true;
        });

        // Loop passes for recursive activation
        while (pass <= maxRecursionSteps) {
            pass++;
            let newlyActivated = 0;
            let recursionBuffer = '';

            for (const entry of eligibleEntries) {
                const entryId = `${entry.world || 'wi'}_${entry.uid ?? entry.id ?? Math.random()}`;
                if (activatedEntries.has(entryId)) continue;

                // Check exclusion for recursion
                if (pass > 1 && entry.excludeRecursion) continue;

                if (this.testEntry(entry, currentScanText, matchWholeWords)) {
                    activatedEntries.set(entryId, entry);
                    newlyActivated++;

                    if (!entry.preventRecursion && entry.content) {
                        recursionBuffer += `\n${entry.content}`;
                    }
                }
            }

            if (newlyActivated === 0 || !recursionBuffer) {
                break;
            }

            currentScanText += recursionBuffer;
        }

        // Sort activated entries by order
        const sorted = Array.from(activatedEntries.values()).sort((a, b) => {
            const orderA = a.order ?? 100;
            const orderB = b.order ?? 100;
            return orderA - orderB;
        });

        // Format into insertion blocks according to position and budget
        let worldInfoBefore = '';
        let worldInfoAfter = '';
        const depthEntries = [];
        let totalCharsUsed = 0;

        for (const entry of sorted) {
            const content = entry.content || '';
            if (budget > 0 && totalCharsUsed + content.length > budget) {
                continue;
            }
            totalCharsUsed += content.length;

            const pos = entry.position ?? WI_POSITION.BEFORE_CHAR;
            if (pos === WI_POSITION.BEFORE_CHAR || pos === 'before_char') {
                worldInfoBefore += (worldInfoBefore ? '\n' : '') + content;
            } else if (pos === WI_POSITION.AFTER_CHAR || pos === 'after_char') {
                worldInfoAfter += (worldInfoAfter ? '\n' : '') + content;
            } else if (pos === WI_POSITION.AT_DEPTH || pos === 'at_depth') {
                depthEntries.push({
                    depth: entry.depth ?? 4,
                    role: entry.role ?? 'system',
                    content: content,
                    order: entry.order ?? 100,
                });
            } else {
                // Fallback to before_char
                worldInfoBefore += (worldInfoBefore ? '\n' : '') + content;
            }
        }

        return {
            activatedCount: activatedEntries.size,
            activatedEntries: sorted,
            worldInfoBefore,
            worldInfoAfter,
            depthEntries,
            totalCharsUsed,
            stats: {
                totalScanned: eligibleEntries.length,
                passes: pass,
                durationMs: Date.now() - startTime,
            },
        };
    }
}

export default WorldInfoEngine;
