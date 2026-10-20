import crypto from 'node:crypto';

/**
 * Suite of 8 golden differential assertions for Prompt Parity validation.
 */
export class PromptDiffAsserter {
    /**
     * Compute SHA-256 hash.
     * @param {any} val
     * @returns {string}
     */
    static sha256(val) {
        const text = typeof val === 'string' ? val : JSON.stringify(val ?? '');
        return crypto.createHash('sha256').update(text).digest('hex');
    }

    /**
     * 1. Message Count & Truncation Invariant
     * @param {object} actual
     * @param {object} expected
     */
    static assertMessageCountAndTruncation(actual, expected) {
        if (actual.chat.length !== expected.chat.length) {
            throw new Error(
                `[Assertion 1 Failed: Message Count Invariant] Message count mismatch. Actual: ${actual.chat.length}, Expected: ${expected.chat.length}`,
            );
        }

        if (
            expected.metadata?.droppedHistoryCount !== undefined &&
            actual.metadata?.droppedHistoryCount !== expected.metadata.droppedHistoryCount
        ) {
            throw new Error(
                `[Assertion 1 Failed: Truncation Invariant] Dropped history count mismatch. Actual: ${actual.metadata?.droppedHistoryCount}, Expected: ${expected.metadata?.droppedHistoryCount}`,
            );
        }
    }

    /**
     * 2. Role Sequence & Alignment
     * @param {object} actual
     * @param {object} expected
     */
    static assertRoleSequence(actual, expected) {
        for (let i = 0; i < expected.chat.length; i++) {
            const actRole = actual.chat[i]?.role;
            const expRole = expected.chat[i]?.role;
            if (actRole !== expRole) {
                throw new Error(
                    `[Assertion 2 Failed: Role Sequence] Role mismatch at index [${i}]. Actual: '${actRole}', Expected: '${expRole}'`,
                );
            }
        }
    }

    /**
     * 3. Content Text & Hash Invariant
     * @param {object} actual
     * @param {object} expected
     */
    static assertContentTextAndHash(actual, expected) {
        for (let i = 0; i < expected.chat.length; i++) {
            const act = actual.chat[i];
            const exp = expected.chat[i];

            const actContentStr = typeof act.content === 'string' ? act.content : JSON.stringify(act.content);
            const expContentStr = typeof exp.content === 'string' ? exp.content : JSON.stringify(exp.content);

            const actHash = PromptDiffAsserter.sha256(actContentStr);
            const expHash = PromptDiffAsserter.sha256(expContentStr);

            if (actHash !== expHash) {
                throw new Error(
                    `[Assertion 3 Failed: Content Text & Hash Invariant] Content hash mismatch at index [${i}].\n` +
                    `Actual (hash ${actHash.slice(0, 8)}): ${actContentStr}\n` +
                    `Expected (hash ${expHash.slice(0, 8)}): ${expContentStr}`,
                );
            }
        }
    }

    /**
     * 4. Relative & Absolute Depth Slot Topological Invariant
     * @param {object} actual
     * @param {object} expected
     */
    static assertSlotTopology(actual, expected) {
        if (
            expected.metadata?.injectedPromptsCount !== undefined &&
            actual.metadata?.injectedPromptsCount !== expected.metadata.injectedPromptsCount
        ) {
            throw new Error(
                `[Assertion 4 Failed: Slot Topology] Injected prompts count mismatch. Actual: ${actual.metadata?.injectedPromptsCount}, Expected: ${expected.metadata?.injectedPromptsCount}`,
            );
        }

        // Check relative positions of key markers if identifiable
        for (let i = 0; i < expected.chat.length; i++) {
            const expName = expected.chat[i]?.name;
            const actName = actual.chat[i]?.name;
            if (expName !== actName) {
                throw new Error(
                    `[Assertion 4 Failed: Slot Topology] Name marker mismatch at index [${i}]. Actual: '${actName}', Expected: '${expName}'`,
                );
            }
        }
    }

    /**
     * 5. Squashed System Messages & Exclusion Whitelist
     * @param {object} actual
     * @param {object} expected
     */
    static assertSquashedSystemMessages(actual, expected) {
        if (
            expected.metadata?.squashedCount !== undefined &&
            actual.metadata?.squashedCount !== expected.metadata.squashedCount
        ) {
            throw new Error(
                `[Assertion 5 Failed: Squashed System Messages] Squashed count mismatch. Actual: ${actual.metadata?.squashedCount}, Expected: ${expected.metadata?.squashedCount}`,
            );
        }

        // Verify that whitelist strings are never squashed together
        const whitelistMarkers = ['--- Chat Begins ---', '--- Group Chat Begins ---', '--- [New Chat] ---'];
        for (let i = 0; i < actual.chat.length; i++) {
            const msg = actual.chat[i];
            if (typeof msg.content === 'string') {
                for (const marker of whitelistMarkers) {
                    if (msg.content.includes(marker) && msg.content !== marker) {
                        throw new Error(
                            `[Assertion 5 Failed: Squashed System Messages Whitelist Violation] Whitelist marker '${marker}' was erroneously squashed into: '${msg.content}'`,
                        );
                    }
                }
            }
        }
    }

