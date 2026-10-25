import fs from 'node:fs/promises';
import path from 'node:path';
import { test, expect } from '../util/core-handoff-fixture.js';
import { testSetup } from './frontent-test-utils.js';

const reply = 'A controlled reply completes exactly once.';

test.afterEach(async ({ page, request, handoff }) => {
    // Cleanup must neither hang a later test nor hide the original assertion.
    if (!page.isClosed()) {
        await page.evaluate(() => window.coreBridge?.stopActiveGeneration('Test cleanup')).catch(() => {});
    }
    await request.post(`${handoff.providerUrl}/control/release`).catch(() => {});
    await request.post(`${handoff.providerUrl}/control/scenario`, { data: { mode: 'markers' } }).catch(() => {});
});

async function openChat(page, providerUrl, chatName) {
    await testSetup.awaitST({ page });
    const welcome = page.locator('dialog[open]').filter({ hasText: 'Welcome to SillyTavern!' });
    if (await welcome.count()) await welcome.locator('.popup-button-ok').click();
    await page.waitForFunction(() => window.coreBridge?.isReady === true);
    // Only seed configuration here. Generation must enter through the real send button.
    return page.evaluate(async ({ providerUrl, chatName }) => {
        const script = await import('/script.js');
        const openai = await import('/scripts/openai.js');
        const wi = await import('/scripts/world-info.js');
        const { getStringHash } = await import('/scripts/utils.js');
        const { getContext } = await import('/scripts/st-context.js');
        const created = await fetch('/api/characters/create', {
            method: 'POST', headers: script.getRequestHeaders(),
            body: JSON.stringify({ ch_name: chatName, description: 'A precise test assistant.', first_mes: 'Ready.' }),
        });
        if (!created.ok) throw new Error(`Character seed failed: ${created.status}`);
        const avatar = await created.text();
        await script.getCharacters();
        await script.selectCharacterById(script.characters.findIndex(character => character.avatar === avatar));
        await script.openCharacterChat(chatName);
        script.changeMainAPI('openai');
        Object.assign(openai.oai_settings, {
            stream_openai: true, n: 1, show_thoughts: false,
            openai_model: 'gpt-4o', reverse_proxy: `${providerUrl}/v1`,
            proxy_password: 'test-only', chat_completion_source: openai.chat_completion_sources.OPENAI,
        });
        getContext().accountStorage.setItem(`Proxy_SkipConfirm_${getStringHash(openai.oai_settings.reverse_proxy)}`, 'true');
        script.setOnlineStatus('test-provider');
        const world = `${chatName}-lore`;
        await wi.createNewWorldInfo(world);
        await wi.saveWorldInfo(world, { entries: { 0: {
            uid: 0, key: [], keysecondary: [], constant: true, disable: false,
            content: 'CORE_PROVIDER_WORLD_INFO', position: 0, order: 100,
            probability: 100, useProbability: true,
        } } }, true);
        script.chat_metadata[wi.METADATA_KEY] = world;
        await script.saveChatConditional();
        window.coreBridge.markBoundStateDirty();
        await window.coreBridge.syncBoundState();
        script.eventSource.on(script.event_types.CHAT_COMPLETION_PROMPT_READY, payload => {
            payload.chat.push({ role: 'system', content: 'CORE_PROVIDER_MARKER' });
        });
        window.uiJobs = [];
        script.eventSource.on('generation:started', data => window.uiJobs.push(data.jobId));
        return { avatar: script.characters[script.this_chid].avatar, chatName };
    }, { providerUrl, chatName });
}

async function send(page, text) {
    await page.locator('#send_textarea').fill(text);
    await page.locator('#send_but').click();
}

async function readSavedChat(page, identity) {
    return page.evaluate(async ({ avatar, chatName }) => {
        const { getRequestHeaders } = await import('/script.js');
        const response = await fetch('/api/chats/get', {
            method: 'POST', headers: getRequestHeaders(),
            body: JSON.stringify({ avatar_url: avatar, file_name: chatName }),
        });
        if (!response.ok) throw new Error(`Chat read failed: ${response.status}`);
        return response.json();
    }, identity);
}

