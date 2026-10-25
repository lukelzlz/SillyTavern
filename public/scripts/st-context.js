import {
    activateSendButtons,
    addOneMessage,
    appendMediaToMessage,
    callPopup,
    characters,
    chat,
    chat_metadata,
    CONNECT_API_MAP,
    create_save,
    deactivateSendButtons,
    event_types,
    eventSource,
    extension_prompts,
    extractMessageFromData,
    Generate,
    generateQuietPrompt,
    getCharacters,
    getCurrentChatId,
    getRequestHeaders,
    getThumbnailUrl,
    main_api,
    max_context,
    menu_type,
    messageFormatting,
    name1,
    name2,
    online_status,
    openCharacterChat,
    reloadCurrentChat,
    renameChat,
    saveChatConditional,
    saveMetadata,
    saveReply,
    saveSettingsDebounced,
    selectCharacterById,
    sendGenerationRequest,
    sendStreamingRequest,
    sendSystemMessage,
    setExtensionPrompt,
    stopGeneration,
    streamingProcessor,
    substituteParams,
    substituteParamsExtended,
    this_chid,
    updateChatMetadata,
    updateMessageBlock,
    printMessages,
    clearChat,
    unshallowCharacter,
    deleteLastMessage,
    getCharacterCardFields,
    swipe_right,
    swipe_left,
    generateRaw,
    generateRawData,
    showSwipeButtons,
    hideSwipeButtons,
    deleteMessage,
    refreshSwipeButtons,
    swipe,
    isSwipingAllowed,
    swipeState,
    ensureMessageMediaIsArray,
    getMediaDisplay,
    getMediaIndex,
    scrollChatToBottom,
    scrollOnMediaLoad,
    getOneCharacter,
    getCharacterSource,
} from '../script.js';
import {
    extension_settings,
    getExtensionManifest,
    ModuleWorkerWrapper,
    openThirdPartyExtensionMenu,
    renderExtensionTemplate,
    renderExtensionTemplateAsync,
    saveMetadataDebounced,
    UNSET_VALUE,
    writeExtensionField,
    writeExtensionFieldBulk,
} from './extensions.js';
import { groups, openGroupChat, selected_group, unshallowGroupMembers } from './group-chats.js';
import { addLocaleData, getCurrentLocale, t, translate } from './i18n.js';
import { hideLoader, showLoader } from './loader.js';
import { loader } from './action-loader.js';
import { MacrosParser } from './macros.js';
import { getChatCompletionModel, oai_settings } from './openai.js';
import { callGenericPopup, Popup, POPUP_RESULT, POPUP_TYPE } from './popup.js';
import { power_user, registerDebugFunction } from './power-user.js';
import { getPresetManager } from './preset-manager.js';
import { humanizedDateTime, isMobile, shouldSendOnEnter } from './RossAscends-mods.js';
import { ScraperManager } from './scrapers.js';
import { executeSlashCommands, executeSlashCommandsWithOptions, registerSlashCommand } from './slash-commands.js';
import { SlashCommand } from './slash-commands/SlashCommand.js';
import { ARGUMENT_TYPE, SlashCommandArgument, SlashCommandNamedArgument } from './slash-commands/SlashCommandArgument.js';
import { SlashCommandEnumValue } from './slash-commands/SlashCommandEnumValue.js';
import { SlashCommandParser } from './slash-commands/SlashCommandParser.js';
import { tag_map, tags, importTags } from './tags.js';
import { getTextGenServer, textgenerationwebui_settings } from './textgen-settings.js';
import { tokenizers, getTextTokens, getTokenCount, getTokenCountAsync, getTokenizerModel } from './tokenizers.js';
import { ToolManager } from './tool-calling.js';
import { accountStorage } from './util/AccountStorage.js';
import { timestampToMoment, uuidv4, importFromExternalUrl } from './utils.js';
import { addGlobalVariable, addLocalVariable, decrementGlobalVariable, decrementLocalVariable, deleteGlobalVariable, deleteLocalVariable, existsGlobalVariable, existsLocalVariable, getGlobalVariable, getLocalVariable, incrementGlobalVariable, incrementLocalVariable, setGlobalVariable, setLocalVariable } from './variables.js';
import { convertCharacterBook, getWorldInfoPrompt, loadWorldInfo, reloadEditor, saveWorldInfo, updateWorldInfoList, world_names } from './world-info.js';
import { ChatCompletionService, TextCompletionService } from './custom-request.js';
import { ConnectionManagerRequestService } from './extensions/shared.js';
import { updateReasoningUI, parseReasoningFromString, getReasoningTemplateByName } from './reasoning.js';
import { IGNORE_SYMBOL } from './constants.js';
import { macros } from './macros/macro-system.js';
import { MessageFormatter } from './message-formatter.js';
import { coreBridge } from './core/bridge-client.js';

