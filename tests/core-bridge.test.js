import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import express from 'express';
import WebSocket, { WebSocketServer } from 'ws';
import { describe, test, expect, beforeAll, afterAll } from '@jest/globals';
import { wsBridge } from '../src/core/ws-bridge.js';
import coreRouter from '../src/endpoints/core.js';

describe('Core P0 Security Bleeding Controls', () => {
    let server;
    let port;
    let otherWss;

    beforeAll(async () => {
        const app = express();
        app.use(express.json());
        app.use('/api/core', coreRouter);

        server = http.createServer(app);
        wsBridge.attachServer(server);

        // Real independent WebSocket handler (e.g. plugin or proxy)
        otherWss = new WebSocketServer({ noServer: true });
        otherWss.on('connection', (clientWs) => {
            clientWs.on('ping', () => {
                clientWs.pong();
            });
            clientWs.on('message', (data) => {
                if (data.toString() === 'ping') {
                    clientWs.send('pong');
                }
            });
        });

        server.on('upgrade', (req, socket, head) => {
            try {
                const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
                if (url.pathname === '/other-plugin/ws') {
                    otherWss.handleUpgrade(req, socket, head, (clientWs) => {
                        otherWss.emit('connection', clientWs, req);
                    });
                }
            } catch {
                socket.destroy();
            }
        });

        await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
        port = server.address().port;
    });

    afterAll(async () => {
        wsBridge.close();
        if (otherWss) {
            otherWss.close();
        }
        if (server && server.listening) {
            await new Promise((resolve) => server.close(resolve));
        }
    });

    test('Core WebSocket upgrades to /api/bridge/ws are disabled by default (403 Forbidden)', async () => {
        const ws = new WebSocket(`ws://127.0.0.1:${port}/api/bridge/ws`);

        const error = await new Promise((resolve) => {
            ws.on('unexpected-response', (req, res) => {
                resolve({ statusCode: res.statusCode });
            });
            ws.on('error', (err) => {
                resolve(err);
            });
            ws.on('open', () => {
                ws.close();
                resolve(null);
            });
        });

        expect(error).not.toBeNull();
        expect(error.statusCode ?? 403).toBe(403);
    });

    test('Core WebSocket upgrades with trailing slash /api/bridge/ws/ are disabled by default (403 Forbidden)', async () => {
        const ws = new WebSocket(`ws://127.0.0.1:${port}/api/bridge/ws/`);

        const error = await new Promise((resolve) => {
            ws.on('unexpected-response', (req, res) => {
                resolve({ statusCode: res.statusCode });
            });
            ws.on('error', (err) => {
                resolve(err);
            });
            ws.on('open', () => {
                ws.close();
                resolve(null);
            });
        });

        expect(error).not.toBeNull();
        expect(error.statusCode ?? 403).toBe(403);
    });

    test('Other legitimate upgrade handlers maintain active connection and complete ping/pong', async () => {
        const ws = new WebSocket(`ws://127.0.0.1:${port}/other-plugin/ws`);

        await new Promise((resolve, reject) => {
            ws.on('open', resolve);
            ws.on('error', reject);
        });

        // Test WebSocket frame ping/pong
        const pongPromise = new Promise((resolve) => {
            ws.on('pong', () => {
                resolve('pong-received');
            });
        });
        ws.ping();
        const pongResult = await pongPromise;
        expect(pongResult).toBe('pong-received');

        // Test bidirectional message roundtrip
        const messagePromise = new Promise((resolve) => {
            ws.on('message', (msg) => {
                resolve(msg.toString());
            });
        });
        ws.send('ping');
        const msgResult = await messagePromise;
        expect(msgResult).toBe('pong');

        expect(ws.readyState).toBe(WebSocket.OPEN);
        ws.close();
    });

    test('Insecure Core generation endpoint returns 403 Forbidden by default', async () => {
        const res = await fetch(`http://127.0.0.1:${port}/api/core/chat-completions/generate`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                custom_url: 'http://169.254.169.254/latest/meta-data/',
                messages: [{ role: 'user', content: 'test' }],
            }),
        });

        expect(res.status).toBe(403);
        const data = await res.json();
        expect(data.error?.message).toContain('Core generation routing is disabled');
    });

    test('/api/core/status does not expose default session details or chat metadata', async () => {
        const res = await fetch(`http://127.0.0.1:${port}/api/core/status`);
        expect(res.status).toBe(200);
        const data = await res.json();
        expect(data.ok).toBe(true);
        expect(data.summary).toBeUndefined();
        expect(data.userId).toBeUndefined();
        expect(data.activeCharacterId).toBeUndefined();
        expect(data.chatId).toBeUndefined();
    });

    test('openai.js restores native generation URL and avoids Core proxy', () => {
        const openaiScriptPath = path.resolve(process.cwd(), '../public/scripts/openai.js');
        const content = fs.readFileSync(openaiScriptPath, 'utf8');

        expect(content).toContain('const generate_url = \'/api/backends/chat-completions/generate\';');
        expect(content).not.toContain('? \'/api/core/chat-completions/generate\'');
        expect(content).toContain('coreBridge.startGenerationStream');
        expect(content).toContain('core_generation_job_id');
    });

    test('openai.js restores native in-place CHAT_COMPLETION_PROMPT_READY event emission', () => {
        const openaiScriptPath = path.resolve(process.cwd(), '../public/scripts/openai.js');
        const content = fs.readFileSync(openaiScriptPath, 'utf8');

        expect(content).not.toContain('serverManagedCustomApi');
        expect(content).toContain('await eventSource.emit(event_types.CHAT_COMPLETION_PROMPT_READY, eventData);');
    });

    test('bridge-client.js halts reconnection loop to prevent log spamming', () => {
        const clientScriptPath = path.resolve(process.cwd(), '../public/scripts/core/bridge-client.js');
        const content = fs.readFileSync(clientScriptPath, 'utf8');

        expect(content).toContain('this.reconnectAttempts >= 1');
    });
});
