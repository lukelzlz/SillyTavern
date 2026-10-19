import { SECRET_KEYS, readSecret } from '../endpoints/secrets.js';
import wsBridge from './ws-bridge.js';

/**
 * Server-owned proxy for OpenAI-compatible chat-completion requests.
 * API keys remain on the server and the client keeps its existing SSE renderer.
 */
export class ChatCompletionEngine {
    /**
     * Send an OpenAI-compatible request after the plugin interception boundary.
     * @param {import('express').Request} request
     * @param {import('express').Response} response
     * @returns {Promise<void>}
     */
    static async generate(request, response) {
        const payload = structuredClone(request.body || {});
        const baseUrl = String(payload.custom_url || '').replace(/\/$/, '');

        if (!baseUrl || !Array.isArray(payload.messages)) {
            response.status(400).json({ error: { message: 'A Custom API URL and messages are required.' } });
            return;
        }

        const apiKey = readSecret(request.user.directories, SECRET_KEYS.CUSTOM, payload.secret_id);
        if (!apiKey) {
            response.status(400).json({ error: { message: 'No Custom API key is configured.' } });
            return;
        }

        // The browser-side bridge emits the established lifecycle event, allowing
        // existing front-end extensions to alter the messages before the request leaves ST.
        const intercepted = await wsBridge.requestInterception('default', 'CHAT_COMPLETION_PROMPT_READY', {
            chat: payload.messages,
            dryRun: false,
        });
        payload.messages = intercepted.chat;

        delete payload.custom_url;
        delete payload.secret_id;
        const upstream = await fetch(`${baseUrl}/chat/completions`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${apiKey}`,
            },
            body: JSON.stringify(payload),
            signal: AbortSignal.timeout(120000),
        });

        response.status(upstream.status);
        response.setHeader('Content-Type', upstream.headers.get('content-type') || 'application/json');
        response.setHeader('Cache-Control', 'no-cache');

        if (!upstream.body) {
            response.end(await upstream.text());
            return;
        }

        const reader = upstream.body.getReader();
        request.on('close', () => reader.cancel().catch(() => {}));
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            response.write(value);
        }
        response.end();
    }
}

export default ChatCompletionEngine;