test('real send UI persists exactly one server-owned reply', async ({ page, request, handoff }) => {
    const frames = [];
    page.on('websocket', socket => socket.on('framesent', frame => frames.push(JSON.parse(String(frame.payload)))));
    await request.post(`${handoff.providerUrl}/control/scenario`, { data: { mode: 'success', pauseAfterFirst: true } });
    const identity = await openChat(page, handoff.providerUrl, `ui-success-${Date.now()}`);
    await send(page, 'Please answer once.');
    await expect(page.locator('#chat .mes_text').last()).toHaveText('A controlled reply');
    await expect(page.locator('#mes_stop')).toBeVisible();
    await request.post(`${handoff.providerUrl}/control/release`);
    await expect(page.locator('#chat .mes_text').last()).toHaveText(reply);
    await expect(page.locator('#mes_stop')).toBeHidden();
    await expect.poll(() => page.evaluate(() => window.uiJobs.length)).toBe(1);
    const state = await page.evaluate(async () => ({
        chat: window.SillyTavern.getContext().chat,
        snapshot: await window.coreBridge.getStateSnapshot(),
        job: await window.coreBridge.getGenerationJob(window.uiJobs[0]),
    }));
    expect(state.job.job.status).toBe('COMPLETED');
    expect(frames.filter(frame => frame.type === 'generate:start')).toHaveLength(1);
    expect(frames.find(frame => frame.type === 'generate:start').payload.core_prompt_mode).toBe('server_context');
    expect(state.chat.filter(message => message.mes === reply)).toHaveLength(1);
    expect(state.snapshot.chat.filter(message => message.mes === reply)).toHaveLength(1);
    const provider = await (await request.get(`${handoff.providerUrl}/control/last-request`)).json();
    const prompt = JSON.stringify(provider.request.messages);
    expect(prompt.match(/CORE_PROVIDER_WORLD_INFO/g)).toHaveLength(1);
    expect(prompt.match(/CORE_PROVIDER_MARKER/g)).toHaveLength(1);
    expect((await (await request.get(`${handoff.providerUrl}/health`)).json()).requestCount).toBe(1);
    await expect.poll(async () => (await readSavedChat(page, identity)).filter(message => message.mes === reply).length).toBe(1);
    await expect.poll(async () => {
        const saved = JSON.parse(await fs.readFile(path.join(handoff.dataRoot, 'default-user/core-sessions/state.json'), 'utf8'));
        return saved.snapshot.chat.filter(message => message.mes === reply).length;
    }).toBe(1);
    await page.reload();
    await page.waitForFunction(() => !document.getElementById('preloader'));
    await page.evaluate(async ({ avatar, chatName }) => {
        const script = await import('/script.js');
        await script.selectCharacterById(script.characters.findIndex(character => character.avatar === avatar));
        await script.openCharacterChat(chatName);
    }, identity);
    await expect(page.locator('#chat .mes_text').filter({ hasText: reply })).toHaveCount(1);
});

