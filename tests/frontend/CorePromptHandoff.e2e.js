import { test, expect } from '@playwright/test';
import { testSetup } from './frontent-test-utils.js';

test.use({ channel: 'chromium' });

test.describe('Core prompt handoff ownership', () => {
    test.beforeEach(testSetup.awaitST);

    test('prepareOpenAIMessages skips local assembly for server ownership and falls back once', async ({ page }) => {
        const result = await page.evaluate(async () => {
            const openai = await import('/scripts/openai.js');
            const { eventSource, event_types } = await import('/script.js');
            const promptReadyEvent = event_types.CHAT_COMPLETION_PROMPT_READY;

            const callPrepare = async (overrides = {}) => {
                let promptReadyCount = 0;
                const listener = (payload) => {
                    promptReadyCount++;
                    if (overrides.mutatePrompt) {
                        payload.chat.push({ role: 'system', content: 'CLIENT_HOOK_MARKER' });
                    }
                };

                eventSource.on(promptReadyEvent, listener);
                try {
                    const [chat, counts, context, mode] = await openai.prepareOpenAIMessages({
                        name1: 'Alice',
                        name2: 'Seraphina',
                        charDescription: 'A precise artificer.',
                        charPersonality: 'Curious.',
                        personaDescription: 'A wandering scholar.',
                        scenario: 'A rainy clocktower.',
                        worldInfoBefore: 'stale browser before',
                        worldInfoAfter: 'stale browser after',
                        worldInfoEntries: [{
                            uid: 'browser-handoff-world-info',
                            constant: true,
                            position: 0,
                            content: 'Canonical server lore.',
                        }],
                        worldInfoOptions: { budget: 0 },
                        extensionPrompts: {},
                        bias: '',
                        type: 'normal',
                        quietPrompt: '',
                        messages: [
                            { role: 'user', content: 'Newest browser message.' },
                            { role: 'assistant', content: 'Older browser reply.' },
                        ],
                        messageExamples: [],
                        corePromptMode: overrides.corePromptMode || 'server_context',
                        ...(overrides.jailbreakPromptOverride
                            ? { jailbreakPromptOverride: overrides.jailbreakPromptOverride }
                            : {}),
                    }, false);

                    return {
                        chat,
                        counts,
                        context,
                        mode,
                        promptReadyCount,
                    };
                } finally {
                    eventSource.removeListener(promptReadyEvent, listener);
                }
            };

            const serverOwned = await callPrepare();
            const unsafeServerRequest = await callPrepare({
                jailbreakPromptOverride: 'Unsafe post-history prompt must stay client-owned.',
                mutatePrompt: true,
            });
            const explicitClientOwned = await callPrepare({
                corePromptMode: 'client_final',
                mutatePrompt: true,
            });

            const bridge = window.coreBridge;
            const originalFetch = window.fetch;
            const originalStartGenerationStream = bridge.startGenerationStream;
            const originalReady = bridge.isReady;
            const originalCapabilities = bridge.capabilities;
            const originalShowThoughts = openai.oai_settings.show_thoughts;
            let fallbackHookCount = 0;
            let fallbackFetchBody = null;
            const fallbackListener = (payload) => {
                fallbackHookCount++;
                payload.chat.push({ role: 'system', content: 'FALLBACK_HOOK_MARKER' });
            };

            openai.oai_settings.show_thoughts = false;
            bridge.isReady = true;
            bridge.capabilities = {
                orchestrator: true,
                browserPromptHandoff: true,
                serverPromptAssembly: true,
            };
            bridge.startGenerationStream = async () => {
                throw Object.assign(new Error('Core transport unavailable'), { code: 'CORE_BRIDGE_UNAVAILABLE' });
            };
            window.fetch = async (_url, options) => {
                fallbackFetchBody = JSON.parse(options.body);
                const stream = new ReadableStream({
                    start(controller) {
                        controller.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"content":"fallback"}}]}\n\n'));
                        controller.enqueue(new TextEncoder().encode('data: [DONE]\n\n'));
                        controller.close();
                    },
                });
                return new Response(stream, { status: 200 });
            };
            eventSource.on(promptReadyEvent, fallbackListener);

            let fallbackChunks;
            try {
                const streamFactory = await openai.sendOpenAIRequest(
                    'normal',
                    [{ role: 'user', content: 'Fallback message.' }],
                    new AbortController().signal,
                    {
                        corePromptMode: 'server_context',
                        corePromptContext: serverOwned.context,
                    },
                );
                fallbackChunks = [];
                for await (const chunk of streamFactory()) {
                    fallbackChunks.push(chunk);
                }
            } finally {
                eventSource.removeListener(promptReadyEvent, fallbackListener);
                window.fetch = originalFetch;
                bridge.startGenerationStream = originalStartGenerationStream;
                bridge.isReady = originalReady;
                bridge.capabilities = originalCapabilities;
                openai.oai_settings.show_thoughts = originalShowThoughts;
            }

            return {
                serverOwned,
                unsafeServerRequest,
                explicitClientOwned,
                fallbackTransport: {
                    hookCount: fallbackHookCount,
                    fetchBody: fallbackFetchBody,
                    chunks: fallbackChunks,
                },
            };
        });

        expect(result.serverOwned.mode).toBe('server_context');
        expect(result.serverOwned.chat).toEqual([]);
        expect(result.serverOwned.promptReadyCount).toBe(0);
        expect(result.serverOwned.context.chatHistory).toEqual([
            { role: 'assistant', content: 'Older browser reply.' },
            { role: 'user', content: 'Newest browser message.' },
        ]);
        expect(result.serverOwned.context.worldInfo.entries).toEqual([
            expect.objectContaining({ content: 'Canonical server lore.' }),
        ]);

        expect(result.unsafeServerRequest.mode).toBe('client_final');
        expect(result.unsafeServerRequest.promptReadyCount).toBe(1);
        expect(result.unsafeServerRequest.chat).toEqual(expect.arrayContaining([
            { role: 'system', content: 'CLIENT_HOOK_MARKER' },
        ]));

        expect(result.explicitClientOwned.mode).toBe('client_final');
        expect(result.explicitClientOwned.promptReadyCount).toBe(1);
        expect(result.explicitClientOwned.chat).toEqual(expect.arrayContaining([
            { role: 'system', content: 'CLIENT_HOOK_MARKER' },
        ]));

        expect(result.fallbackTransport.hookCount).toBe(1);
        expect(result.fallbackTransport.chunks).toEqual([
            expect.objectContaining({ text: 'fallback' }),
        ]);
        expect(result.fallbackTransport.fetchBody).toEqual(expect.objectContaining({
            messages: expect.arrayContaining([
                { role: 'system', content: 'FALLBACK_HOOK_MARKER' },
            ]),
        }));
        expect(result.fallbackTransport.fetchBody).not.toHaveProperty('core_generation_job_id');
        expect(result.fallbackTransport.fetchBody).not.toHaveProperty('core_request_id');
        expect(result.fallbackTransport.fetchBody).not.toHaveProperty('core_prompt_mode');
        expect(result.fallbackTransport.fetchBody).not.toHaveProperty('core_prompt_context');
        expect(result.fallbackTransport.fetchBody).not.toHaveProperty('core_prompt_interception');
        expect(result.fallbackTransport.fetchBody).not.toHaveProperty('core_prompt_ready_handled');
    });

    test('generation stream retries catch-up when handshake wins the initial reconnect race', async ({ page }) => {
        const result = await page.evaluate(async () => {
            const { BridgeClient } = await import('/scripts/core/bridge-client.js');
            const client = new BridgeClient();
            client.connect = async () => { };
            client.isReady = true;

            const reconnectCalls = [];
            let reconnectAttempt = 0;
            client.getGenerationJob = async () => ({
                job: {
                    status: 'STREAMING',
                    fullText: 'A',
                    lastSeq: 1,
                },
            });
            client.reconnectGeneration = async (_jobId, lastSeq) => {
                reconnectCalls.push(lastSeq);
                if (reconnectAttempt++ === 0) {
                    throw new Error('simulated reconnect race');
                }
                return {
                    status: 'COMPLETED',
                    hasMissedChunks: true,
                    fullText: 'AB',
                    lastSeq: 2,
                    chunks: [],
                };
            };

            const stream = client.followGeneration('job-race', { timeoutMs: 1000 });
            const items = [];
            for await (const item of stream) {
                items.push({ event: item.event, fullText: item.data?.fullText });
            }

            return { reconnectCalls, items };
        });

        expect(result.reconnectCalls).toEqual([0, 1]);
        expect(result.items).toEqual([
            { event: 'generation:token', fullText: 'A' },
            { event: 'generation:token', fullText: 'AB' },
        ]);
    });
});
