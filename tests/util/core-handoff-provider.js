import http from 'node:http';

const port = Number(process.env.ST_CORE_PROVIDER_PORT || 8124);
let blocked = false;
let releaseBlockedRequest = null;
let lastRequest = null;

function readBody(req) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        req.on('data', chunk => chunks.push(chunk));
        req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
        req.on('error', reject);
    });
}

function sendJson(res, value) {
    res.writeHead(200, {
        'Access-Control-Allow-Origin': '*',
        'Content-Type': 'application/json',
    });
    res.end(JSON.stringify(value));
}

async function waitUntilReleased() {
    if (!blocked) return;
    await new Promise((resolve) => {
        releaseBlockedRequest = resolve;
    });
    releaseBlockedRequest = null;
}

const server = http.createServer(async (req, res) => {
    if (req.method === 'OPTIONS') {
        res.writeHead(204, {
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Headers': 'content-type, authorization',
        });
        res.end();
        return;
    }

    if (req.method === 'GET' && req.url === '/health') {
        sendJson(res, { ok: true, blocked });
        return;
    }

    if (req.method === 'POST' && req.url === '/control/block') {
        blocked = true;
        sendJson(res, { ok: true, blocked });
        return;
    }

    if (req.method === 'POST' && req.url === '/control/release') {
        blocked = false;
        releaseBlockedRequest?.();
        sendJson(res, { ok: true, blocked });
        return;
    }

    if (req.method === 'GET' && req.url === '/control/last-request') {
        sendJson(res, { ok: true, request: lastRequest });
        return;
    }

    if (req.method !== 'POST' || req.url !== '/v1/chat/completions') {
        res.writeHead(404);
        res.end();
        return;
    }

    try {
        lastRequest = JSON.parse(await readBody(req));
        await waitUntilReleased();

        const messages = Array.isArray(lastRequest?.messages) ? lastRequest.messages : [];
        const content = messages.map(message => String(message?.content || '')).join('\n');
        const markerCount = (content.match(/CORE_PROVIDER_MARKER/g) || []).length;
        const worldInfoCount = (content.match(/CORE_PROVIDER_WORLD_INFO/g) || []).length;

        res.writeHead(200, {
            'Access-Control-Allow-Origin': '*',
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            Connection: 'keep-alive',
        });
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: `provider:${markerCount}:${worldInfoCount}` } }] })}\n\n`);
        res.write('data: [DONE]\n\n');
        res.end();
    } catch (error) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: error.message } }));
    }
});

server.listen(port, '127.0.0.1', () => {
    process.stdout.write(`Core handoff provider listening on ${port}\n`);
});

function shutdown() {
    releaseBlockedRequest?.();
    server.close(() => process.exit(0));
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
