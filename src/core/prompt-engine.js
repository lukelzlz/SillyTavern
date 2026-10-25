/**
 * PromptEngine handles macro substitution, system prompt assembly,
 * chat history formatting, depth prompt injection, and token budgeting on the server.
 */
export class PromptEngine {
    /**
     * Substitute macro variables in a template string.
     * @param {string} text
     * @param {Record<string, string>} vars
     * @returns {string}
     */
    static substituteMacros(text, vars = {}) {
        if (!text || typeof text !== 'string') return '';

        const charName = vars.char || vars.name2 || 'Assistant';
        const userName = vars.user || vars.name1 || 'User';

        let result = text
            .replace(/\{\{char\}\}/gi, (match) => {
                if (match === '{{CHAR}}') return charName.toUpperCase();
                if (match === '{{Char}}') return charName.charAt(0).toUpperCase() + charName.slice(1);
                return charName;
            })
            .replace(/\{\{user\}\}/gi, (match) => {
                if (match === '{{USER}}') return userName.toUpperCase();
                if (match === '{{User}}') return userName.charAt(0).toUpperCase() + userName.slice(1);
                return userName;
            });

        // Common macros
        if (vars.scenario) result = result.replace(/\{\{scenario\}\}/gi, vars.scenario);
        if (vars.persona) result = result.replace(/\{\{persona\}\}/gi, vars.persona);
        if (vars.description) result = result.replace(/\{\{description\}\}/gi, vars.description);
        if (vars.personality) result = result.replace(/\{\{personality\}\}/gi, vars.personality);

        // Strip unresolved standard placeholder tags
        result = result.replace(/<START>/gi, '---');

        return result;
    }

    /**
     * Rough token estimation (1 token ~= 4 chars for English, 1 char ~= 1.5 tokens for CJK)
     * Used for fast budgeting when tokenizer models are not loaded.
     * @param {string} text
     * @returns {number}
     */
    static estimateTokens(text) {
        if (!text || typeof text !== 'string') return 0;
        let cjkCount = 0;
        for (let i = 0; i < text.length; i++) {
            const code = text.charCodeAt(i);
            if ((code >= 0x4e00 && code <= 0x9fff) || (code >= 0x3400 && code <= 0x4dbf)) {
                cjkCount++;
            }
        }
        const nonCjkLen = text.length - cjkCount;
        return Math.ceil(nonCjkLen / 3.8) + Math.ceil(cjkCount * 1.5);
    }

    /**
     * Assemble the full chat completion messages payload.
     * @param {object} params
     * @param {object} params.character
     * @param {object} params.user
     * @param {string} [params.systemPrompt]
     * @param {string} [params.jailbreak]
     * @param {string} [params.worldInfoBefore]
     * @param {string} [params.worldInfoAfter]
     * @param {object[]} [params.depthPrompts]
     * @param {object[]} [params.messages]
     * @param {object} [params.options]
     * @returns {{ messages: object[], stats: object }}
     */
    static assemble({
        character = {},
        user = {},
        systemPrompt = '',
        jailbreak = '',
        worldInfoBefore = '',
        worldInfoAfter = '',
        depthPrompts = [],
        messages = [],
        options = {},
    }) {
        const charName = character.name || 'Assistant';
        const userName = user.name || 'User';
        const vars = {
            char: charName,
            user: userName,
            description: character.description || '',
            personality: character.personality || '',
            scenario: character.scenario || '',
            persona: user.persona || '',
        };

        const maxContext = options.maxContextTokens || 4096;
        const maxResponseTokens = options.maxResponseTokens || 500;
        const budget = maxContext - maxResponseTokens;

        // 1. Build System Block
        const systemParts = [];

        if (systemPrompt) {
            systemParts.push(this.substituteMacros(systemPrompt, vars));
        }

        if (worldInfoBefore) {
            systemParts.push(this.substituteMacros(worldInfoBefore, vars));
        }

        if (character.description) {
            systemParts.push(`Description of ${charName}:\n${this.substituteMacros(character.description, vars)}`);
        }

        if (character.personality) {
            systemParts.push(`Personality of ${charName}:\n${this.substituteMacros(character.personality, vars)}`);
        }

        if (character.scenario) {
            systemParts.push(`Scenario:\n${this.substituteMacros(character.scenario, vars)}`);
        }

        if (user.persona) {
            systemParts.push(`Information about ${userName}:\n${this.substituteMacros(user.persona, vars)}`);
        }

        if (worldInfoAfter) {
            systemParts.push(this.substituteMacros(worldInfoAfter, vars));
        }

        if (jailbreak) {
            systemParts.push(this.substituteMacros(jailbreak, vars));
        }

        const combinedSystemText = systemParts.filter(Boolean).join('\n\n');
        let currentTokens = this.estimateTokens(combinedSystemText);

        const resultMessages = [];
        if (combinedSystemText.trim()) {
            resultMessages.push({
                role: 'system',
                content: combinedSystemText.trim(),
            });
        }

        // 2. Process Chat Messages backwards to respect budget
        const formattedHistory = [];
        const validMessages = Array.isArray(messages) ? messages.filter(m => !m.is_system) : [];

        // Organize depth prompts by depth
        const depthMap = new Map();
        for (const dp of depthPrompts) {
            const d = dp.depth ?? 4;
            if (!depthMap.has(d)) depthMap.set(d, []);
            depthMap.get(d).push(dp);
        }

        let messagesIncluded = 0;
        const totalMsgs = validMessages.length;

        for (let i = totalMsgs - 1; i >= 0; i--) {
            const msg = validMessages[i];
            const role = msg.is_user ? 'user' : 'assistant';
            const author = msg.name || (msg.is_user ? userName : charName);
            const content = this.substituteMacros(msg.mes || '', vars);
            const msgTokens = this.estimateTokens(content);

            if (currentTokens + msgTokens > budget && messagesIncluded > 0) {
                // Exceeded budget, stop including older messages
                break;
            }

            currentTokens += msgTokens;
            messagesIncluded++;

            // Check if there are depth prompts at this depth from the bottom
            const depthFromBottom = totalMsgs - 1 - i;
            if (depthMap.has(depthFromBottom)) {
                for (const dp of depthMap.get(depthFromBottom)) {
                    const dpContent = this.substituteMacros(dp.content || '', vars);
                    formattedHistory.unshift({
                        role: dp.role || 'system',
                        content: dpContent,
                    });
                    currentTokens += this.estimateTokens(dpContent);
                }
            }

            formattedHistory.unshift({
                role,
                name: author,
                content,
            });
        }

        // Combine system message + formatted chat history
        const finalMessages = [...resultMessages, ...formattedHistory];

        return {
            messages: finalMessages,
            stats: {
                systemTokens: this.estimateTokens(combinedSystemText),
                messagesIncluded,
                totalEstimatedTokens: currentTokens,
                budget,
            },
        };
    }
}

export default PromptEngine;
