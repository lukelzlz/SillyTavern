import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
    INJECTION_POSITION,
    ROLE_PRIORITY,
    EXCLUDE_SQUASH_WHITELIST,
    PIPELINE_STAGES,
} from './constants.js';
import { DualTrackTokenizer } from './tokenizer-adapter.js';
import { CanonicalWorldInfoScanner } from '../world-info/canonical-scanner.js';

let promptConvertersPromise = null;

/**
 * Lazy loads prompt converters with automatic config fallback.
 * @returns {Promise<any>}
 */
async function getPromptConverters() {
    if (!promptConvertersPromise) {
        promptConvertersPromise = (async () => {
            try {
                const util = await import('../../util.js');
                try {
                    const currentDir = path.dirname(fileURLToPath(import.meta.url));
                    const defaultConfigPath = path.resolve(currentDir, '../../../default/config.yaml');
                    if (!util.getConfigFilePath()) {
                        util.setConfigFilePath(defaultConfigPath);
                    }
                } catch {
                    // Ignore if already set
                }
                return await import('../../prompt-converters.js');
            } catch {
                return null;
            }
        })();
    }
    return promptConvertersPromise;
}

/**
 * Pure data prompt assembler aligned 1:1 with SillyTavern frontend's
 * 10 canonical pipeline assembly lifecycle stages.
 */