test('a refreshed observer takes over the active stream without duplicating the reply', async ({ page, context, request, handoff }) => {
    await request.post(`${handoff.providerUrl}/control/scenario`, { data: { mode: 'success', pauseAfterFirst: true } });
    const identity = await openChat(page, handoff.providerUrl, `ui-refresh-${Date.now()}`);
    const observer = await context.newPage();

    try {
        await openObserver(observer, handoff.providerUrl, identity);
        await observer.evaluate(async () => {
            const { getContext } = await import('/scripts/st-context.js');
            await getContext().bindCoreState({ bootstrap: false });
        });

        await send(page, 'Refresh while the reply is streaming.');
        await expect(page.locator('#chat .mes_text').last()).toHaveText('A controlled reply');
        await expect(observer.locator('#mes_stop')).toBeVisible();

        await observer.reload();
        await observer.waitForFunction(() => !document.getElementById('preloader'));
        await openObserver(observer, handoff.providerUrl, identity);
        await observer.evaluate(async () => {
            const { getContext } = await import('/scripts/st-context.js');
            await getContext().bindCoreState({ bootstrap: false });
        });

        await expect(observer.locator('#mes_stop')).toBeVisible();
        await expect(observer.locator('#chat .mes_text').filter({ hasText: 'A controlled reply' })).toHaveCount(1);
        await request.post(`${handoff.providerUrl}/control/release`);

        await expect(page.locator('#chat .mes_text').last()).toHaveText(reply);
        await expect(observer.locator('#chat .mes_text').last()).toHaveText(reply);
        await expect(observer.locator('#mes_stop')).toBeHidden();
        await expect.poll(async () => (await readSavedChat(observer, identity)).filter(message => message.mes === reply).length).toBe(1);

        for (const tab of [page, observer]) {
            await expect.poll(() => tab.evaluate((expectedReply) => window.SillyTavern.getContext().chat.filter(message => message.mes === expectedReply).length, reply)).toBe(1);
            await expect.poll(() => tab.evaluate(() => window.coreBridge.activeGenerationJob)).toBeNull();
        }
        expect((await (await request.get(`${handoff.providerUrl}/health`)).json()).requestCount).toBe(1);
    } finally {
        await observer.close().catch(() => {});
    }
});

test('a targeted Core WebSocket disconnect catches up missing chunks once', async ({ page, request, handoff }) => {
    const sentFrames = [];
    page.on('websocket', socket => socket.on('framesent', frame => {
        try {
            sentFrames.push(JSON.parse(String(frame.payload)));
        } catch {
            // Ignore non-JSON WebSocket frames.
        }
    }));

    await request.post(`${handoff.providerUrl}/control/scenario`, { data: { mode: 'success', pauseAfterFirst: true } });
    const identity = await openChat(page, handoff.providerUrl, `ui-reconnect-${Date.now()}`);
    await send(page, 'Reconnect the stream after a targeted socket loss.');
    await expect(page.locator('#chat .mes_text').last()).toHaveText('A controlled reply');
    await page.evaluate(() => window.coreBridge.ws?.close(1000, 'test reconnect'));
    await request.post(`${handoff.providerUrl}/control/release`);

    await expect(page.locator('#chat .mes_text').last()).toHaveText(reply);
    await expect.poll(() => sentFrames
        .filter(frame => frame.type === 'generate:reconnect')
        .some(frame => Number(frame.payload?.lastSeq) >= 1)).toBe(true);
    await expect.poll(async () => (await readSavedChat(page, identity)).filter(message => message.mes === reply).length).toBe(1);
    await expect.poll(() => page.evaluate((expectedReply) => window.SillyTavern.getContext().chat.filter(message => message.mes === expectedReply).length, reply)).toBe(1);
    expect((await (await request.get(`${handoff.providerUrl}/health`)).json()).requestCount).toBe(1);
});

async function openObserver(page, providerUrl, identity) {
    await testSetup.awaitST({ page });
    const welcome = page.locator('dialog[open]').filter({ hasText: 'Welcome to SillyTavern!' });
    if (await welcome.count()) await welcome.locator('.popup-button-ok').click();
    await page.waitForFunction(() => window.coreBridge?.isReady === true);
    await page.evaluate(async ({ providerUrl, avatar, chatName }) => {
        const script = await import('/script.js');
        const openai = await import('/scripts/openai.js');
        const { getStringHash } = await import('/scripts/utils.js');
        const { getContext } = await import('/scripts/st-context.js');
        await script.selectCharacterById(script.characters.findIndex(character => character.avatar === avatar));
        await script.openCharacterChat(chatName);
        script.changeMainAPI('openai');
        Object.assign(openai.oai_settings, {
            stream_openai: true, n: 1, show_thoughts: false,
            openai_model: 'gpt-4o', reverse_proxy: `${providerUrl}/v1`,
            proxy_password: 'test-only', chat_completion_source: openai.chat_completion_sources.OPENAI,
        });
        getContext().accountStorage.setItem(`Proxy_SkipConfirm_${getStringHash(openai.oai_settings.reverse_proxy)}`, 'true');
        script.setOnlineStatus('test-provider');
    }, { providerUrl, ...identity });
}

