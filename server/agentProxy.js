'use strict';

/**
 * Zero-dependency server-side LLM proxy (issue #22).
 *
 * Why this exists:
 * - the provider key must never reach the browser;
 * - players in mainland China cannot reach the provider directly, only the
 *   server can (see docs/PRODUCT_CONCEPT.md §14).
 *
 * It is deliberately more than a dumb relay. The system instructions and the
 * tool schema live HERE, so the client can only send the player's strategy plus
 * a compressed snapshot and can neither see nor override the system prompt.
 * See AGENTS.md: system instructions and player text must be delivered
 * separately.
 *
 * All decision logic is kept in pure functions so it can be unit-tested with a
 * fake `fetch` and no network.
 */

const DEEPSEEK_URL = 'https://api.deepseek.com/chat/completions';
const MODEL = 'deepseek-chat';
const REQUEST_TIMEOUT_MS = 15000;
const MAX_STRATEGY_LENGTH = 2000;
const MAX_ACTIONS_PER_DECISION = 8;
const MAX_BODY_BYTES = 64 * 1024;

const TOWER_TYPES = ['canon', 'gatling', 'slow', 'sniper', 'laser'];

/**
 * The tool schema is part of the server-held contract. The client never sends
 * it, so a tampered client cannot widen what the model is allowed to do.
 */
const TOOLS = [
    {
        type: 'function',
        function: {
            name: 'build_tower',
            description: 'Build a tower on an empty grid cell. The engine rejects occupied cells and placements that would block every enemy path.',
            parameters: {
                type: 'object',
                properties: {
                    type: {type: 'string', enum: TOWER_TYPES, description: 'Tower type.'},
                    i: {type: 'integer', description: 'Grid column index.'},
                    j: {type: 'integer', description: 'Grid row index.'},
                },
                required: ['type', 'i', 'j'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'upgrade_tower',
            description: 'Upgrade an existing tower, referenced by the id from the state snapshot.',
            parameters: {
                type: 'object',
                properties: {
                    id: {type: 'string', description: 'Tower id, formatted "i:j".'},
                },
                required: ['id'],
            },
        },
    },
];

const TOOL_NAMES = TOOLS.map(tool => tool.function.name);

const SYSTEM_PROMPT = [
    'You are the autonomous player of an endless tower-defense game. A human wrote',
    'a strategy; you decide how to play it.',
    '',
    'Rules:',
    '- You affect the battlefield ONLY by calling the provided tools. You cannot',
    '  move enemies or edit the game state directly.',
    '- You are called once at each wave boundary, before the next wave spawns.',
    '  Decide what to build or upgrade now.',
    '- The engine validates every action and may reject it (not enough cash,',
    '  occupied cell, would block the path). If an action is rejected, adapt',
    '  instead of repeating the same call.',
    '- You may return zero, one, or several tool calls. Prefer a few high-value',
    '  actions over many.',
    '- Grid coordinates are (i, j) = (column, row). Only free cells can be built',
    '  on; walls, the base and existing towers are occupied.',
    '- Follow the player strategy. Do not invent goals the player did not ask for.',
    '- Return tool calls only. Do not explain.',
].join('\n');

function validateDecideRequest(body) {
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
        return {ok: false, error: 'INVALID_REQUEST', message: 'Body must be a JSON object.'};
    }

    const {strategy, state} = body;

    if (typeof strategy !== 'string' || strategy.trim() === '') {
        return {ok: false, error: 'EMPTY_STRATEGY', message: 'A non-empty strategy string is required.'};
    }

    if (strategy.length > MAX_STRATEGY_LENGTH) {
        return {
            ok: false,
            error: 'STRATEGY_TOO_LONG',
            message: `Strategy is ${strategy.length} characters; the limit is ${MAX_STRATEGY_LENGTH}.`,
        };
    }

    if (!state || typeof state !== 'object' || Array.isArray(state)) {
        return {ok: false, error: 'INVALID_STATE', message: 'A game state snapshot object is required.'};
    }

    return {ok: true, value: {strategy, state}};
}

/**
 * The player's strategy is placed in the user message, never concatenated into
 * the system prompt. That separation is a security property, not a style choice.
 */
function composeMessages(strategy, state) {
    return [
        {role: 'system', content: SYSTEM_PROMPT},
        {
            role: 'user',
            content: `Battlefield state (JSON):\n${JSON.stringify(state)}\n\nPlayer strategy:\n${strategy}`,
        },
    ];
}

function parseArguments(raw) {
    if (raw === undefined || raw === null || raw === '') return {};
    if (typeof raw === 'object') return raw;
    try {
        const parsed = JSON.parse(raw);
        return parsed && typeof parsed === 'object' ? parsed : {};
    } catch (error) {
        return {};
    }
}

/** Normalize the provider's tool calls into the shape the runtime consumes. */
function extractActions(payload) {
    const choice = payload && Array.isArray(payload.choices) ? payload.choices[0] : undefined;
    const message = choice && choice.message;
    const calls = message && Array.isArray(message.tool_calls) ? message.tool_calls : [];

    return calls
        .slice(0, MAX_ACTIONS_PER_DECISION)
        .map(call => {
            const fn = call && call.function;
            return {name: fn && fn.name, arguments: parseArguments(fn && fn.arguments)};
        })
        .filter(action => typeof action.name === 'string' && TOOL_NAMES.indexOf(action.name) !== -1);
}

function mapProviderError(status, payload) {
    const detail = payload && payload.error && payload.error.message
        ? payload.error.message
        : `Provider returned HTTP ${status}.`;

    if (status === 401 || status === 403) {
        return {error: 'PROVIDER_AUTH_ERROR', message: 'The agent proxy key was rejected by the provider.'};
    }
    if (status === 429) {
        return {error: 'PROVIDER_RATE_LIMITED', message: 'The LLM provider is rate limiting this server.'};
    }
    if (status >= 500) {
        return {error: 'PROVIDER_UNAVAILABLE', message: detail};
    }
    return {error: 'PROVIDER_BAD_REQUEST', message: detail};
}

function createRateLimiter({limit, windowMs, now}) {
    const hits = new Map();

    return {
        allow(key) {
            const current = now();
            const entry = hits.get(key);

            if (!entry || current - entry.start >= windowMs) {
                hits.set(key, {start: current, count: 1});
                return true;
            }

            if (entry.count >= limit) return false;

            entry.count += 1;
            return true;
        },
    };
}

async function callProvider({apiKey, messages, fetchImpl}) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    let response;
    try {
        response = await fetchImpl(DEEPSEEK_URL, {
            method: 'POST',
            headers: {
                'content-type': 'application/json',
                authorization: `Bearer ${apiKey}`,
            },
            body: JSON.stringify({
                model: MODEL,
                messages,
                tools: TOOLS,
                tool_choice: 'auto',
                temperature: 0.2,
                max_tokens: 900,
            }),
            signal: controller.signal,
        });
    } catch (error) {
        const aborted = error && error.name === 'AbortError';
        return {
            ok: false,
            error: aborted ? 'PROVIDER_TIMEOUT' : 'PROVIDER_UNAVAILABLE',
            message: aborted
                ? `The LLM provider did not answer within ${REQUEST_TIMEOUT_MS}ms.`
                : 'The agent proxy could not reach the LLM provider.',
        };
    } finally {
        clearTimeout(timeout);
    }

    let payload;
    try {
        payload = await response.json();
    } catch (error) {
        payload = undefined;
    }

    if (!response.ok) {
        return Object.assign({ok: false}, mapProviderError(response.status, payload));
    }

    return {ok: true, payload};
}

