/**
 * Canonical server-context envelope version.
 * Keep this value in one module so browser/server contract checks cannot drift.
 */
export const CORE_PROMPT_CONTEXT_SCHEMA_VERSION = 1;

const PROMPT_ROLES = new Set(['system', 'user', 'assistant', 'tool']);
const GENERATION_TYPES = new Set(['normal', 'continue', 'impersonate', 'quiet']);

function isPlainObject(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function addIssue(issues, path, message) {
    issues.push(`${path}: ${message}`);
}

function validateOptionalString(value, path, issues) {
    if (value !== undefined && value !== null && typeof value !== 'string') {
        addIssue(issues, path, 'must be a string when provided');
    }
}

function validateMessage(message, path, issues) {
    if (!isPlainObject(message)) {
        addIssue(issues, path, 'must be an object');
        return;
    }

    if (typeof message.role !== 'string' || !PROMPT_ROLES.has(message.role)) {
        addIssue(issues, `${path}.role`, 'must be one of system, user, assistant, or tool');
    }

    const contentIsValid = typeof message.content === 'string'
        || Array.isArray(message.content)
        || message.content === null
        || message.content === undefined;
    if (!contentIsValid) {
        addIssue(issues, `${path}.content`, 'must be a string, array, null, or undefined');
    }
}

function validatePrompt(prompt, path, issues) {
    if (!isPlainObject(prompt)) {
        addIssue(issues, path, 'must be an object');
        return;
    }

    if (typeof prompt.identifier !== 'string' || prompt.identifier.trim().length === 0) {
        addIssue(issues, `${path}.identifier`, 'must be a non-empty string');
    }

    if (prompt.role !== undefined && (typeof prompt.role !== 'string' || !PROMPT_ROLES.has(prompt.role))) {
        addIssue(issues, `${path}.role`, 'must be one of system, user, assistant, or tool');
    }

    const contentIsValid = typeof prompt.content === 'string' || Array.isArray(prompt.content);
    if (prompt.content !== undefined && !contentIsValid) {
        addIssue(issues, `${path}.content`, 'must be a string or array when provided');
    }

    for (const key of ['name', 'position', 'injection_position', 'injection_depth', 'injection_order', 'injection_trigger']) {
        if (key === 'injection_depth' || key === 'injection_order') {
            if (prompt[key] !== undefined && (!Number.isInteger(prompt[key]) || prompt[key] < 0)) {
                addIssue(issues, `${path}.${key}`, 'must be a non-negative integer when provided');
            }
            continue;
        }
        if (key === 'injection_trigger') {
            if (prompt[key] !== undefined && !Array.isArray(prompt[key]) && typeof prompt[key] !== 'string') {
                addIssue(issues, `${path}.${key}`, 'must be a string or array when provided');
            }
            continue;
        }
        if (key === 'name' || key === 'position' || key === 'injection_position') {
            validateOptionalString(prompt[key], `${path}.${key}`, issues);
        }
    }

    for (const key of ['system_prompt', 'forbid_overrides', 'extension', 'disabled']) {
        if (prompt[key] !== undefined && typeof prompt[key] !== 'boolean') {
            addIssue(issues, `${path}.${key}`, 'must be boolean when provided');
        }
    }
}

/**
 * Validates the structured browser-to-server prompt contract without mutating
 * or normalizing the input. Extra fields remain allowed for forward-compatible
 * provider and extension metadata.
 *
 * @param {unknown} context
 * @returns {{ valid: boolean, issues: string[] }}
 */
export function validateCorePromptContext(context) {
    const issues = [];

    if (!isPlainObject(context)) {
        return { valid: false, issues: ['context: must be an object'] };
    }

    const envelope = /** @type {Record<string, any>} */ (context);

    if (envelope.schemaVersion !== CORE_PROMPT_CONTEXT_SCHEMA_VERSION) {
        addIssue(issues, 'schemaVersion', `must equal ${CORE_PROMPT_CONTEXT_SCHEMA_VERSION}`);
    }

    if (!isPlainObject(envelope.settings)) {
        addIssue(issues, 'settings', 'must be an object');
    } else {
        validateOptionalString(envelope.settings.source, 'settings.source', issues);
        validateOptionalString(envelope.settings.model, 'settings.model', issues);
        for (const key of ['maxContext', 'maxTokens']) {
            if (envelope.settings[key] !== undefined
                && (!Number.isFinite(envelope.settings[key]) || envelope.settings[key] <= 0)) {
                addIssue(issues, `settings.${key}`, 'must be a positive finite number when provided');
            }
        }
        for (const key of ['squashSystemMessages', 'pinExamples', 'continuePrefill']) {
            if (envelope.settings[key] !== undefined && typeof envelope.settings[key] !== 'boolean') {
                addIssue(issues, `settings.${key}`, 'must be boolean when provided');
            }
        }
        for (const key of ['namesBehavior', 'newChatPrompt', 'newGroupChatPrompt', 'newExampleChatPrompt', 'scenarioFormat', 'personalityFormat', 'continueNudgePrompt']) {
            validateOptionalString(envelope.settings[key], `settings.${key}`, issues);
        }
    }

    if (!isPlainObject(envelope.generationControl)) {
        addIssue(issues, 'generationControl', 'must be an object');
    } else {
        if (typeof envelope.generationControl.type !== 'string' || !GENERATION_TYPES.has(envelope.generationControl.type)) {
            addIssue(issues, 'generationControl.type', 'must be one of normal, continue, impersonate, or quiet');
        }
        if (envelope.generationControl.dryRun !== undefined && typeof envelope.generationControl.dryRun !== 'boolean') {
            addIssue(issues, 'generationControl.dryRun', 'must be boolean when provided');
        }
        for (const key of ['bias', 'quietPrompt', 'cyclePrompt']) {
            validateOptionalString(envelope.generationControl[key], `generationControl.${key}`, issues);
        }
    }

    for (const section of ['characterContext', 'worldInfo', 'toolsContext']) {
        if (!isPlainObject(envelope[section])) {
            addIssue(issues, section, 'must be an object');
        }
    }

    if (isPlainObject(envelope.characterContext)) {
        for (const key of ['name1', 'name2', 'charDescription', 'charPersonality', 'personaDescription', 'scenario', 'systemPromptOverride', 'jailbreakPromptOverride']) {
            validateOptionalString(envelope.characterContext[key], `characterContext.${key}`, issues);
        }
    }

    if (isPlainObject(envelope.worldInfo)) {
        validateOptionalString(envelope.worldInfo.worldInfoBefore, 'worldInfo.worldInfoBefore', issues);
        validateOptionalString(envelope.worldInfo.worldInfoAfter, 'worldInfo.worldInfoAfter', issues);
        if (envelope.worldInfo.entries !== undefined) {
            if (!Array.isArray(envelope.worldInfo.entries)) {
                addIssue(issues, 'worldInfo.entries', 'must be an array when provided');
            } else {
                envelope.worldInfo.entries.forEach((entry, index) => {
                    if (!isPlainObject(entry)) {
                        addIssue(issues, `worldInfo.entries[${index}]`, 'must be an object');
                        return;
                    }
                    if (entry.content !== undefined && typeof entry.content !== 'string') {
                        addIssue(issues, `worldInfo.entries[${index}].content`, 'must be a string when provided');
                    }
                    if (entry.key !== undefined && !Array.isArray(entry.key)) {
                        addIssue(issues, `worldInfo.entries[${index}].key`, 'must be an array when provided');
                    }
                });
            }
        }
        for (const key of ['globalScanData', 'options']) {
            if (envelope.worldInfo[key] !== undefined && !isPlainObject(envelope.worldInfo[key])) {
                addIssue(issues, `worldInfo.${key}`, 'must be an object when provided');
            }
        }
    }

    if (isPlainObject(envelope.toolsContext)
        && envelope.toolsContext.canPerformToolCalls !== undefined
        && typeof envelope.toolsContext.canPerformToolCalls !== 'boolean') {
        addIssue(issues, 'toolsContext.canPerformToolCalls', 'must be boolean when provided');
    }

    if (!Array.isArray(envelope.promptOrder)) {
        addIssue(issues, 'promptOrder', 'must be an array');
    } else {
        envelope.promptOrder.forEach((identifier, index) => {
            if (typeof identifier !== 'string' || identifier.trim().length === 0) {
                addIssue(issues, `promptOrder[${index}]`, 'must be a non-empty string');
            }
        });
    }

    if (!Array.isArray(envelope.prompts)) {
        addIssue(issues, 'prompts', 'must be an array');
    } else {
        envelope.prompts.forEach((prompt, index) => validatePrompt(prompt, `prompts[${index}]`, issues));
    }

    if (!isPlainObject(envelope.extensionPrompts)) {
        addIssue(issues, 'extensionPrompts', 'must be an object');
    }

    if (!Array.isArray(envelope.chatHistory)) {
        addIssue(issues, 'chatHistory', 'must be an array');
    } else {
        envelope.chatHistory.forEach((message, index) => validateMessage(message, `chatHistory[${index}]`, issues));
    }

    if (!Array.isArray(envelope.messageExamples)) {
        addIssue(issues, 'messageExamples', 'must be an array');
    } else {
        envelope.messageExamples.forEach((example, exampleIndex) => {
            if (!Array.isArray(example)) {
                addIssue(issues, `messageExamples[${exampleIndex}]`, 'must be an array');
                return;
            }
            example.forEach((message, messageIndex) => validateMessage(message, `messageExamples[${exampleIndex}][${messageIndex}]`, issues));
        });
    }

    if (!isPlainObject(envelope.recordedTokenCounts)) {
        addIssue(issues, 'recordedTokenCounts', 'must be an object');
    } else {
        for (const [key, value] of Object.entries(envelope.recordedTokenCounts)) {
            if (!Number.isInteger(value) || value < 0) {
                addIssue(issues, `recordedTokenCounts.${key}`, 'must be a non-negative integer');
            }
        }
    }

    return { valid: issues.length === 0, issues };
}