for (const [mode, pauseAfterFirst, pausedText] of [
    ['http-error', false, /^(?:\.{3}|…)$/],
    ['stream-error', true, 'A controlled reply'],
]) {
    test(`real send ${mode} restores both tabs and permits another send`, async ({ page, context, request, handoff }) => {
        await request.post(`${handoff.providerUrl}/control/scenario`, { data: { mode, pauseAfterFirst } });
        await request.post(`${handoff.providerUrl}/control/block`);
        const identity = await openChat(page, handoff.providerUrl, `ui-${mode}-${Date.now()}`);
        const observer = await context.newPage();
        try {
            await openObserver(observer, handoff.providerUrl, identity);
            await send(page, 'Exercise failure recovery.');
            await expect(observer.locator('#mes_stop')).toBeVisible();
            await expect(observer.locator('#chat .mes_text').filter({ hasText: 'Exercise failure recovery.' })).toHaveCount(1);
            await expect.poll(() => page.evaluate(() => window.uiJobs.length)).toBe(1);
            await expect(page.locator('#chat .mes_text').last()).toHaveText(pausedText);
            await request.post(`${handoff.providerUrl}/control/release`);
            await expect.poll(() => page.evaluate(async () => (await window.coreBridge.getGenerationJob(window.uiJobs[0])).job.status)).toBe('FAILED');
            for (const tab of [page, observer]) {
                await expect(tab.locator('#mes_stop')).toBeHidden();
                await expect(tab.locator('#send_but')).toBeVisible();
                await expect.poll(() => tab.evaluate(() => window.coreBridge.activeGenerationJob)).toBeNull();
                await expect(tab.locator('.toast-error')).toHaveCount(1);
                await expect.poll(() => tab.evaluate(() => window.SillyTavern.getContext().chat.filter(message => message.extra?.core_generation_job_id).length)).toBe(0);
                await expect(tab.locator('#chat .mes_text').filter({ hasText: 'A controlled reply' })).toHaveCount(0);
            }
            const snapshot = await page.evaluate(() => window.coreBridge.getStateSnapshot());
            expect(snapshot.chat.filter(message => message.extra?.core_generation_job_id)).toHaveLength(0);
            expect(snapshot.chat.some(message => message.mes === 'Exercise failure recovery.' && message.is_user)).toBe(true);
            expect((await (await request.get(`${handoff.providerUrl}/health`)).json()).requestCount).toBe(1);
            expect((await readSavedChat(page, identity)).filter(message => message.extra?.core_generation_job_id)).toHaveLength(0);
            await expect.poll(async () => {
                const saved = JSON.parse(await fs.readFile(path.join(handoff.dataRoot, 'default-user/core-sessions/state.json'), 'utf8'));
                return saved.snapshot.chat.some(message => message.mes === 'Exercise failure recovery.' && message.is_user)
                    && !saved.snapshot.chat.some(message => message.extra?.core_generation_job_id);
            }).toBe(true);

            await request.post(`${handoff.providerUrl}/control/scenario`, { data: { mode: 'success' } });
            await send(observer, 'Try again successfully.');
            await expect(observer.locator('#chat .mes_text').last()).toHaveText(reply);
            await expect(page.locator('#chat .mes_text').filter({ hasText: reply })).toHaveCount(1);
            await expect(observer.locator('#mes_stop')).toBeHidden();
            await expect(page.locator('#mes_stop')).toBeHidden();
            await expect.poll(async () => (await readSavedChat(observer, identity)).filter(message => message.mes === reply).length).toBe(1);
            expect((await readSavedChat(observer, identity)).some(message => message.mes === 'Exercise failure recovery.' && message.is_user)).toBe(true);
            expect((await (await request.get(`${handoff.providerUrl}/health`)).json()).requestCount).toBe(1);
        } finally {
            await observer.close();
        }
    });
}