/**
 * Bind the currently loaded Tavern chat to the authenticated server Core.
 * The initial sync is client-to-server so enabling the optional bridge cannot
 * replace an existing browser chat with an empty server session.
 * @param {{ bootstrap?: boolean, onSync?: Function }} [options]
 * @returns {Promise<void>}
 */
async function bindCurrentCoreState(options = {}) {
    await coreBridge.bindState({
        chat,
        chatMetadata: chat_metadata,
        characterId: this_chid,
        characterName: characters[this_chid]?.name ?? null,
        chatId: getCurrentChatId(),
        onSync: (change) => {
            // The local StreamingProcessor owns its DOM until finalization.
            // Observer tabs have no processor and need to render remote data,
            // not merely mutate their chat array in the background.
            if (!streamingProcessor && (change.type === 'snapshot'
                || (change.type === 'patch' && change.operation !== 'generationState'))) {
                printMessages()
                    .then(() => {
                        const activeJob = coreBridge.activeGenerationJob;
                        if (activeJob && remoteGenerationProjection && !streamingProcessor
                            && isRemoteGenerationForCurrentChat(activeJob)) {
                            renderRemoteGenerationText(
                                remoteGenerationProjection,
                                activeJob,
                                activeJob.fullText || '',
                            );
                        }
                    })
                    .catch(error => console.warn('[Core Bridge] Failed to render chat projection:', error));
            }
        },
        onGenerationState: (generationState) => {
            if (generationState === 'idle') {
                // Local finalization/rollback still owns its save and UI lock.
                if (!streamingProcessor) activateSendButtons();
            } else {
                deactivateSendButtons();
            }
        },
        onGenerationError: () => {
            // Do not render arbitrary provider payloads as HTML or expose details
            // from upstream credentials/URLs in a cross-tab notification.
            toastr.error(t`Generation failed. Please try again.`, t`Text generation error`, { timeOut: 10000 });
        },
        ...options,
    });

    // A refreshed tab has no local StreamingProcessor, but it can still take
    // over the server-owned stream. Start this only after the state identity is
    // bound so a stale active job cannot render into the wrong chat.
    ensureRemoteGenerationProjection(coreBridge.activeGenerationJob);
}

let coreLifecycleSyncInstalled = false;
let pendingCoreStateSync = null;
let remoteGenerationProjection = null;

function sameCoreIdentity(left, right) {
    return (left == null && right == null) || String(left) === String(right);
}

function isRemoteGenerationForCurrentChat(job) {
    const binding = coreBridge.stateBinding;
    if (!binding || !job) {
        return false;
    }

    return sameCoreIdentity(job.chatId, binding.snapshotMeta.chatId)
        && sameCoreIdentity(job.characterId, binding.snapshotMeta.characterId);
}

function getRemoteGenerationMarker(job) {
    return job?.coreGenerationJobId
        || job?.core_generation_job_id
        || `core-job-${job?.jobId}`;
}

function createRemoteGenerationMessage(job, marker) {
    return {
        name: job.characterName || characters[this_chid]?.name || name2,
        is_user: false,
        is_system: false,
        send_date: new Date(job.createdAt || Date.now()).toISOString(),
        gen_started: new Date(job.createdAt || Date.now()).toISOString(),
        gen_finished: new Date().toISOString(),
        mes: '...',
        extra: {
            core_generation_job_id: marker,
            reasoning: '',
            reasoning_duration: null,
        },
        swipe_id: 0,
        swipes: ['...'],
        swipe_info: [],
    };
}

