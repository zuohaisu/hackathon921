'use strict';

/**
 * HTTP entry point for the agent proxy (issue #22).
 *
 * Node built-ins only — no framework — because the backend stack is not chosen
 * yet and this endpoint does not justify introducing one. In production it binds
 * to 127.0.0.1 and nginx terminates TLS and exposes it under /api/.
 */

const http = require('http');
const {createApp, MAX_BODY_BYTES} = require('./agentProxy');

const PORT = Number(process.env.AGENT_PROXY_PORT || 8787);
const HOST = process.env.AGENT_PROXY_HOST || '127.0.0.1';
const ALLOWED_ORIGIN = process.env.AGENT_PROXY_ALLOWED_ORIGIN || '';
const apiKey = process.env.DEEPSEEK_API_KEY || '';

const app = createApp({apiKey});

function corsHeaders() {
    // Same-origin in production (nginx), so this stays empty unless explicitly
    // configured for local development.
    if (!ALLOWED_ORIGIN) return {};
    return {
        'access-control-allow-origin': ALLOWED_ORIGIN,
        'access-control-allow-methods': 'GET, POST, OPTIONS',
        'access-control-allow-headers': 'content-type',
    };
}

function readBody(req) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        let size = 0;

        req.on('data', chunk => {
            size += chunk.length;
            if (size > MAX_BODY_BYTES) {
                reject(Object.assign(new Error('Body too large'), {code: 'BODY_TOO_LARGE'}));
                req.destroy();
                return;
            }
            chunks.push(chunk);
        });

        req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
        req.on('error', reject);
    });
}

const server = http.createServer(async (req, res) => {
    const headers = Object.assign({'content-type': 'application/json'}, corsHeaders());

    if (req.method === 'OPTIONS') {
        res.writeHead(204, headers);
        res.end();
        return;
    }

    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

    let raw = '';
    try {
        raw = await readBody(req);
    } catch (error) {
        const status = error && error.code === 'BODY_TOO_LARGE' ? 413 : 400;
        res.writeHead(status, headers);
        res.end(JSON.stringify({
            ok: false,
            error: status === 413 ? 'BODY_TOO_LARGE' : 'INVALID_REQUEST',
            message: status === 413 ? 'Request body is too large.' : 'Could not read the request body.',
        }));
        return;
    }

    let body;
    if (raw) {
        try {
            body = JSON.parse(raw);
        } catch (error) {
            res.writeHead(400, headers);
            res.end(JSON.stringify({ok: false, error: 'INVALID_JSON', message: 'Body must be valid JSON.'}));
            return;
        }
    }

    let result;
    try {
        result = await app({
            method: req.method,
            path: url.pathname,
            body,
            ip: req.socket.remoteAddress,
        });
    } catch (error) {
        // Never leak internals or the key; surface a stable, actionable shape.
        console.error('[agent-proxy] unhandled error:', error && error.message);
        result = {status: 500, body: {ok: false, error: 'INTERNAL_ERROR', message: 'The agent proxy failed unexpectedly.'}};
    }

    res.writeHead(result.status, headers);
    res.end(JSON.stringify(result.body));
});

server.listen(PORT, HOST, () => {
    console.log(`[agent-proxy] listening on http://${HOST}:${PORT}`);
    console.log(`[agent-proxy] provider key: ${apiKey ? 'configured' : 'MISSING (set DEEPSEEK_API_KEY)'}`);
});