/**
 * The unit-testable application core. `handle` takes a plain request object and
 * returns a plain response object; the HTTP entry point adapts Node's req/res to
 * this shape.
 */
function createApp({apiKey, fetchImpl = fetch, now = () => Date.now(), rateLimiter}) {
    const limiter = rateLimiter || createRateLimiter({limit: 30, windowMs: 60000, now});

    return async function handle({method, path, body, ip}) {
        if (method === 'GET' && path === '/api/health') {
            return {status: 200, body: {ok: true, providerConfigured: Boolean(apiKey)}};
        }

        if (method === 'POST' && path === '/api/agent/decide') {
            if (!limiter.allow(ip || 'unknown')) {
                return {
                    status: 429,
                    body: {
                        ok: false,
                        error: 'RATE_LIMITED',
                        message: 'Too many decisions from this client. Wait a moment.',
                    },
                };
            }

            const validation = validateDecideRequest(body);
            if (!validation.ok) {
                return {status: 400, body: validation};
            }

            if (!apiKey) {
                return {
                    status: 503,
                    body: {
                        ok: false,
                        error: 'PROVIDER_NOT_CONFIGURED',
                        message: 'The agent proxy has no DEEPSEEK_API_KEY configured.',
                    },
                };
            }

            const {strategy, state} = validation.value;
            const result = await callProvider({
                apiKey,
                messages: composeMessages(strategy, state),
                fetchImpl,
            });

            if (!result.ok) {
                return {status: 502, body: {ok: false, error: result.error, message: result.message}};
            }

            const actions = extractActions(result.payload);
            const usage = result.payload && result.payload.usage ? result.payload.usage : undefined;

            return {status: 200, body: {ok: true, actions, usage}};
        }

        return {status: 404, body: {ok: false, error: 'NOT_FOUND', message: `No route for ${method} ${path}.`}};
    };
}

module.exports = {
    DEEPSEEK_URL,
    MODEL,
    MAX_STRATEGY_LENGTH,
    MAX_ACTIONS_PER_DECISION,
    MAX_BODY_BYTES,
    TOOLS,
    SYSTEM_PROMPT,
    validateDecideRequest,
    composeMessages,
    extractActions,
    mapProviderError,
    createRateLimiter,
    createApp,
};
