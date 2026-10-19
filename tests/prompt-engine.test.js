import http from 'node:http';
import express from 'express';
import WebSocket from 'ws';
import { PromptEngine } from '../src/core/prompt-engine.js';
import { wsBridge } from '../src/core/ws-bridge.js';
import coreRouter from '../src/endpoints/core.js';

async function runPromptEngineTests() {
    console.log('--- Starting PromptEngine & Interception Pipeline Tests ---');

    // Test 1: Macro Substitution
    console.log('[Test 1] Macro Substitution...');
    const template = 'Hello {{user}}! I am {{char}}, also known as {{CHAR}}. The scenario is {{scenario}}.';
    const vars = { user: 'Alice', char: 'Bob', scenario: 'Medieval Castle' };
    const substituted = PromptEngine.substituteMacros(template, vars);
    if (!substituted.includes('Hello Alice!') || !substituted.includes('I am Bob') || !substituted.includes('BOB') || !substituted.includes('Medieval Castle')) {
        throw new Error(`Test 1 Failed: Substituted text was '${substituted}'`);
    }
    console.log('✓ Test 1 Passed: Macro substitution correct');

    // Test 2: System & History Assembly with Budget
    console.log('[Test 2] Prompt Assembly with Token Budget...');
    const result = PromptEngine.assemble({
        character: {
            name: 'CyberSage',
            description: 'An AI mentor in Neo-Tokyo.',
            personality: 'Calm, analytical.',
            scenario: 'Neon-lit alley.',
        },
        user: {
            name: 'NetRunner',
            persona: 'A skilled hacker.',
        },
        systemPrompt: 'You are {{char}}. Act in character.',
        worldInfoBefore: 'World Rule: Cyberspace connects all.',
        depthPrompts: [
            { depth: 1, role: 'system', content: '[Current Situation: High Alert]' },
        ],
        messages: [
            { is_user: true, mes: 'Can you decrypt this shard?' },
            { is_user: false, mes: 'I can try, but the ICE is thick.' },
            { is_user: true, mes: 'Take all the time you need.' },
        ],
        options: {
            maxContextTokens: 2000,
            maxResponseTokens: 200,
        },
    });

    if (!Array.isArray(result.messages) || result.messages.length < 4) {
        throw new Error(`Test 2 Failed: Expected at least 4 messages, got ${result.messages.length}`);
    }
    const sysMsg = result.messages[0];
    if (sysMsg.role !== 'system' || !sysMsg.content.includes('CyberSage') || !sysMsg.content.includes('World Rule: Cyberspace')) {
        throw new Error(`Test 2 Failed: System prompt missing character or WI info: ${sysMsg.content}`);
    }
    // Verify depth prompt was injected near bottom
    const depthMsg = result.messages.find(m => m.content && m.content.includes('High Alert'));
    if (!depthMsg) {
        throw new Error('Test 2 Failed: Depth prompt was not injected');
    }
    console.log(`✓ Test 2 Passed: Prompt assembled with ${result.messages.length} messages, ${result.stats.totalEstimatedTokens} tokens estimated`);

    // Test 3: Budget Truncation (Older messages pruned)
    console.log('[Test 3] Token Budget Truncation...');
    const manyMessages = [];
    for (let i = 0; i < 20; i++) {
        manyMessages.push({ is_user: true, mes: `Message #${i}: ` + 'X'.repeat(300) });
    }
    const budgetResult = PromptEngine.assemble({
        character: { name: 'Bot' },
        user: { name: 'User' },
        messages: manyMessages,
        options: {
            maxContextTokens: 600, // Very tight budget
            maxResponseTokens: 100,
        },
    });
    // With 20 huge messages and budget 500 tokens, only 1-2 latest messages should fit
    if (budgetResult.stats.messagesIncluded >= 20 || budgetResult.stats.messagesIncluded === 0) {
        throw new Error(`Test 3 Failed: Budget truncation failed, included: ${budgetResult.stats.messagesIncluded}`);
    }
    console.log(`✓ Test 3 Passed: Truncated 20 messages down to latest ${budgetResult.stats.messagesIncluded} to fit budget`);

    // Test 4: End-to-End Client Interception Handshake for Assembled Prompt
    console.log('[Test 4] End-to-End Interception Handshake with Bridge...');
    const app = express();
    app.use(express.json());
    app.use('/api/core', coreRouter);
    const server = http.createServer(app);
    wsBridge.attachServer(server);

    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = server.address().port;

    const ws = new WebSocket(`ws://127.0.0.1:${port}/api/bridge/ws`);
    await new Promise((resolve) => ws.on('open', resolve));

    // Simulate client-side extension: intercepts CHAT_COMPLETION_PROMPT_READY and injects a secret memory
    ws.on('message', (raw) => {
        const msg = JSON.parse(raw.toString());
        if (msg.type === 'intercept_req' && msg.event === 'CHAT_COMPLETION_PROMPT_READY') {
            msg.payload.chat.push({
                role: 'system',
                content: '[Extension: Memory recall - User likes cats]',
            });
            ws.send(JSON.stringify({
                type: 'intercept_ack',
                interceptId: msg.interceptId,
                payload: msg.payload,
            }));
        }
    });

    // Server-side: assemble prompt, then request interception before sending to model
    const initialPrompt = PromptEngine.assemble({
        character: { name: 'Assistant' },
        user: { name: 'User' },
        messages: [{ is_user: true, mes: 'Tell me a secret.' }],
    });

    const intercepted = await wsBridge.requestInterception(
        'default',
        'CHAT_COMPLETION_PROMPT_READY',
        { chat: initialPrompt.messages },
        3000,
    );

    const hasInjectedMemory = intercepted.chat.some(m => m.content && m.content.includes('User likes cats'));
    if (!hasInjectedMemory) {
        throw new Error('Test 4 Failed: Client plugin mutation was not reflected in final server prompt');
    }
    console.log('✓ Test 4 Passed: Client plugin successfully intercepted and modified final prompt!');

    // Cleanup
    ws.close();
    wsBridge.close();
    await new Promise((resolve) => server.close(resolve));

    console.log('\n🎉 ALL 4 PROMPT ENGINE & INTERCEPTION TESTS PASSED! 🎉');
}

runPromptEngineTests();