export class PromptAssembler {
    /**
     * Substitute macro variables in a template string.
     * @param {string} text
     * @param {Record<string, any>} [vars]
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

        if (vars.scenario !== undefined) result = result.replace(/\{\{scenario\}\}/gi, String(vars.scenario));
        if (vars.persona !== undefined) result = result.replace(/\{\{persona\}\}/gi, String(vars.persona));
        if (vars.description !== undefined) result = result.replace(/\{\{description\}\}/gi, String(vars.description));
        if (vars.personality !== undefined) result = result.replace(/\{\{personality\}\}/gi, String(vars.personality));
        if (vars.lastChatMessage !== undefined) result = result.replace(/\{\{lastChatMessage\}\}/gi, String(vars.lastChatMessage));

        const outlets = vars.outlets && typeof vars.outlets === 'object' ? vars.outlets : {};
        result = result.replace(/\{\{outlet::(.+?)\}\}/gi, (_, key) => {
            const value = outlets[String(key).trim()];
            return Array.isArray(value) ? value.join('\n') : (value == null ? '' : String(value));
        });

        // Unresolved standard placeholder
        result = result.replace(/<START>/gi, '---');

        return result;
    }

    /**
     * Assemble prompt messages according to the 10 canonical stages.
     *
     * @param {object} input - PromptAssemblyInput
     * @param {object} [options]
     * @param {DualTrackTokenizer} [options.tokenizer]
     * @param {Function} [options.pluginReadyHook] - CHAT_COMPLETION_PROMPT_READY hook ({ chat, dryRun })
     * @returns {Promise<object>} PromptAssemblyOutput
     */
    static async assemble(input, options = {}) {
        const timingLog = [];
        const recordTiming = (step) => {
            timingLog.push({ step, timestamp: Date.now() });
        };

        const settings = input.settings || {};
        const genControl = input.generationControl || { type: 'normal', dryRun: false };
        const charCtx = input.characterContext || {};
        let worldInfo = input.worldInfo || { worldInfoBefore: '', worldInfoAfter: '' };
        const extPrompts = input.extensionPrompts || {};
        let inputPrompts = input.prompts || [];
        const chatHistory = input.chatHistory || [];
        const messageExamples = input.messageExamples || [];
        const toolsCtx = input.toolsContext || { canPerformToolCalls: false };
        const recordedCounts = input.recordedTokenCounts || {};
        const requestedPromptOrder = Array.isArray(input.promptOrder)
            ? input.promptOrder
                .map((entry) => typeof entry === 'string' ? entry : entry?.identifier)
                .filter((identifier) => typeof identifier === 'string' && identifier.length > 0)
            : [];
        const hasExplicitPromptOrder = requestedPromptOrder.length > 0;
        const promptOrderIndex = new Map(requestedPromptOrder.map((identifier, index) => [identifier, index]));
        const isExplicitPromptEnabled = (identifier) => !hasExplicitPromptOrder || requestedPromptOrder.includes(identifier);

        const tokenizer = options.tokenizer || new DualTrackTokenizer({
            recordedTokenCounts: recordedCounts,
        });

        let worldInfoScan = null;
        let worldInfoOutlets = worldInfo.outletEntries && typeof worldInfo.outletEntries === 'object'
            ? worldInfo.outletEntries
            : {};
        if (Array.isArray(worldInfo.entries)) {
            worldInfoScan = await CanonicalWorldInfoScanner.scan({
                entries: worldInfo.entries,
                // The server contract stores chat history chronologically,
                // while World Info scans the newest messages first.
                chatMessages: [...chatHistory].reverse(),
                globalScanData: {
                    trigger: genControl.type,
                    personaDescription: charCtx.personaDescription || '',
                    characterDescription: charCtx.charDescription || '',
                    characterPersonality: charCtx.charPersonality || '',
                    scenario: charCtx.scenario || '',
                    ...(worldInfo.globalScanData || {}),
                },
                extensionPrompts: extPrompts,
                options: {
                    ...(worldInfo.options || {}),
                    ...(worldInfo.options?.budget > 0
                        ? { tokenizer: (text) => tokenizer.countSync({ content: text }) }
                        : {}),
                },
            });

            worldInfo = {
                ...worldInfo,
                worldInfoBefore: worldInfoScan.worldInfoBefore,
                worldInfoAfter: worldInfoScan.worldInfoAfter,
            };
            // Canonical server scans replace any browser-produced outlet copy,
            // just as they replace stale worldInfoBefore/worldInfoAfter text.
            worldInfoOutlets = worldInfoScan.outletEntries || {};

            const depthPrompts = (worldInfoScan.WIDepthEntries || []).flatMap((entry, index) => [{
                identifier: `worldInfoDepth-${entry.depth}-${entry.role}-${index}`,
                role: entry.role === 1 ? 'user' : entry.role === 2 ? 'assistant' : 'system',
                content: entry.entries.join('\n'),
                injection_position: INJECTION_POSITION.ABSOLUTE,
                injection_depth: entry.depth,
                injection_order: 100,
                extension: true,
            }]);
            inputPrompts = [...inputPrompts, ...depthPrompts];
        }

        const macroVars = {
            char: charCtx.name2 || 'Assistant',
            user: charCtx.name1 || 'User',
            name2: charCtx.name2 || 'Assistant',
            name1: charCtx.name1 || 'User',
            description: charCtx.charDescription || '',
            personality: charCtx.charPersonality || '',
            scenario: charCtx.scenario || '',
            persona: charCtx.personaDescription || '',
            outlets: worldInfoOutlets,
        };

        // =====================================================================
        // STAGE 1: Budget Initialization
        // =====================================================================
        recordTiming(PIPELINE_STAGES.BUDGET_INITIALIZATION);
        const maxContext = Number(settings.maxContext) || 4096;
        const maxTokens = Number(settings.maxTokens) || 500;
        const initialBudget = maxContext - maxTokens;
        let tokenBudget = initialBudget;

        const reservedTokens = {
            replyPriming: 0,
            controlPrompts: 0,
            tools: 0,
            newChatMessage: 0,
        };

        let droppedHistoryCount = 0;
        let squashedCount = 0;
        let injectedPromptsCount = 0;

        // =====================================================================
        // STAGE 2: Base Prompts Pre-Formatting
        // =====================================================================
        recordTiming(PIPELINE_STAGES.BASE_PROMPTS_PRE_FORMATTING);

        const scenarioText = charCtx.scenario && settings.scenarioFormat
            ? PromptAssembler.substituteMacros(settings.scenarioFormat, { ...macroVars, scenario: charCtx.scenario })
            : (charCtx.scenario || '');

        const personalityText = charCtx.charPersonality && settings.personalityFormat
            ? PromptAssembler.substituteMacros(settings.personalityFormat, { ...macroVars, personality: charCtx.charPersonality })
            : (charCtx.charPersonality || '');

        const impersonationText = settings.assistantImpersonation
            ? PromptAssembler.substituteMacros(settings.assistantImpersonation, macroVars)
            : '';

        const basePromptsMap = new Map();

        const addBasePrompt = (identifier, role, content, meta = {}) => {
            if (typeof content !== 'string' && !Array.isArray(content)) return;
            const textContent = typeof content === 'string' ? PromptAssembler.substituteMacros(content, macroVars) : content;
            basePromptsMap.set(identifier, {
                identifier,
                role: meta.role || role,
                content: textContent,
                name: meta.name,
                injection_position: meta.injection_position || INJECTION_POSITION.RELATIVE,
                injection_depth: meta.injection_depth,
                injection_order: meta.injection_order,
                position: meta.position,
                disabled: meta.disabled || false,
                extension: meta.extension || false,
                forbid_overrides: meta.forbid_overrides || false,
                system_prompt: meta.system_prompt ?? (role === 'system'),
            });
        };

        if (isExplicitPromptEnabled('worldInfoBefore')) addBasePrompt('worldInfoBefore', 'system', worldInfo.worldInfoBefore || '');
        if (isExplicitPromptEnabled('main')) addBasePrompt('main', 'system', 'You are {{char}}.');
        if (isExplicitPromptEnabled('worldInfoAfter')) addBasePrompt('worldInfoAfter', 'system', worldInfo.worldInfoAfter || '');
        if (isExplicitPromptEnabled('charDescription')) addBasePrompt('charDescription', 'system', charCtx.charDescription || '');
        if (isExplicitPromptEnabled('charPersonality')) addBasePrompt('charPersonality', 'system', personalityText);
        if (isExplicitPromptEnabled('scenario')) addBasePrompt('scenario', 'system', scenarioText);
        if (isExplicitPromptEnabled('personaDescription')) addBasePrompt('personaDescription', 'system', charCtx.personaDescription || '');
        addBasePrompt('impersonate', 'system', impersonationText);
        addBasePrompt('quietPrompt', 'system', genControl.quietPrompt || '');

        if (settings.groupNudgePrompt) {
            const groupNudgeContent = PromptAssembler.substituteMacros(settings.groupNudgePrompt, macroVars);
            addBasePrompt('groupNudge', 'system', groupNudgeContent);
        }

        if (genControl.bias) {
            addBasePrompt('bias', 'assistant', genControl.bias);
        }

        // Extension prompts
        const summary = extPrompts['1_memory'] || extPrompts.memory;
        if (summary && summary.value) {
            addBasePrompt('summary', summary.role === 1 ? 'user' : summary.role === 2 ? 'assistant' : 'system', summary.value, {
                position: summary.position === 1 ? 'start' : 'end',
                extension: true,
            });
        }

        const authorsNote = extPrompts['2_floating_prompt'] || extPrompts.floatingPrompt;
        if (authorsNote && authorsNote.value) {
            addBasePrompt('authorsNote', authorsNote.role === 1 ? 'user' : authorsNote.role === 2 ? 'assistant' : 'system', authorsNote.value, {
                position: authorsNote.position === 1 ? 'start' : 'end',
                extension: true,
            });
        }

        const vectorsMemory = extPrompts['3_vectors'] || extPrompts.vectorsMemory;
        if (vectorsMemory && vectorsMemory.value) {
            addBasePrompt('vectorsMemory', 'system', vectorsMemory.value, {
                position: vectorsMemory.position === 1 ? 'start' : 'end',
                extension: true,
            });
        }

        const vectorsDataBank = extPrompts['4_vectors_data_bank'] || extPrompts.vectorsDataBank;
        if (vectorsDataBank && vectorsDataBank.value) {
            addBasePrompt('vectorsDataBank', vectorsDataBank.role === 1 ? 'user' : vectorsDataBank.role === 2 ? 'assistant' : 'system', vectorsDataBank.value, {
                position: vectorsDataBank.position === 1 ? 'start' : 'end',
                extension: true,
            });
        }

        const smartContext = extPrompts.chromadb || extPrompts.smartContext;
        if (smartContext && smartContext.value) {
            addBasePrompt('smartContext', 'system', smartContext.value, {
                position: smartContext.position === 1 ? 'start' : 'end',
                extension: true,
            });
        }

        // Merge user-specified prompts configuration
        for (const userPrompt of inputPrompts) {
            if (worldInfoScan && ['worldInfoBefore', 'worldInfoAfter'].includes(userPrompt.identifier)) {
                // The browser prompt collection may still contain the last
                // client-side World Info materialization. Canonical entries
                // were scanned above, so do not let that stale copy override
                // the server-owned slot values.
                continue;
            }
            const existing = basePromptsMap.get(userPrompt.identifier);
            if (existing) {
                basePromptsMap.set(userPrompt.identifier, {
                    ...existing,
                    ...userPrompt,
                    content: userPrompt.content !== undefined ? PromptAssembler.substituteMacros(userPrompt.content, macroVars) : existing.content,
                });
            } else {
                addBasePrompt(userPrompt.identifier, userPrompt.role || 'system', userPrompt.content || '', userPrompt);
            }
        }

        // World Info AN entries are rebuilt on the server around the active
        // Author's Note prompt. The authenticated bridge path returns empty
        // browser-side AN slots, so this keeps the server as the sole owner of
        // the dynamic prefix/suffix instead of appending a stale copy.
        if (worldInfoScan && basePromptsMap.has('authorsNote')) {
            const authorsNote = basePromptsMap.get('authorsNote');
            if (typeof authorsNote.content === 'string') {
                const authorNoteParts = [
                    ...(worldInfoScan.ANBeforeEntries || []),
                    authorsNote.content,
                    ...(worldInfoScan.ANAfterEntries || []),
                ].filter((part) => typeof part === 'string' && part.trim().length > 0);
                authorsNote.content = authorNoteParts.join('\n');
            }
        }

        // Apply character overrides
        if (charCtx.systemPromptOverride && basePromptsMap.has('main')) {
            const mainPrompt = basePromptsMap.get('main');
            if (!mainPrompt.disabled && !mainPrompt.forbid_overrides) {
                mainPrompt.content = PromptAssembler.substituteMacros(charCtx.systemPromptOverride, macroVars);
            }
        }

        if (charCtx.jailbreakPromptOverride && basePromptsMap.has('jailbreak')) {
            const jbPrompt = basePromptsMap.get('jailbreak');
            if (!jbPrompt.disabled && !jbPrompt.forbid_overrides) {
                jbPrompt.content = PromptAssembler.substituteMacros(charCtx.jailbreakPromptOverride, macroVars);
            }
        }

        // =====================================================================
        // STAGE 3: Priming & Control Prompts Reservation
        // =====================================================================
        recordTiming(PIPELINE_STAGES.PRIMING_CONTROL_RESERVATION);

        // Every reply primed with <|start|>assistant<|message|> (3 tokens)
        reservedTokens.replyPriming = 3;
        tokenBudget -= reservedTokens.replyPriming;

        const controlPrompts = [];

        if (genControl.type === 'impersonate' && basePromptsMap.has('impersonate')) {
            const impPrompt = basePromptsMap.get('impersonate');
            if (impPrompt.content && !impPrompt.disabled) {
                const tokens = tokenizer.countSync(impPrompt, 'impersonate');
                controlPrompts.push({
                    role: impPrompt.role,
                    content: impPrompt.content,
                    identifier: 'impersonate',
                    tokens,
                });
            }
        }

        if (basePromptsMap.has('quietPrompt')) {
            const qPrompt = basePromptsMap.get('quietPrompt');
            if (qPrompt.content && !qPrompt.disabled) {
                let quietContent = qPrompt.content;
                if (genControl.quietImage) {
                    quietContent = [
                        { type: 'text', text: qPrompt.content },
                        { type: 'image_url', image_url: { url: genControl.quietImage, detail: 'auto' } },
                    ];
                }
                const msgObj = {
                    role: qPrompt.role,
                    content: quietContent,
                    identifier: 'quietPrompt',
                };
                const tokens = tokenizer.countSync(msgObj, 'quietPrompt');
                controlPrompts.push({ ...msgObj, tokens });
            }
        }

        for (const cp of controlPrompts) {
            reservedTokens.controlPrompts += cp.tokens;
            tokenBudget -= cp.tokens;
        }

        // =====================================================================
        // STAGE 4: Relative & System Prompts Topology Placement
        // =====================================================================
        recordTiming(PIPELINE_STAGES.RELATIVE_SYSTEM_TOPOLOGY_PLACEMENT);

        const absolutePrompts = [];
        const postHistorySlots = new Map();
        const defaultBaseOrderedSequence = [
            'worldInfoBefore',
            'main',
            'worldInfoAfter',
            'charDescription',
            'charPersonality',
            'scenario',
            'personaDescription',
        ];

        // Browser-owned prompt collections preserve the active PromptManager
        // order. Keep the historical order as a compatibility fallback for
        // existing fixtures and legacy server callers that do not provide an
        // explicit order.
        const baseOrderedSequence = requestedPromptOrder.length
            ? [...new Set([
                ...requestedPromptOrder,
                ...defaultBaseOrderedSequence,
            ])]
            : defaultBaseOrderedSequence;
        const orderedPromptIds = new Set(baseOrderedSequence);

        // Root message slots (each slot is an array of messages representing that identifier's collection)
        const rootSlots = new Map();

        for (const id of baseOrderedSequence) {
            if (basePromptsMap.has(id)) {
                const p = basePromptsMap.get(id);
                if (p.injection_position === INJECTION_POSITION.ABSOLUTE) {
                    absolutePrompts.push(p);
                } else if (!p.disabled && p.content) {
                    const tokens = tokenizer.countSync(p, id);
                    rootSlots.set(id, [{
                        role: p.role,
                        content: p.content,
                        identifier: id,
                        name: p.name,
                        tokens,
                    }]);
                }
            }
        }

        // Additional system & relative user prompts
        const systemPrompts = ['nsfw', 'jailbreak'];
        const otherRelativePrompts = [];
        for (const [id, p] of basePromptsMap.entries()) {
            if (orderedPromptIds.has(id) || id === 'impersonate' || id === 'quietPrompt') {
                continue;
            }
            if (p.injection_position === INJECTION_POSITION.ABSOLUTE) {
                absolutePrompts.push(p);
            } else if (!p.disabled && p.content) {
                otherRelativePrompts.push(p);
            }
        }

        for (const id of systemPrompts) {
            if (basePromptsMap.has(id) && !rootSlots.has(id)) {
                const p = basePromptsMap.get(id);
                if (p.injection_position !== INJECTION_POSITION.ABSOLUTE && !p.disabled && p.content) {
                    const tokens = tokenizer.countSync(p, id);
                    rootSlots.set(id, [{
                        role: p.role,
                        content: p.content,
                        identifier: id,
                        name: p.name,
                        tokens,
                    }]);
                }
            }
        }

        for (const p of otherRelativePrompts) {
            if (!systemPrompts.includes(p.identifier) && !p.position) {
                const tokens = tokenizer.countSync(p, p.identifier);
                rootSlots.set(p.identifier, [{
                    role: p.role,
                    content: p.content,
                    identifier: p.identifier,
                    name: p.name,
                    tokens,
                }]);
            }
        }

        // PromptManager's canonical default order places post-history prompts
        // (notably jailbreak) after the chatHistory marker. The browser sends
        // the active collection order in server_context, so move any relative
        // slot declared after chatHistory out of the root topology while
        // preserving the legacy layout when no explicit order is supplied.
        if (hasExplicitPromptOrder && promptOrderIndex.has('chatHistory')) {
            const chatHistoryIndex = promptOrderIndex.get('chatHistory');
            for (const [identifier, slotMessages] of [...rootSlots.entries()]) {
                const promptIndex = promptOrderIndex.get(identifier);
                if (promptIndex !== undefined && promptIndex > chatHistoryIndex) {
                    rootSlots.delete(identifier);
                    postHistorySlots.set(identifier, slotMessages);
                }
            }
        }

        // Relative injection into main (injectToMain)
        const relativeInjections = otherRelativePrompts.filter(p => p.position === 'start' || p.position === 'end');
        for (const relPrompt of relativeInjections) {
            if (rootSlots.has('main')) {
                const mainSlot = rootSlots.get('main');
                const tokens = tokenizer.countSync(relPrompt, relPrompt.identifier);
                const relMsg = {
                    role: relPrompt.role,
                    content: relPrompt.content,
                    identifier: relPrompt.identifier,
                    name: relPrompt.name,
                    tokens,
                };
                if (relPrompt.position === 'start') {
                    mainSlot.unshift(relMsg);
                } else {
                    mainSlot.push(relMsg);
                }
            } else {
                // Main is an absolute prompt: downgrade relative prompt to absolute injection
                const indexOfMain = absolutePrompts.findIndex(p => p.identifier === 'main');
                if (indexOfMain >= 0) {
                    const mainAbs = absolutePrompts[indexOfMain];
                    const downgraded = {
                        ...relPrompt,
                        role: mainAbs.role,
                        injection_position: mainAbs.injection_position,
                        injection_depth: mainAbs.injection_depth,
                        injection_order: mainAbs.injection_order,
                    };
                    const insertIdx = relPrompt.position === 'end' ? indexOfMain + 1 : indexOfMain;
                    absolutePrompts.splice(insertIdx, 0, downgraded);
                }
            }
        }

        // Deduct budget for all root slot messages
        for (const [, msgs] of rootSlots.entries()) {
            for (const msg of msgs) {
                tokenBudget -= msg.tokens;
            }
        }
        for (const [, msgs] of postHistorySlots.entries()) {
            for (const msg of msgs) {
                tokenBudget -= msg.tokens;
            }
        }

        // =====================================================================
        // STAGE 5: Tool Schema Reservation
        // =====================================================================
        recordTiming(PIPELINE_STAGES.TOOL_SCHEMA_RESERVATION);

        if (toolsCtx.canPerformToolCalls) {
            const toolData = toolsCtx.toolsSchema || {};
            const toolMsg = { role: 'user', content: JSON.stringify(toolData) };
            const toolTokens = tokenizer.countSync(toolMsg, 'toolsSchema');
            reservedTokens.tools = toolTokens;
            tokenBudget -= toolTokens;
        }

        // =====================================================================
        // STAGE 6: Continue Prefill / Nudge Prompt Handling
        // =====================================================================
        recordTiming(PIPELINE_STAGES.CONTINUE_PREFILL_NUDGE_HANDLING);

        // Frontend oaiMessages has newest message at index 0 (reverse chronological)
        // when entering continue prefill and populationInjectionPrompts.
        const workingHistory = chatHistory.map(m => structuredClone(m)).reverse();
        let continueNudgeCollection = null;

        if (genControl.type === 'continue') {
            if (settings.continuePrefill && workingHistory.length > 0) {
                const chatMessage = workingHistory.shift();
                const isAssistant = chatMessage.role === 'assistant';
                const supportsAssistantPrefill = settings.source === 'claude';
                const assistantPrefill = isAssistant && supportsAssistantPrefill && settings.assistantPrefill
                    ? PromptAssembler.substituteMacros(settings.assistantPrefill, macroVars)
                    : '';
                const messageContent = [assistantPrefill, chatMessage.content].filter(Boolean).join('\n\n');
                const continueMessage = {
                    role: chatMessage.role,
                    content: messageContent,
                    identifier: 'continuePrefill',
                    name: settings.namesBehavior === 'completion' ? chatMessage.name : undefined,
                };
                const tokens = tokenizer.countSync(continueMessage, 'continuePrefill');
                continueMessage.tokens = tokens;
                controlPrompts.push(continueMessage);
                reservedTokens.controlPrompts += tokens;
                tokenBudget -= tokens;
            } else if (!settings.continuePrefill && genControl.cyclePrompt) {
                const nudgeText = PromptAssembler.substituteMacros(
                    settings.continueNudgePrompt || '[Continue: {{lastChatMessage}}]',
                    { ...macroVars, lastChatMessage: String(genControl.cyclePrompt).trim() },
                );
                const nudgePrompt = {
                    role: 'system',
                    content: nudgeText,
                    identifier: 'continueNudge',
                };
                const nudgeTokens = tokenizer.countSync(nudgePrompt, 'continueNudge');
                nudgePrompt.tokens = nudgeTokens;

                continueNudgeCollection = [nudgePrompt];
                tokenBudget -= nudgeTokens;
            }
        }

        // =====================================================================
        // STAGE 7: Absolute Depth Layered Injection
        // =====================================================================
        recordTiming(PIPELINE_STAGES.ABSOLUTE_DEPTH_LAYERED_INJECTION);

        let messages = [...workingHistory];
        let totalInsertedMessages = 0;
        const maxDepth = Math.max(100, ...absolutePrompts.map(p => Number(p.injection_depth) || 0));

        for (let i = 0; i <= maxDepth; i++) {
            const depthPrompts = absolutePrompts.filter(p => Number(p.injection_depth) === i && p.content && !p.disabled);
            if (!depthPrompts.length) continue;

            const orderGroups = {};
            for (const p of depthPrompts) {
                const order = p.injection_order ?? 100;
                if (!orderGroups[order]) orderGroups[order] = [];
                orderGroups[order].push(p);
            }

            const orders = Object.keys(orderGroups).sort((a, b) => Number(b) - Number(a));
            const roleMessages = [];

            for (const order of orders) {
                const orderPrompts = orderGroups[order];
                for (const role of ROLE_PRIORITY) {
                    const matching = orderPrompts.filter(p => p.role === role);
                    if (!matching.length) continue;
                    const jointPrompt = matching.map(p => p.content.trim()).filter(Boolean).join('\n');
                    if (jointPrompt) {
                        const injectedMsg = {
                            role,
                            content: jointPrompt,
                            injected: true,
                            identifier: `injected_depth_${i}_order_${order}_${role}`,
                        };
                        const tokens = tokenizer.countSync(injectedMsg, injectedMsg.identifier);
                        injectedMsg.tokens = tokens;
                        roleMessages.push(injectedMsg);
                    }
                }
            }

            if (roleMessages.length) {
                const injectIdx = i + totalInsertedMessages;
                messages.splice(injectIdx, 0, ...roleMessages);
                totalInsertedMessages += roleMessages.length;
                injectedPromptsCount += roleMessages.length;
            }
        }

        messages = messages.reverse();

        // =====================================================================
        // STAGE 8: Reverse Sliding Window Truncation
        // =====================================================================
        recordTiming(PIPELINE_STAGES.REVERSE_SLIDING_WINDOW_TRUNCATION);

        const dialogueExamplesList = [];
        const populateExamples = () => {
            if (hasExplicitPromptOrder && !requestedPromptOrder.includes('dialogueExamples')) return;

            const worldInfoExamples = Array.isArray(worldInfoScan?.EMEntries)
                ? worldInfoScan.EMEntries
                : [];
            if ((!Array.isArray(messageExamples) || !messageExamples.length) && !worldInfoExamples.length) return;

            const addWorldInfoExamples = (anchor) => {
                for (let index = 0; index < worldInfoExamples.length; index++) {
                    const example = worldInfoExamples[index];
                    const isBefore = example?.position === 0 || example?.position === 'before';
                    const isAfter = example?.position === 1 || example?.position === 'after';
                    if ((anchor === 'before' && !isBefore) || (anchor === 'after' && !isAfter)) continue;

                    const content = PromptAssembler.substituteMacros(example?.content || '', macroVars);
                    if (!content) continue;

                    const message = {
                        role: 'system',
                        content,
                        identifier: `worldInfoExample-${anchor}-${index}`,
                    };
                    const tokens = tokenizer.countSync(message, message.identifier);
                    message.tokens = tokens;
                    if (tokenBudget - tokens < 0) continue;

                    tokenBudget -= tokens;
                    dialogueExamplesList.push(message);
                }
            };

            addWorldInfoExamples('before');

            const newExampleChatContent = PromptAssembler.substituteMacros(
                settings.newExampleChatPrompt || settings.newChatPrompt || '---',
                macroVars,
            );
            const newExampleChat = {
                role: 'system',
                content: newExampleChatContent,
                identifier: 'newChat',
            };
            const newExTokens = tokenizer.countSync(newExampleChat, 'newChat');
            newExampleChat.tokens = newExTokens;

            for (let dIdx = 0; dIdx < messageExamples.length; dIdx++) {
                const dialogue = messageExamples[dIdx];
                const chatMessages = [];
                let blockTokens = newExTokens;

                for (let pIdx = 0; pIdx < dialogue.length; pIdx++) {
                    const prompt = dialogue[pIdx];
                    const msg = {
                        role: 'system',
                        content: prompt.content || '',
                        name: prompt.name,
                        identifier: `dialogueExamples ${dIdx}-${pIdx}`,
                    };
                    const tokens = tokenizer.countSync(msg, msg.identifier);
                    msg.tokens = tokens;
                    chatMessages.push(msg);
                    blockTokens += tokens;
                }

                if (tokenBudget - blockTokens >= 0) {
                    tokenBudget -= blockTokens;
                    dialogueExamplesList.push(newExampleChat);
                    dialogueExamplesList.push(...chatMessages);
                } else {
                    break;
                }
            }

            addWorldInfoExamples('after');
        };

        const acceptedHistoryMessages = [];
        const populateChatHistoryInternal = () => {
            const isGroup = Boolean(charCtx.selectedGroup);
            const newChatTemplate = isGroup
                ? (settings.newGroupChatPrompt || '--- Group Chat Begins ---')
                : (settings.newChatPrompt || '--- Chat Begins ---');
            const newChatContent = PromptAssembler.substituteMacros(newChatTemplate, macroVars);
            const newChatMessage = {
                role: 'system',
                content: newChatContent,
                identifier: 'newMainChat',
            };
            const newChatTokens = tokenizer.countSync(newChatMessage, 'newMainChat');
            newChatMessage.tokens = newChatTokens;

            reservedTokens.newChatMessage = newChatTokens;
            tokenBudget -= newChatTokens;

            let groupNudgeMsg = null;
            if (isGroup && basePromptsMap.has('groupNudge') && genControl.type !== 'impersonate') {
                const gnPrompt = basePromptsMap.get('groupNudge');
                if (gnPrompt.content && !gnPrompt.disabled) {
                    const gnTokens = tokenizer.countSync(gnPrompt, 'groupNudge');
                    groupNudgeMsg = {
                        role: gnPrompt.role,
                        content: gnPrompt.content,
                        identifier: 'groupNudge',
                        tokens: gnTokens,
                    };
                    tokenBudget -= gnTokens;
                }
            }

            const chatPool = [...messages].reverse();

            for (let idx = 0; idx < chatPool.length; idx++) {
                const chatItem = chatPool[idx];

                if (Array.isArray(chatItem.invocations) && chatItem.invocations.length > 0) {
                    const toolCallMsg = {
                        role: chatItem.role || 'assistant',
                        content: chatItem.content || null,
                        identifier: `toolCall-${chatItem.identifier || idx}`,
                        tool_calls: chatItem.invocations.map(inv => ({
                            id: inv.id,
                            type: 'function',
                            function: {
                                name: inv.name,
                                arguments: inv.parameters,
                            },
                            ...(inv.signature ? { signature: inv.signature } : {}),
                        })),
                        ...(chatItem.signature ? { signature: chatItem.signature } : {}),
                        ...(chatItem.reasoning ? { reasoning: chatItem.reasoning } : {}),
                    };

                    const toolResultMsgs = chatItem.invocations.map(inv => ({
                        role: 'tool',
                        content: inv.result || '[No content]',
                        identifier: inv.id,
                        tool_call_id: inv.id,
                    }));

                    const toolCallTokens = tokenizer.countSync(toolCallMsg, toolCallMsg.identifier);
                    toolCallMsg.tokens = toolCallTokens;

                    let totalInvocationsTokens = toolCallTokens;
                    for (const resMsg of toolResultMsgs) {
                        const resTokens = tokenizer.countSync(resMsg, resMsg.tool_call_id);
                        resMsg.tokens = resTokens;
                        totalInvocationsTokens += resTokens;
                    }

                    if (tokenBudget - totalInvocationsTokens >= 0) {
                        tokenBudget -= totalInvocationsTokens;
                        acceptedHistoryMessages.unshift(...toolResultMsgs);
                        acceptedHistoryMessages.unshift(toolCallMsg);
                    } else {
                        droppedHistoryCount += (chatPool.length - idx);
                        break;
                    }
                    continue;
                }

                let messageContent = chatItem.content;
                if (Array.isArray(chatItem.media) && chatItem.media.length > 0) {
                    const mediaItems = chatItem.mediaDisplay === 'gallery' && chatItem.mediaIndex !== undefined
                        ? [chatItem.media[chatItem.mediaIndex]]
                        : chatItem.media;

                    const formattedContent = [];
                    if (typeof chatItem.content === 'string' && chatItem.content.length > 0) {
                        formattedContent.push({ type: 'text', text: chatItem.content });
                    }
                    for (const m of mediaItems) {
                        if (m && m.url) {
                            formattedContent.push({
                                type: 'image_url',
                                image_url: { url: m.url, detail: 'auto' },
                            });
                        }
                    }
                    messageContent = formattedContent;
                }

                const msgObj = {
                    role: chatItem.role,
                    content: messageContent,
                    identifier: chatItem.identifier || `chatHistory-${chatPool.length - idx}`,
                    ...(chatItem.name ? { name: chatItem.name } : {}),
                    ...(chatItem.signature ? { signature: chatItem.signature } : {}),
                    ...(chatItem.reasoning ? { reasoning: chatItem.reasoning } : {}),
                };

                const tokens = tokenizer.countSync(msgObj, msgObj.identifier);
                msgObj.tokens = tokens;

                if (tokenBudget - tokens >= 0) {
                    tokenBudget -= tokens;
                    acceptedHistoryMessages.unshift(msgObj);
                } else {
                    droppedHistoryCount += (chatPool.length - idx);
                    break;
                }
            }

            tokenBudget += newChatTokens;
            acceptedHistoryMessages.unshift(newChatMessage);
            tokenBudget -= newChatTokens;

            if (groupNudgeMsg) {
                tokenBudget += groupNudgeMsg.tokens;
                acceptedHistoryMessages.push(groupNudgeMsg);
                tokenBudget -= groupNudgeMsg.tokens;
            }

            if (continueNudgeCollection) {
                for (const cn of continueNudgeCollection) {
                    tokenBudget += cn.tokens;
                    acceptedHistoryMessages.push(cn);
                    tokenBudget -= cn.tokens;
                }
            }
        };

        if (settings.pinExamples) {
            populateExamples();
            populateChatHistoryInternal();
        } else {
            populateChatHistoryInternal();
            populateExamples();
        }

        // Free control prompts budget and append to chat
        const finalizedControlPrompts = [];
        for (const cp of controlPrompts) {
            tokenBudget += cp.tokens;
            finalizedControlPrompts.push(cp);
            tokenBudget -= cp.tokens;
        }

        // Flatten all assembled messages in topological order:
        // Root system & relative slots -> Dialogue examples -> Chat history -> Control prompts
        const allMessages = [];
        for (const [, msgs] of rootSlots.entries()) {
            allMessages.push(...msgs);
        }
        allMessages.push(...dialogueExamplesList);
        allMessages.push(...acceptedHistoryMessages);
        const orderedPostHistorySlots = [...postHistorySlots.entries()]
            .sort(([left], [right]) => (promptOrderIndex.get(left) ?? 0) - (promptOrderIndex.get(right) ?? 0));
        for (const [, msgs] of orderedPostHistorySlots) {
            allMessages.push(...msgs);
        }
        allMessages.push(...finalizedControlPrompts);

        // =====================================================================
        // STAGE 9: Squashed System Messages with Whitelist Safeguards
        // =====================================================================
        recordTiming(PIPELINE_STAGES.SQUASHED_SYSTEM_MESSAGES);

        let processedMessages = allMessages;

        if (settings.squashSystemMessages && !genControl.dryRun) {
            const squashed = [];
            let lastMessage = null;

            const shouldSquash = (m) => {
                return (
                    m.role === 'system' &&
                    !m.name &&
                    !EXCLUDE_SQUASH_WHITELIST.includes(m.identifier) &&
                    typeof m.content === 'string'
                );
            };

            for (const msg of allMessages) {
                if (msg.role === 'system' && (!msg.content || (typeof msg.content === 'string' && !msg.content.trim()))) {
                    continue;
                }

                if (shouldSquash(msg)) {
                    if (lastMessage && shouldSquash(lastMessage)) {
                        lastMessage.content += '\n' + msg.content;
                        lastMessage.tokens = tokenizer.countSync(lastMessage, lastMessage.identifier);
                        squashedCount++;
                    } else {
                        squashed.push(msg);
                        lastMessage = msg;
                    }
                } else {
                    squashed.push(msg);
                    lastMessage = msg;
                }
            }
            processedMessages = squashed;
        }

        // Strip internal properties for final output
        const finalChat = processedMessages.map(item => {
            const msg = {
                role: item.role,
                content: item.content,
                ...(item.name ? { name: item.name } : {}),
                ...(item.tool_calls ? { tool_calls: item.tool_calls } : {}),
                ...(item.tool_call_id ? { tool_call_id: item.tool_call_id } : {}),
                ...(item.signature ? { signature: item.signature } : {}),
                ...(item.reasoning ? { reasoning: item.reasoning } : {}),
            };
            return msg;
        });

        // =====================================================================
        // STAGE 10: Plugin Ready Hook Emission & Dialect Transformation
        // =====================================================================
        recordTiming(PIPELINE_STAGES.PLUGIN_READY_HOOK_TRANSFORMATION);

        // In-place mutation protection for CHAT_COMPLETION_PROMPT_READY
        if (typeof options.pluginReadyHook === 'function') {
            await options.pluginReadyHook({
                chat: finalChat,
                dryRun: Boolean(genControl.dryRun),
            });
        }

        // Provider dialect transforms
        let providerTransforms = undefined;
        if (settings.source === 'claude' || settings.source === 'google' || settings.source === 'makersuite') {
            const converters = await getPromptConverters();
            if (converters) {
                if (settings.source === 'claude') {
                    try {
                        const chatClone = structuredClone(finalChat);
                        providerTransforms = {
                            claude: converters.convertClaudeMessages(chatClone, settings.assistantPrefill || '', true, toolsCtx.canPerformToolCalls, {}),
                        };
                    } catch (err) {
                        // Ignore provider transform error during offline testing
                    }
                } else if (settings.source === 'google' || settings.source === 'makersuite') {
                    try {
                        const chatClone = structuredClone(finalChat);
                        providerTransforms = {
                            gemini: converters.convertGooglePrompt(chatClone, settings.model || 'gemini-1.5-pro', true, {}),
                        };
                    } catch (err) {
                        // Ignore provider transform error during offline testing
                    }
                }
            }
        }

        const tokensUsed = initialBudget - tokenBudget;

        return {
            chat: finalChat,
            metadata: {
                totalBudget: initialBudget,
                tokensUsed,
                remainingTokens: tokenBudget,
                reservedTokens,
                droppedHistoryCount,
                squashedCount,
                injectedPromptsCount,
                timingLog,
                ...(worldInfoScan ? {
                    worldInfoScan: {
                        activatedEntryUids: worldInfoScan.activatedEntryUids,
                        debugTrace: worldInfoScan.debugTrace,
                    },
                } : {}),
            },
            ...(providerTransforms ? { providerTransforms } : {}),
        };
    }
}