function renderRemoteGenerationText(projection, job, text) {
    if (projection.cancelled || remoteGenerationProjection !== projection) {
        return;
    }

    const messageIndex = chat.findLastIndex((message) => message?.extra?.core_generation_job_id === projection.marker);
    if (messageIndex < 0) {
        const message = createRemoteGenerationMessage(job, projection.marker);
        message.mes = text || message.mes;
        message.swipes[0] = message.mes;
        chat.push(message);
        projection.messageId = chat.length - 1;
        addOneMessage(message, { scroll: true });
        return;
    }

    projection.messageId = messageIndex;
    const message = chat[messageIndex];
    message.mes = text || message.mes;
    message.gen_finished = new Date().toISOString();
    message.swipes ??= [message.mes];
    message.swipes[message.swipe_id ?? 0] = message.mes;
    updateMessageBlock(messageIndex, message);
}

async function refreshAndPersistRemoteGeneration() {
    await coreBridge.refreshBoundState();
    if (coreBridge.stateBinding?.generationState === 'idle') {
        // The local processor is absent after a refresh, so no native save is
        // emitted by onFinishStreaming. Persist the authoritative settled
        // snapshot once, using the same marker-based replacement semantics.
        await saveChatConditional();
    }
}

/**
 * Projects a server-owned generation into a refreshed tab without creating a
 * second provider request or saving a second assistant message. The server
 * state patch remains authoritative when the job settles.
 * @param {object|null} job
 * @returns {Promise<void>|undefined}
 */
async function followRemoteGeneration(job) {
    const projection = remoteGenerationProjection;
    if (!projection || projection.jobId !== job?.jobId) {
        return;
    }

    try {
        for await (const item of coreBridge.followGeneration(projection.jobId, { timeoutMs: 5000 })) {
            if (projection.cancelled || remoteGenerationProjection !== projection) {
                continue;
            }

            if (item.event === 'generation:token') {
                const text = typeof item.data?.fullText === 'string' ? item.data.fullText : '';
                if (!text && projection.messageId === null) {
                    continue;
                }
                renderRemoteGenerationText(projection, job, text);
            }
        }

        // Completion is settled through the server state patch. Refresh once
        // more for the race where the terminal event wins the browser socket.
        if (!projection.cancelled && remoteGenerationProjection === projection) {
            await refreshAndPersistRemoteGeneration();
        }
    } catch (error) {
        if (!projection.cancelled && remoteGenerationProjection === projection) {
            // FAILED rolls back the marker; ABORTED/COMPLETED may settle it.
            // The authoritative snapshot handles all three outcomes without a
            // local save or a duplicate MESSAGE_RECEIVED event.
            console.warn('[Core Bridge] Remote generation projection ended:', error);
            await refreshAndPersistRemoteGeneration().catch(() => {});
        }
    } finally {
        if (remoteGenerationProjection === projection) {
            remoteGenerationProjection = null;
        }
    }
}

function ensureRemoteGenerationProjection(job) {
    if (!job || !job.jobId || streamingProcessor || !isRemoteGenerationForCurrentChat(job)) {
        if (remoteGenerationProjection && (!job || !isRemoteGenerationForCurrentChat(job))) {
            remoteGenerationProjection.cancelled = true;
            remoteGenerationProjection = null;
        }
        return;
    }

    if (remoteGenerationProjection?.jobId === job.jobId) {
        return;
    }

    if (remoteGenerationProjection) {
        remoteGenerationProjection.cancelled = true;
    }

    remoteGenerationProjection = {
        jobId: job.jobId,
        marker: getRemoteGenerationMarker(job),
        messageId: null,
        cancelled: false,
    };
    followRemoteGeneration(job).catch((error) => {
        console.warn('[Core Bridge] Failed to follow refreshed generation:', error);
    });
}