    /**
     * 6. Tool Call Pairs & Interleaved Reasoning Invariant
     * @param {object} actual
     * @param {object} expected
     */
    static assertToolCallPairsAndReasoning(actual, expected) {
        for (let i = 0; i < expected.chat.length; i++) {
            const act = actual.chat[i];
            const exp = expected.chat[i];

            if (exp.tool_calls || act.tool_calls) {
                const actToolsStr = JSON.stringify(act.tool_calls || []);
                const expToolsStr = JSON.stringify(exp.tool_calls || []);
                if (actToolsStr !== expToolsStr) {
                    throw new Error(
                        `[Assertion 6 Failed: Tool Call Invariant] Tool calls mismatch at index [${i}].\nActual: ${actToolsStr}\nExpected: ${expToolsStr}`,
                    );
                }
            }

            if (exp.tool_call_id || act.tool_call_id) {
                if (act.tool_call_id !== exp.tool_call_id) {
                    throw new Error(
                        `[Assertion 6 Failed: Tool Call ID Invariant] tool_call_id mismatch at index [${i}]. Actual: '${act.tool_call_id}', Expected: '${exp.tool_call_id}'`,
                    );
                }
            }

            if (exp.signature || act.signature) {
                if (act.signature !== exp.signature) {
                    throw new Error(
                        `[Assertion 6 Failed: Signature Invariant] Reasoning signature mismatch at index [${i}]. Actual: '${act.signature}', Expected: '${exp.signature}'`,
                    );
                }
            }

            if (exp.reasoning || act.reasoning) {
                if (act.reasoning !== exp.reasoning) {
                    throw new Error(
                        `[Assertion 6 Failed: Reasoning Invariant] Reasoning mismatch at index [${i}]. Actual: '${act.reasoning}', Expected: '${exp.reasoning}'`,
                    );
                }
            }
        }
    }

    /**
     * 7. Multimodal Inline Media & Layout Structure
     * @param {object} actual
     * @param {object} expected
     */
    static assertMultimodalLayout(actual, expected) {
        for (let i = 0; i < expected.chat.length; i++) {
            const act = actual.chat[i];
            const exp = expected.chat[i];

            const actIsArray = Array.isArray(act.content);
            const expIsArray = Array.isArray(exp.content);

            if (actIsArray !== expIsArray) {
                throw new Error(
                    `[Assertion 7 Failed: Multimodal Layout] Content array type mismatch at index [${i}]. Actual isArray: ${actIsArray}, Expected isArray: ${expIsArray}`,
                );
            }

            if (expIsArray) {
                if (act.content.length !== exp.content.length) {
                    throw new Error(
                        `[Assertion 7 Failed: Multimodal Layout] Content parts count mismatch at index [${i}]. Actual: ${act.content.length}, Expected: ${exp.content.length}`,
                    );
                }

                for (let p = 0; p < exp.content.length; p++) {
                    const actPart = act.content[p];
                    const expPart = exp.content[p];
                    if (actPart.type !== expPart.type) {
                        throw new Error(
                            `[Assertion 7 Failed: Multimodal Layout] Content part type mismatch at index [${i}][${p}]. Actual: '${actPart.type}', Expected: '${expPart.type}'`,
                        );
                    }
                    if (expPart.type === 'image_url') {
                        if (actPart.image_url?.url !== expPart.image_url?.url) {
                            throw new Error(
                                `[Assertion 7 Failed: Multimodal Layout] Image URL mismatch at index [${i}][${p}]. Actual: '${actPart.image_url?.url}', Expected: '${expPart.image_url?.url}'`,
                            );
                        }
                    }
                }
            }
        }
    }

    /**
     * 8. Token Budget Accounting & Trace Metadata Parity
     * @param {object} actual
     * @param {object} expected
     */
    static assertTokenBudgetAccounting(actual, expected) {
        if (!expected.metadata) return;

        const fields = ['totalBudget', 'tokensUsed', 'remainingTokens'];
        for (const f of fields) {
            if (expected.metadata[f] !== undefined) {
                if (actual.metadata?.[f] !== expected.metadata[f]) {
                    throw new Error(
                        `[Assertion 8 Failed: Token Budget Accounting] Metadata '${f}' mismatch. Actual: ${actual.metadata?.[f]}, Expected: ${expected.metadata[f]}`,
                    );
                }
            }
        }

        if (expected.metadata.reservedTokens) {
            for (const rk of Object.keys(expected.metadata.reservedTokens)) {
                const actR = actual.metadata?.reservedTokens?.[rk];
                const expR = expected.metadata.reservedTokens[rk];
                if (actR !== expR) {
                    throw new Error(
                        `[Assertion 8 Failed: Reserved Tokens] Reserved tokens for '${rk}' mismatch. Actual: ${actR}, Expected: ${expR}`,
                    );
                }
            }
        }
    }

    /**
     * Master verification running all 8 Golden Differential Assertions.
     * @param {object} actual - PromptAssemblyOutput
     * @param {object} expected - Golden Fixture Expected Output
     */
    static assertPromptParity(actual, expected) {
        PromptDiffAsserter.assertMessageCountAndTruncation(actual, expected);
        PromptDiffAsserter.assertRoleSequence(actual, expected);
        PromptDiffAsserter.assertContentTextAndHash(actual, expected);
        PromptDiffAsserter.assertSlotTopology(actual, expected);
        PromptDiffAsserter.assertSquashedSystemMessages(actual, expected);
        PromptDiffAsserter.assertToolCallPairsAndReasoning(actual, expected);
        PromptDiffAsserter.assertMultimodalLayout(actual, expected);
        PromptDiffAsserter.assertTokenBudgetAccounting(actual, expected);
    }
}
