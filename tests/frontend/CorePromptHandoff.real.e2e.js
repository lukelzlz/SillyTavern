import { test, expect } from '../util/core-handoff-fixture.js';
import { testSetup } from './frontent-test-utils.js';

test.use({ channel: 'chromium' });

async function finishOnboarding(page) {
    const welcome = page.locator('dialog[open]').filter({ hasText: 'Welcome to SillyTavern!' });
    if (await welcome.count()) {
        await welcome.locator('.popup-button-ok').click();
        await expect(welcome).toHaveCount(0);
    }
}

test.describe('Real Core prompt handoff transport', () => {
    test.beforeEach(async ({ page }) => {
        await testSetup.awaitST({ page });
        await finishOnboarding(page);
        await page.waitForFunction(() => window.coreBridge?.isReady === true);
    });

    test('sends browser context through authenticated Core WS and server prompt assembly', async ({ page, handoff }) => {
        const result = await page.evaluate(async (providerUrl) => {
            const script = await import('/script.js');
            const openai = await import('/scripts/openai.js');
            const { getStringHash } = await import('/scripts/utils.js');
            const { getContext } = await import('/scripts/st-context.js');
            const { eventSource, event_types } = await import('/script.js');

            script.changeMainAPI('openai');
            openai.oai_settings.stream_openai = true;
            openai.oai_settings.n = 1;
            openai.oai_settings.show_thoughts = false;
            openai.oai_settings.openai_model = 'core-handoff-e2e';
            openai.oai_settings.reverse_proxy = `${providerUrl}/v1`;
            openai.oai_settings.proxy_password = 'test-provider-key';
            openai.oai_settings.chat_completion_source = openai.chat_completion_sources.OPENAI;
            getContext().accountStorage.setItem(
                `Proxy_SkipConfirm_${getStringHash(openai.oai_settings.reverse_proxy)}`,
                'true',
            );

            const interceptionListener = (payload) => {
                payload.chat.push({ role: 'system', content: 'CORE_PROVIDER_MARKER' });
            };
            eventSource.on(event_types.CHAT_COMPLETION_PROMPT_READY, interceptionListener);

            try {
                const [, , context, mode] = await openai.prepareOpenAIMessages({
                    name1: 'Alice',
                    name2: 'Seraphina',
                    charDescription: 'A precise artificer.',
                    charPersonality: 'Curious.',
                    personaDescription: 'A wandering scholar.',
                    scenario: 'A rainy clocktower.',
                    worldInfoBefore: 'stale browser world info',
                    worldInfoAfter: 'stale browser after',
                    worldInfoEntries: [{
                        uid: 'core-e2e-world-info',
                        constant: true,
                        position: 0,
                        content: 'CORE_PROVIDER_WORLD_INFO',
                    }],
                    worldInfoOptions: { budget: 0 },
                    extensionPrompts: {},
                    bias: '',
                    type: 'normal',
                    quietPrompt: '',
                    messages: [{ role: 'user', content: 'The signal is active.' }],
                    messageExamples: [],
                    corePromptMode: 'server_context',
                }, false);

                const streamFactory = await openai.sendOpenAIRequest(
                    'normal',
                    [{ role: 'user', content: 'The signal is active.' }],
                    new AbortController().signal,
                    {
                        corePromptContext: context,
                        corePromptMode: mode,
                    },
                );
                const chunks = [];
                for await (const chunk of streamFactory()) {
                    chunks.push(chunk.text);
                }

                const providerRequest = await fetch(`${providerUrl}/control/last-request`).then(response => response.json());

                return {
                    mode,
                    capabilities: window.coreBridge.capabilities,
                    chunks,
                    providerMessages: providerRequest.request?.messages || [],
                };
            } finally {
                eventSource.removeListener(event_types.CHAT_COMPLETION_PROMPT_READY, interceptionListener);
            }
        }, handoff.providerUrl);

        expect(result.capabilities).toMatchObject({
            orchestrator: true,
            serverPromptAssembly: true,
            browserPromptHandoff: true,
            promptInterception: true,
        });
        expect(result.mode).toBe('server_context');
        expect(result.chunks).toEqual(['provider:1:1']);
        expect(result.providerMessages).toEqual(expect.arrayContaining([
            { role: 'system', content: 'CORE_PROVIDER_MARKER' },
        ]));
        expect(result.providerMessages).not.toEqual(expect.arrayContaining([
            { role: 'system', content: 'stale browser world info' },
            { role: 'system', content: 'stale browser after' },
        ]));
    });

    test('stops a response-gated Core job without disabling the network', async ({ page, handoff }) => {
        const result = await page.evaluate(async (providerUrl) => {
            const script = await import('/script.js');
            const openai = await import('/scripts/openai.js');
            const { getStringHash } = await import('/scripts/utils.js');
            const { getContext } = await import('/scripts/st-context.js');

            script.changeMainAPI('openai');
            openai.oai_settings.stream_openai = true;
            openai.oai_settings.n = 1;
            openai.oai_settings.show_thoughts = false;
            openai.oai_settings.openai_model = 'core-handoff-stop-e2e';
            openai.oai_settings.reverse_proxy = `${providerUrl}/v1`;
            openai.oai_settings.proxy_password = 'test-provider-key';
            openai.oai_settings.chat_completion_source = openai.chat_completion_sources.OPENAI;
            getContext().accountStorage.setItem(
                `Proxy_SkipConfirm_${getStringHash(openai.oai_settings.reverse_proxy)}`,
                'true',
            );

            await fetch(`${providerUrl}/control/block`, { method: 'POST' });

            const [, , context, mode] = await openai.prepareOpenAIMessages({
                name1: 'Alice',
                name2: 'Seraphina',
                charDescription: 'A precise artificer.',
                charPersonality: 'Curious.',
                personaDescription: 'A wandering scholar.',
                scenario: 'A rainy clocktower.',
                worldInfoEntries: [],
                worldInfoOptions: { budget: 0 },
                extensionPrompts: {},
                bias: '',
                type: 'normal',
                quietPrompt: '',
                messages: [{ role: 'user', content: 'Hold the provider response.' }],
                messageExamples: [],
                corePromptMode: 'server_context',
            }, false);

            let streamError = null;
            const streamPromise = (async () => {
                const streamFactory = await openai.sendOpenAIRequest(
                    'normal',
                    [{ role: 'user', content: 'Hold the provider response.' }],
                    new AbortController().signal,
                    { corePromptContext: context, corePromptMode: mode },
                );
                for await (const chunk of streamFactory()) {
                    // The provider remains response-gated until the remote stop.
                    void chunk;
                }
            })().catch((error) => {
                streamError = error?.message || String(error);
            });

            for (let attempt = 0; attempt < 100 && !window.coreBridge.activeGenerationJob?.jobId; attempt++) {
                await new Promise((resolve) => setTimeout(resolve, 20));
            }

            const jobId = window.coreBridge.activeGenerationJob?.jobId || null;
            const stopped = script.stopGeneration();
            await fetch(`${providerUrl}/control/release`, { method: 'POST' });
            await streamPromise;

            return {
                mode,
                jobId,
                stopped,
                streamError,
                activeGenerationJob: window.coreBridge.activeGenerationJob,
            };
        }, handoff.providerUrl);

        expect(result.mode).toBe('server_context');
        expect(result.jobId).toEqual(expect.any(String));
        expect(result.stopped).toBe(true);
        expect(result.streamError).toMatch(/aborted|closed|clicked stop button/i);
        expect(result.activeGenerationJob).toBeNull();
    });
});