function installCoreLifecycleSync() {
    if (coreLifecycleSyncInstalled) {
        return;
    }
    coreLifecycleSyncInstalled = true;

    eventSource.on('generation:active', (job) => ensureRemoteGenerationProjection(job));

    const sync = () => bindCurrentCoreState().catch((error) => {
        // The bridge is optional and disabled by default. A failed sync must
        // never interrupt the native browser chat lifecycle.
        console.warn('[Core Bridge] Failed to bind current chat state:', error);
    });

    for (const event of [event_types.APP_READY, event_types.CHAT_LOADED, event_types.CHAT_CHANGED]) {
        eventSource.on(event, sync);
    }

    const localMutationEvents = [
        event_types.MESSAGE_RECEIVED,
        event_types.MESSAGE_EDITED,
        event_types.MESSAGE_DELETED,
        event_types.MESSAGE_UPDATED,
        event_types.MESSAGE_SWIPED,
        event_types.MESSAGE_REASONING_EDITED,
        event_types.MESSAGE_REASONING_DELETED,
        event_types.MESSAGE_SWIPE_DELETED,
    ];

    const markLocalStateChanged = () => {
        if (coreBridge.isApplyingRemoteEvent) {
            return;
        }

        coreBridge.markBoundStateDirty();
        if (!coreBridge.isConnected) {
            return;
        }

        if (pendingCoreStateSync) {
            clearTimeout(pendingCoreStateSync);
        }

        pendingCoreStateSync = setTimeout(() => {
            pendingCoreStateSync = null;
            coreBridge.syncBoundState().catch((error) => {
                console.warn('[Core Bridge] Failed to sync local chat mutation:', error);
            });
        }, 50);
    };

    for (const event of localMutationEvents) {
        eventSource.on(event, markLocalStateChanged);
    }
}

