import http from 'node:http';

const port = Number(process.env.ST_CORE_PROVIDER_PORT || 8124);
let blocked = false;
const pendingResponses = new Set();
let lastRequest = null;
let closedResponses = 0;
let requestCount = 0;
let scenario = { mode: 'markers', pauseAfterFirst: false };

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

async function waitUntilReleased(res) {
    if (!blocked) return;
    await new Promise((resolve) => {
        const release = () => {
            pendingResponses.delete(release);
            res.off('close', release);
            resolve();
        };
        pendingResponses.add(release);
        res.once('close', release);
    });
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
        sendJson(res, { ok: true, blocked, pending: pendingResponses.size, closedResponses, requestCount });
        return;
    }

    if (req.method === 'POST' && req.url === '/control/scenario') {
        scenario = JSON.parse(await readBody(req));
        requestCount = 0;
        lastRequest = null;
        blocked = Boolean(scenario.pauseAfterFirst);
        sendJson(res, { ok: true });
        return;
    }

    if (req.method === 'POST' && req.url === '/control/block') {
        blocked = true;
        sendJson(res, { ok: true, blocked });
        return;
    }

    if (req.method === 'POST' && req.url === '/control/release') {
        blocked = false;
        for (const release of pendingResponses) release();
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
        const request = JSON.parse(await readBody(req));
        lastRequest = request;
        requestCount++;
        const current = { ...scenario };
        res.once('close', () => { closedResponses++; });
        if (!current.pauseAfterFirst) await waitUntilReleased(res);
        if (res.destroyed) return;

        if (current.mode === 'http-error') {
            res.writeHead(503, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: { message: 'Controlled provider failure' } }));
            return;
        }

        const messages = Array.isArray(request?.messages) ? request.messages : [];
        const content = messages.map(message => String(message?.content || '')).join('\n');
        const markerCount = (content.match(/CORE_PROVIDER_MARKER/g) || []).length;
        const worldInfoCount = (content.match(/CORE_PROVIDER_WORLD_INFO/g) || []).length;

        res.writeHead(200, {
            'Access-Control-Allow-Origin': '*',
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            Connection: 'keep-alive',
        });
        const first = current.mode === 'markers' ? `provider:${markerCount}:${worldInfoCount}` : 'A controlled reply';
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: first } }] })}\n\n`);
        if (current.pauseAfterFirst) await waitUntilReleased(res);
        if (res.destroyed) return;
        if (current.mode === 'stream-error') {
            res.write(`data: ${JSON.stringify({ error: { message: 'Controlled stream failure' } })}\n\n`);
            res.end();
            return;
        }
        if (current.mode === 'success') {
            res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: ' completes exactly once.' } }] })}\n\n`);
        }
        res.write('data: [DONE]\n\n');
        res.end();
    } catch (error) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: error.message } }));
    }
});

server.listen(port, '127.0.0.1', () => {
    const actualPort = server.address().port;
    process.send?.({ port: actualPort });
    process.stdout.write(`Core handoff provider listening on ${actualPort}\n`);
});

function shutdown() {
    for (const release of pendingResponses) release();
    server.closeAllConnections();
    server.close(() => process.exit(0));
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
