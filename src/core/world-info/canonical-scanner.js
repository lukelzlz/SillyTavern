import {
    WI_LOGIC,
    WI_POSITION,
    WI_ANCHOR_POSITION,
    EXTENSION_PROMPT_ROLES,
    DEFAULT_DEPTH,
    MAX_SCAN_DEPTH,
} from './types.js';
import { createTokenEstimator } from './token-budget.js';

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
 * Standard pure data scanner for SillyTavern World Info.
 * Adheres strictly to PROPOSAL-003 and ADR-003 contracts.
 */
export class CanonicalWorldInfoScanner {
    /**
     * Build the text buffer for an entry respecting scanDepth, globalScanData, and source match flags.
     * @param {object} params
     * @param {object} params.entry
     * @param {Array<string | { mes?: string, text?: string, content?: string | object[] }>} params.chatMessages
     * @param {object} params.globalScanData
     * @param {Record<string, { value: string, scan?: boolean }>} [params.extensionPrompts]
     * @returns {string}
     */
    static buildScanBuffer({ entry, chatMessages = [], globalScanData = {}, extensionPrompts = {} }) {
        const MATCHER = '\x01';
        const JOINER = '\n' + MATCHER;

        const rawDepth = entry.scanDepth ?? chatMessages.length;
        const depth = Math.min(Math.max(0, rawDepth), MAX_SCAN_DEPTH);

        const slicedMessages = [];
        for (let i = 0; i < depth && i < chatMessages.length; i++) {
            const msg = chatMessages[i];
            let text = '';
            if (typeof msg === 'string') {
                text = msg.trim();
            } else if (msg && typeof msg.mes === 'string') {
                text = msg.mes.trim();
            } else if (msg && typeof msg.text === 'string') {
                text = msg.text.trim();
            } else if (msg && typeof msg.content === 'string') {
                text = msg.content.trim();
            } else if (msg && Array.isArray(msg.content)) {
                text = msg.content
                    .filter((part) => part && part.type === 'text' && typeof part.text === 'string')
                    .map((part) => part.text.trim())
                    .filter(Boolean)
                    .join('\n');
            }
            if (text) {
                slicedMessages.push(text);
            }
        }

        let result = MATCHER + slicedMessages.join(JOINER);

        if (entry.matchPersonaDescription && globalScanData.personaDescription) {
            result += JOINER + globalScanData.personaDescription;
        }
        if (entry.matchCharacterDescription && globalScanData.characterDescription) {
            result += JOINER + globalScanData.characterDescription;
        }
        if (entry.matchCharacterPersonality && globalScanData.characterPersonality) {
            result += JOINER + globalScanData.characterPersonality;
        }
        if (entry.matchCharacterDepthPrompt && globalScanData.characterDepthPrompt) {
            result += JOINER + globalScanData.characterDepthPrompt;
        }
        if (entry.matchScenario && globalScanData.scenario) {
            result += JOINER + globalScanData.scenario;
        }
        if (entry.matchCreatorNotes && globalScanData.creatorNotes) {
            result += JOINER + globalScanData.creatorNotes;
        }

        if (extensionPrompts && typeof extensionPrompts === 'object') {
            for (const key of Object.keys(extensionPrompts)) {
                if (extensionPrompts[key]?.scan && extensionPrompts[key]?.value) {
                    result += JOINER + extensionPrompts[key].value;
                }
            }
        }

        return result;
    }

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
            const keyWords = searchNeedle.split(/\s+/);
            if (keyWords.length > 1) {
                return searchHaystack.includes(searchNeedle);
            }
            const boundaryRegex = new RegExp(`(?:^|\\W)(${escapeRegex(searchNeedle)})(?:$|\\W)`);
            return boundaryRegex.test(searchHaystack);
        }

        return searchHaystack.includes(searchNeedle);
    }

    /**
     * Resolves human-readable position string for debug trace.
     * @param {object} entry
     * @returns {string}
     */
    static resolvePositionLabel(entry) {
        switch (entry.position) {
            case WI_POSITION.before: return 'before';
            case WI_POSITION.after: return 'after';
            case WI_POSITION.ANTop: return 'ANTop';
            case WI_POSITION.ANBottom: return 'ANBottom';
            case WI_POSITION.atDepth: return `atDepth@${entry.depth ?? DEFAULT_DEPTH}`;
            case WI_POSITION.EMTop: return 'EMTop';
            case WI_POSITION.EMBottom: return 'EMBottom';
            case WI_POSITION.outlet: return `outlet:${entry.outletName || 'unnamed'}`;
            default: return 'before';
        }
    }

    /**
     * Execute canonical world info scan.
     * @param {object} [input={}]
     * @param {Array<object>} [input.entries]
     * @param {Array<string | object>} [input.chatMessages]
     * @param {object} [input.globalScanData]
     * @param {Record<string, object>} [input.extensionPrompts]
     * @param {object} [input.options]
     * @param {number} [input.options.budget=0]
     * @param {boolean} [input.options.matchWholeWords=false]
     * @param {string} [input.options.trigger]
     * @param {import('./token-budget.js').ITokenBudgetEstimator} [input.options.tokenEstimator]
     * @param {Record<string, number>} [input.options.recordedTokens]
     * @param {(text: string) => Promise<number> | number} [input.options.tokenizer]
     * @param {() => number} [input.options.rollFn]
     * @returns {Promise<object>} WorldInfoScanOutput
     */
    static async scan(input = {}) {
        const startTime = Date.now();
        const {
            entries = [],
            chatMessages = [],
            globalScanData = {
                trigger: 'normal',
                personaDescription: '',
                characterDescription: '',
                characterPersonality: '',
                characterDepthPrompt: '',
                scenario: '',
                creatorNotes: '',
            },
            extensionPrompts = {},
            options = {},
        } = input;

        const budget = Math.max(0, options.budget ?? 0);
        const matchWholeWords = options.matchWholeWords ?? false;
        const trigger = globalScanData.trigger || options.trigger || 'normal';
        const rollFn = typeof options.rollFn === 'function' ? options.rollFn : () => Math.random() * 100;

        const tokenEstimator = options.tokenEstimator || createTokenEstimator({
            recordedTokens: options.recordedTokens,
            tokenizer: options.tokenizer,
        });

        const evaluationSteps = [];
        const preliminaryCandidates = [];

        // 1. Primary & Secondary & Trigger evaluation pass
        for (const entry of entries) {
            const uid = entry.uid ?? `${entry.world || 'wi'}_${evaluationSteps.length}`;
            const step = {
                uid,
                comment: entry.comment || '',
                passedPrimary: false,
                passedSecondary: false,
                passedProbability: false,
                passedBudget: false,
                rejectionReason: undefined,
                resolvedPosition: this.resolvePositionLabel(entry),
                estimatedTokens: 0,
            };

            // Check disable
            if (entry.disable) {
                step.rejectionReason = 'DISABLED';
                evaluationSteps.push(step);
                continue;
            }

            // Check triggers
            if (Array.isArray(entry.triggers) && entry.triggers.length > 0) {
                if (!entry.triggers.includes(trigger)) {
                    step.rejectionReason = 'PRIMARY_NOT_MATCHED';
                    evaluationSteps.push(step);
                    continue;
                }
            }

            const bufferState = this.buildScanBuffer({
                entry,
                chatMessages,
                globalScanData,
                extensionPrompts,
            });

            // Constant entry bypasses key checks
            if (entry.constant) {
                step.passedPrimary = true;
                step.passedSecondary = true;
            } else {
                const primaryKeys = Array.isArray(entry.key) ? entry.key : [];
                if (primaryKeys.length === 0) {
                    step.rejectionReason = 'PRIMARY_NOT_MATCHED';
                    evaluationSteps.push(step);
                    continue;
                }

                const primaryMatched = primaryKeys.some(k =>
                    this.matchKey(bufferState, String(k).trim(), entry, matchWholeWords),
                );

                if (!primaryMatched) {
                    step.rejectionReason = 'PRIMARY_NOT_MATCHED';
                    evaluationSteps.push(step);
                    continue;
                }
                step.passedPrimary = true;

                // Secondary keys check
                const secondaryKeys = Array.isArray(entry.keysecondary)
                    ? entry.keysecondary
                    : (Array.isArray(entry.secondary_keys) ? entry.secondary_keys : []);

                if (entry.selective && secondaryKeys.length > 0) {
                    const logic = entry.selectiveLogic ?? WI_LOGIC.AND_ANY;
                    let anySecMatch = false;
                    let allSecMatch = true;

                    for (const secKey of secondaryKeys) {
                        const matched = this.matchKey(bufferState, String(secKey).trim(), entry, matchWholeWords);
                        if (matched) anySecMatch = true;
                        if (!matched) allSecMatch = false;
                    }

                    let secondarySatisfied = false;
                    if (logic === WI_LOGIC.AND_ANY && anySecMatch) secondarySatisfied = true;
                    else if (logic === WI_LOGIC.NOT_ALL && !allSecMatch) secondarySatisfied = true;
                    else if (logic === WI_LOGIC.NOT_ANY && !anySecMatch) secondarySatisfied = true;
                    else if (logic === WI_LOGIC.AND_ALL && allSecMatch) secondarySatisfied = true;

                    if (!secondarySatisfied) {
                        step.rejectionReason = 'SECONDARY_FILTERED';
                        evaluationSteps.push(step);
                        continue;
                    }
                }
                step.passedSecondary = true;
            }

            // Probability check
            if (entry.useProbability && typeof entry.probability === 'number' && entry.probability < 100) {
                const roll = rollFn();
                if (roll > entry.probability) {
                    step.rejectionReason = 'PROBABILITY_FAILED';
                    evaluationSteps.push(step);
                    continue;
                }
            }
            step.passedProbability = true;

            evaluationSteps.push(step);
            preliminaryCandidates.push({ entry, step });
        }

        // 2. Token budget enforcement
        let tokenBudgetOverflowed = false;
        let accumulatedActivatedText = '';
        const activatedEntries = [];
        let totalUsedTokens = 0;

        let ignoresBudgetRemaining = preliminaryCandidates.filter(c => c.entry.ignoreBudget).length;

        for (const candidate of preliminaryCandidates) {
            const { entry, step } = candidate;
            const content = entry.content || '';

            if (entry.ignoreBudget) {
                ignoresBudgetRemaining--;
            }

            if (tokenBudgetOverflowed && !entry.ignoreBudget) {
                step.rejectionReason = 'BUDGET_OVERFLOW';
                if (ignoresBudgetRemaining === 0) {
                    // Fast break if no subsequent candidate can ignore budget
                    break;
                }
                continue;
            }

            if (!entry.ignoreBudget && budget > 0) {
                const overflowCheck = await tokenEstimator.checkOverflow(
                    accumulatedActivatedText,
                    content,
                    budget,
                );

                if (overflowCheck.overflow) {
                    tokenBudgetOverflowed = true;
                    step.rejectionReason = 'BUDGET_OVERFLOW';
                    if (ignoresBudgetRemaining === 0) {
                        break;
                    }
                    continue;
                }
            }

            // Estimate entry tokens for reporting
            try {
                step.estimatedTokens = await tokenEstimator.countTokens(content);
            } catch {
                step.estimatedTokens = 0;
            }

            step.passedBudget = true;
            activatedEntries.push(entry);
            accumulatedActivatedText += `${content}\n`;
        }

        if (accumulatedActivatedText) {
            try {
                totalUsedTokens = await tokenEstimator.countTokens(accumulatedActivatedText.trim());
            } catch {
                totalUsedTokens = 0;
            }
        }

        // 3. Assemble all 8 standard slots
        // Forward-sorted insertion logic matching frontend public/scripts/world-info.js (line 5240):
        // Sorted descending by order, unshifting into ascending position arrays
        const sortFn = (a, b) => (b.order ?? 100) - (a.order ?? 100);
        const sortedForPlacement = [...activatedEntries].sort(sortFn);

        const WIBeforeEntries = [];
        const WIAfterEntries = [];
        const EMEntries = [];
        const ANTopEntries = [];
        const ANBottomEntries = [];
        const WIDepthEntries = [];
        /** @type {Record<string, string[]>} */
        const WIOutletEntries = {};

        for (const entry of sortedForPlacement) {
            const content = entry.content || '';
            if (!content) continue;

            const pos = entry.position ?? WI_POSITION.before;

            switch (pos) {
                case WI_POSITION.before:
                    WIBeforeEntries.unshift(content);
                    break;
                case WI_POSITION.after:
                    WIAfterEntries.unshift(content);
                    break;
                case WI_POSITION.EMTop:
                    EMEntries.unshift({
                        position: WI_ANCHOR_POSITION.before,
                        content,
                    });
                    break;
                case WI_POSITION.EMBottom:
                    EMEntries.unshift({
                        position: WI_ANCHOR_POSITION.after,
                        content,
                    });
                    break;
                case WI_POSITION.ANTop:
                    ANTopEntries.unshift(content);
                    break;
                case WI_POSITION.ANBottom:
                    ANBottomEntries.unshift(content);
                    break;
                case WI_POSITION.atDepth: {
                    const depth = entry.depth ?? DEFAULT_DEPTH;
                    const role = entry.role ?? EXTENSION_PROMPT_ROLES.SYSTEM;
                    const existingIndex = WIDepthEntries.findIndex(
                        e => e.depth === depth && e.role === role,
                    );
                    if (existingIndex !== -1) {
                        WIDepthEntries[existingIndex].entries.unshift(content);
                    } else {
                        WIDepthEntries.push({
                            depth,
                            role,
                            entries: [content],
                        });
                    }
                    break;
                }
                case WI_POSITION.outlet: {
                    if (!entry.outletName) {
                        break;
                    }
                    if (Array.isArray(WIOutletEntries[entry.outletName])) {
                        WIOutletEntries[entry.outletName].push(content);
                    } else {
                        WIOutletEntries[entry.outletName] = [content];
                    }
                    break;
                }
                default:
                    WIBeforeEntries.unshift(content);
                    break;
            }
        }

        const worldInfoBefore = WIBeforeEntries.length ? WIBeforeEntries.join('\n') : '';
        const worldInfoAfter = WIAfterEntries.length ? WIAfterEntries.join('\n') : '';

        return {
            worldInfoBefore,
            worldInfoAfter,
            EMEntries,
            WIDepthEntries,
            ANBeforeEntries: ANTopEntries,
            ANAfterEntries: ANBottomEntries,
            outletEntries: WIOutletEntries,
            activatedEntryUids: activatedEntries.map(e => String(e.uid ?? `${e.world || 'wi'}.${e.order}`)),
            debugTrace: {
                totalEvaluated: entries.length,
                totalActivated: activatedEntries.length,
                tokenBudget: {
                    limit: budget,
                    usedTokens: totalUsedTokens,
                    overflowed: tokenBudgetOverflowed,
                },
                evaluationSteps,
                durationMs: Date.now() - startTime,
            },
        };
    }
}

export default CanonicalWorldInfoScanner;
