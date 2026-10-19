import http from 'node:http';
import express from 'express';
import WebSocket from 'ws';
import { wsBridge } from '../src/core/ws-bridge.js';
import sessionEngine from '../src/core/session-engine.js';
import coreRouter from '../src/endpoints/core.js';

async function runTests() {
    console.log('--- Starting Core Bridge Integration Tests ---');

    // 1. Setup minimal express app and attach bridge
    const app = express();
    app.use(express.json());
    app.use('/api/core', coreRouter);

    const server = http.createServer(app);
    wsBridge.attachServer(server);

    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = server.address().port;
    console.log(`[Test] Test server listening on http://127.0.0.1:${port}`);

    try {
        // Test 1: HTTP /api/core/status
        console.log('[Test 1] Testing /api/core/status...');
        const statusRes = await fetch(`http://127.0.0.1:${port}/api/core/status`);
        const statusJson = await statusRes.json();
        if (!statusJson.ok || statusJson.summary.userId !== 'default') {
            throw new Error(`Invalid status response: ${JSON.stringify(statusJson)}`);
        }
        console.log('✓ /api/core/status passed');

        // Test 2: WebSocket Handshake
        console.log('[Test 2] Testing WebSocket connection & handshake...');
        const ws = new WebSocket(`ws://127.0.0.1:${port}/api/bridge/ws`);

        const handshakePromise = new Promise((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error('Handshake timed out')), 3000);
            ws.on('message', (raw) => {
                const msg = JSON.parse(raw.toString());
                if (msg.type === 'handshake') {
                    clearTimeout(timer);
                    resolve(msg);
                }
            });
        });

        const handshake = await handshakePromise;
        if (handshake.status !== 'connected') {
            throw new Error('Handshake failed');
        }
        console.log('✓ Handshake passed:', handshake.summary);

        // Test 3: RPC Call syncFullState
        console.log('[Test 3] Testing RPC syncFullState...');
        const rpcPromise = new Promise((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error('RPC timed out')), 3000);
            const rpcId = 'test-rpc-1';
            const handler = (raw) => {
                const msg = JSON.parse(raw.toString());
                if (msg.type === 'rpc_result' && msg.id === rpcId) {
                    clearTimeout(timer);
                    ws.off('message', handler);
                    resolve(msg.result);
                }
            };
            ws.on('message', handler);
            ws.send(JSON.stringify({
                type: 'rpc',
                id: rpcId,
                method: 'syncFullState',
                params: {
                    characterId: 'char_001',
                    characterName: 'TestBot',
                    chatId: 'chat_001',
                    chat: [{ name: 'User', is_user: true, mes: 'Hello server!' }],
                    metadata: { tokens: 42 },
                },
            }));
        });

        const syncResult = await rpcPromise;
        if (!syncResult.success) {
            throw new Error('RPC syncFullState returned unsuccessful');
        }
        const session = sessionEngine.getSession('default');
        if (session.chat.length !== 1 || session.chat[0].mes !== 'Hello server!') {
            throw new Error('Session state not synced properly');
        }
        console.log('✓ RPC syncFullState passed');

        // Test 4: Server-initiated Event Broadcast
        console.log('[Test 4] Testing Server -> Client event broadcast...');
        const eventPromise = new Promise((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error('Event broadcast timed out')), 3000);
            const handler = (raw) => {
                const msg = JSON.parse(raw.toString());
                if (msg.type === 'event' && msg.event === 'TOKEN_COUNT_UPDATED') {
                    clearTimeout(timer);
                    ws.off('message', handler);
                    resolve(msg.data);
                }
            };
            ws.on('message', handler);
        });

        wsBridge.broadcastEvent('default', 'TOKEN_COUNT_UPDATED', { count: 1234 });
        const eventData = await eventPromise;
        if (eventData.count !== 1234) {
            throw new Error('Event data mismatch');
        }
        console.log('✓ Event broadcast passed');

        // Test 5: Client Interception Handshake
        console.log('[Test 5] Testing Client Interception Handshake (e.g. Prompt modification by plugin)...');
        // Client simulates plugin interception: listening for intercept_req, modifying payload, and sending intercept_ack
        ws.on('message', (raw) => {
            const msg = JSON.parse(raw.toString());
            if (msg.type === 'intercept_req' && msg.event === 'CHAT_COMPLETION_PROMPT_READY') {
                // Plugin modifies message
                msg.payload.intercepted = true;
                msg.payload.modifiedBy = 'Plugin-Alpha';
                ws.send(JSON.stringify({
                    type: 'intercept_ack',
                    interceptId: msg.interceptId,
                    payload: msg.payload,
                }));
            }
        });

        const interceptedPayload = await wsBridge.requestInterception(
            'default',
            'CHAT_COMPLETION_PROMPT_READY',
            { prompt: 'Original system prompt' },
            2000
        );

        if (!interceptedPayload.intercepted || interceptedPayload.modifiedBy !== 'Plugin-Alpha') {
            throw new Error(`Interception failed, payload was: ${JSON.stringify(interceptedPayload)}`);
        }
        console.log('✓ Client Interception Handshake passed! Modified payload:', interceptedPayload);

        // Cleanup
        ws.close();
        wsBridge.close();
        await new Promise((resolve) => server.close(resolve));
        console.log('\n🎉 ALL 5 TESTS PASSED SUCCESSFULLY! 🎉');
        process.exit(0);
    } catch (err) {
        console.error('❌ Test failed with error:', err);
        wsBridge.close();
        server.close();
        process.exit(1);
    }
}

runTests();