export function getContext() {
    installCoreLifecycleSync();
    return {
        accountStorage,
        coreBridge,
        bindCoreState: bindCurrentCoreState,
        unbindCoreState: () => coreBridge.unbindState(),
        chat,
        characters,
        groups,
        name1,
        name2,
        characterId: this_chid,
        groupId: selected_group,
        chatId: selected_group
            ? groups.find(x => x.id == selected_group)?.chat_id
            : (characters[this_chid]?.chat),
        getCurrentChatId,
        getRequestHeaders,
        reloadCurrentChat,
        renameChat,
        saveSettingsDebounced,
        onlineStatus: online_status,
        maxContext: Number(max_context),
        chatMetadata: chat_metadata,
        saveMetadataDebounced,
        streamingProcessor,
        eventSource,
        eventTypes: event_types,
        addOneMessage,
        deleteLastMessage,
        deleteMessage,
        generate: Generate,
        sendStreamingRequest,
        sendGenerationRequest,
        stopGeneration,
        tokenizers,
        getTextTokens,
        /** @deprecated Use getTokenCountAsync instead */
        getTokenCount,
        getTokenCountAsync,
        extensionPrompts: extension_prompts,
        setExtensionPrompt,
        updateChatMetadata,
        saveChat: saveChatConditional,
        openCharacterChat,
        openGroupChat,
        saveMetadata,
        sendSystemMessage,
        activateSendButtons,
        deactivateSendButtons,
        saveReply,
        substituteParams,
        substituteParamsExtended,
        SlashCommandParser,
        SlashCommand,
        SlashCommandArgument,
        SlashCommandNamedArgument,
        SlashCommandEnumValue,
        ARGUMENT_TYPE,
        executeSlashCommandsWithOptions,
        /** @deprecated Use SlashCommandParser.addCommandObject() instead */
        registerSlashCommand,
        /** @deprecated Use executeSlashCommandWithOptions instead */
        executeSlashCommands,
        timestampToMoment,
        /** @deprecated Handlebars for extensions are no longer supported. */
        registerHelper: () => { },
        /** @deprecated Use `macros.register(name, { handler, description })` from scripts/macros/macro-system.js instead. */
        registerMacro: MacrosParser.registerMacro.bind(MacrosParser),
        /** @deprecated Use `macros.registry.unregisterMacro(name)` from scripts/macros/macro-system.js instead. */
        unregisterMacro: MacrosParser.unregisterMacro.bind(MacrosParser),
        registerFunctionTool: ToolManager.registerFunctionTool.bind(ToolManager),
        unregisterFunctionTool: ToolManager.unregisterFunctionTool.bind(ToolManager),
        isToolCallingSupported: ToolManager.isToolCallingSupported.bind(ToolManager),
        canPerformToolCalls: ToolManager.canPerformToolCalls.bind(ToolManager),
        ToolManager,
        registerDebugFunction,
        /** @deprecated Use renderExtensionTemplateAsync instead. */
        renderExtensionTemplate,
        renderExtensionTemplateAsync,
        registerDataBankScraper: ScraperManager.registerDataBankScraper.bind(ScraperManager),
        /** @deprecated Use callGenericPopup or Popup instead. */
        callPopup,
        callGenericPopup,
        /** @deprecated Use loader.show instead. */
        showLoader,
        /** @deprecated Use loader.hide instead. */
        hideLoader,
        mainApi: main_api,
        extensionSettings: extension_settings,
        ModuleWorkerWrapper,
        getTokenizerModel,
        generateQuietPrompt,
        generateRaw,
        generateRawData,
        writeExtensionField,
        writeExtensionFieldBulk,
        getThumbnailUrl,
        selectCharacterById,
        messageFormatting,
        shouldSendOnEnter,
        isMobile,
        t,
        translate,
        getCurrentLocale,
        addLocaleData,
        tags,
        tagMap: tag_map,
        menuType: menu_type,
        createCharacterData: create_save,
        /** @deprecated Legacy snake-case naming, compatibility with old extensions */
        event_types: event_types,
        Popup,
        POPUP_TYPE,
        POPUP_RESULT,
        chatCompletionSettings: oai_settings,
        textCompletionSettings: textgenerationwebui_settings,
        powerUserSettings: power_user,
        getCharacters,
        getOneCharacter,
        getCharacterCardFields,
        getCharacterSource,
        importFromExternalUrl,
        importTags,
        uuidv4,
        humanizedDateTime,
        updateMessageBlock,
        appendMediaToMessage,
        ensureMessageMediaIsArray,
        getMediaDisplay,
        getMediaIndex,
        scrollChatToBottom,
        scrollOnMediaLoad,
        macros,
        messageFormatter: MessageFormatter,
        loader,
        swipe: {
            left: swipe_left,
            right: swipe_right,
            to: swipe,
            show: showSwipeButtons,
            hide: hideSwipeButtons,
            refresh: refreshSwipeButtons,
            isAllowed: isSwipingAllowed,
            state: () => swipeState,
        },
        variables: {
            local: {
                get: getLocalVariable,
                set: setLocalVariable,
                del: deleteLocalVariable,
                add: addLocalVariable,
                inc: incrementLocalVariable,
                dec: decrementLocalVariable,
                has: existsLocalVariable,
            },
            global: {
                get: getGlobalVariable,
                set: setGlobalVariable,
                del: deleteGlobalVariable,
                add: addGlobalVariable,
                inc: incrementGlobalVariable,
                dec: decrementGlobalVariable,
                has: existsGlobalVariable,
            },
        },
        loadWorldInfo,
        saveWorldInfo,
        reloadWorldInfoEditor: reloadEditor,
        updateWorldInfoList,
        convertCharacterBook,
        getWorldInfoPrompt,
        getWorldInfoNames: () => Array.isArray(world_names) ? [...world_names] : [],
        CONNECT_API_MAP,
        getTextGenServer,
        extractMessageFromData,
        getPresetManager,
        getChatCompletionModel,
        printMessages,
        clearChat,
        ChatCompletionService,
        TextCompletionService,
        ConnectionManagerRequestService,
        updateReasoningUI,
        parseReasoningFromString,
        getReasoningTemplateByName,
        unshallowCharacter,
        unshallowGroupMembers,
        getExtensionManifest,
        openThirdPartyExtensionMenu,
        symbols: {
            ignore: IGNORE_SYMBOL,
        },
        constants: {
            unset: UNSET_VALUE,
        },
    };
}

export default getContext;
