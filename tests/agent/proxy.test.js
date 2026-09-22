const assert = require('assert');
const {
    validateDecideRequest,
    composeMessages,
    extractActions,
    mapProviderError,
    createRateLimiter,
    createApp,
    SYSTEM_PROMPT,
    MAX_STRATEGY_LENGTH,
} = require('../../server/agentProxy.js');

/**
 * Unit tests for the server-side LLM proxy (issue #22).
 *
 * No network and no DOM: the provider is replaced by a fake `fetch`, so these
 * assert the security-relevant behaviour — system/player separation, request
 * validation, action normalization and error mapping.
 */

function test(name, fn) {
    try {
        fn();
        console.log(`  ok  ${name}`);
    } catch (error) {
        console.error(`FAIL  ${name}`);
        throw error;
    }
}

async function testAsync(name, fn) {
    try {
        await fn();
        console.log(`  ok  ${name}`);
    } catch (error) {
        console.error(`FAIL  ${name}`);
        throw error;
    }
}

function fakeResponse(status, payload) {
    return {
        ok: status >= 200 && status < 300,
        status,
        json: async () => payload,
    };
}

(async () => {
    console.log('Agent proxy');

    test('validateDecideRequest accepts a well-formed request', () => {
        const result = validateDecideRequest({strategy: 'build near base', state: {wave: 1}});
        assert.strictEqual(result.ok, true);
        assert.strictEqual(result.value.strategy, 'build near base');
    });

    test('validateDecideRequest rejects non-object, empty strategy, long strategy, bad state', () => {
        assert.strictEqual(validateDecideRequest(null).error, 'INVALID_REQUEST');
        assert.strictEqual(validateDecideRequest([]).error, 'INVALID_REQUEST');
        assert.strictEqual(validateDecideRequest({strategy: '   ', state: {}}).error, 'EMPTY_STRATEGY');
        assert.strictEqual(validateDecideRequest({strategy: 'x'.repeat(MAX_STRATEGY_LENGTH + 1), state: {}}).error, 'STRATEGY_TOO_LONG');
        assert.strictEqual(validateDecideRequest({strategy: 'ok', state: null}).error, 'INVALID_STATE');
        assert.strictEqual(validateDecideRequest({strategy: 'ok', state: []}).error, 'INVALID_STATE');
    });

    test('composeMessages keeps the player strategy out of the system prompt', () => {
        const strategy = 'PRIORITIZE SLOWING FAST ENEMIES';
        const messages = composeMessages(strategy, {wave: 3});

        assert.strictEqual(messages.length, 2);
        assert.strictEqual(messages[0].role, 'system');
        assert.strictEqual(messages[0].content, SYSTEM_PROMPT);
        assert.ok(messages[0].content.indexOf(strategy) === -1, 'strategy must not leak into the system prompt');
        assert.strictEqual(messages[1].role, 'user');
        assert.ok(messages[1].content.indexOf(strategy) !== -1);
        assert.ok(messages[1].content.indexOf('"wave":3') !== -1);
    });

    test('extractActions normalizes tool calls, drops unknown tools, caps the count', () => {
        const payload = {
            choices: [{
                message: {
                    tool_calls: [
                        {function: {name: 'build_tower', arguments: '{"type":"canon","i":1,"j":2}'}},
                        {function: {name: 'delete_everything', arguments: '{}'}},
                        {function: {name: 'upgrade_tower', arguments: 'not json'}},
                    ],
                },
            }],
        };

        const actions = extractActions(payload);
        assert.deepStrictEqual(actions, [
            {name: 'build_tower', arguments: {type: 'canon', i: 1, j: 2}},
            {name: 'upgrade_tower', arguments: {}},
        ]);
    });

    test('extractActions returns an empty list when the model calls no tool', () => {
        assert.deepStrictEqual(extractActions({choices: [{message: {content: 'I will wait.'}}]}), []);
        assert.deepStrictEqual(extractActions(undefined), []);
    });

    test('mapProviderError maps provider failures to game-readable codes', () => {
        assert.strictEqual(mapProviderError(401, {}).error, 'PROVIDER_AUTH_ERROR');
        assert.strictEqual(mapProviderError(429, {}).error, 'PROVIDER_RATE_LIMITED');
        assert.strictEqual(mapProviderError(503, {}).error, 'PROVIDER_UNAVAILABLE');
        assert.strictEqual(mapProviderError(400, {}).error, 'PROVIDER_BAD_REQUEST');
    });

    test('createRateLimiter allows up to the limit then blocks within the window', () => {
        let now = 0;
        const limiter = createRateLimiter({limit: 2, windowMs: 1000, now: () => now});
        assert.strictEqual(limiter.allow('a'), true);
        assert.strictEqual(limiter.allow('a'), true);
        assert.strictEqual(limiter.allow('a'), false);
        assert.strictEqual(limiter.allow('b'), true, 'limits are per client');
        now = 1000;
        assert.strictEqual(limiter.allow('a'), true, 'the window resets');
    });

    await testAsync('health reports whether the provider key is configured', async () => {
        const offline = createApp({apiKey: ''});
        assert.deepStrictEqual((await offline({method: 'GET', path: '/api/health'})).body, {ok: true, providerConfigured: false});

        const online = createApp({apiKey: 'k'});
        assert.deepStrictEqual((await online({method: 'GET', path: '/api/health'})).body, {ok: true, providerConfigured: true});
    });

    await testAsync('decide returns 503 when no key is configured', async () => {
        const app = createApp({apiKey: ''});
        const result = await app({method: 'POST', path: '/api/agent/decide', body: {strategy: 's', state: {}}});
        assert.strictEqual(result.status, 503);
        assert.strictEqual(result.body.error, 'PROVIDER_NOT_CONFIGURED');
    });

    await testAsync('decide rejects an invalid request before calling the provider', async () => {
        let called = false;
        const app = createApp({apiKey: 'k', fetchImpl: async () => {
            called = true;
            return fakeResponse(200, {});
        }});
        const result = await app({method: 'POST', path: '/api/agent/decide', body: {strategy: ''}});
        assert.strictEqual(result.status, 400);
        assert.strictEqual(result.body.error, 'EMPTY_STRATEGY');
        assert.strictEqual(called, false);
    });

    await testAsync('decide enforces the rate limit', async () => {
        const app = createApp({
            apiKey: 'k',
            fetchImpl: async () => fakeResponse(200, {choices: []}),
            rateLimiter: createRateLimiter({limit: 1, windowMs: 60000, now: () => 0}),
        });
        const first = await app({method: 'POST', path: '/api/agent/decide', body: {strategy: 's', state: {}}, ip: '1.1.1.1'});
        const second = await app({method: 'POST', path: '/api/agent/decide', body: {strategy: 's', state: {}}, ip: '1.1.1.1'});
        assert.strictEqual(first.status, 200);
        assert.strictEqual(second.status, 429);
        assert.strictEqual(second.body.error, 'RATE_LIMITED');
    });

    await testAsync('decide sends the system prompt and tool schema, and returns normalized actions', async () => {
        let sent;
        const providerPayload = {
            choices: [{message: {tool_calls: [{function: {name: 'build_tower', arguments: '{"type":"slow","i":4,"j":5}'}}]}}],
            usage: {total_tokens: 321},
        };
        const app = createApp({
            apiKey: 'secret-key',
            fetchImpl: async (url, options) => {
                sent = {url, options: JSON.parse(options.body), authorization: options.headers.authorization};
                return fakeResponse(200, providerPayload);
            },
        });

        const result = await app({
            method: 'POST',
            path: '/api/agent/decide',
            body: {strategy: 'build slow towers on the path', state: {wave: 2}},
            ip: '9.9.9.9',
        });

        assert.strictEqual(result.status, 200);
        assert.deepStrictEqual(result.body.actions, [{name: 'build_tower', arguments: {type: 'slow', i: 4, j: 5}}]);
        assert.deepStrictEqual(result.body.usage, {total_tokens: 321});

        assert.strictEqual(sent.options.messages[0].role, 'system');
        assert.strictEqual(sent.options.messages[0].content, SYSTEM_PROMPT);
        assert.ok(!sent.options.messages[0].content.includes('build slow towers'));
        assert.ok(sent.options.messages[1].content.includes('build slow towers'));
        assert.strictEqual(sent.options.model, 'deepseek-chat');
        assert.ok(Array.isArray(sent.options.tools) && sent.options.tools.length === 2);
        assert.strictEqual(sent.authorization, 'Bearer secret-key');
    });

    await testAsync('decide maps a provider auth failure to a 502 without leaking the key', async () => {
        const app = createApp({
            apiKey: 'secret-key',
            fetchImpl: async () => fakeResponse(401, {error: {message: 'Authentication Fails'}}),
        });
        const result = await app({method: 'POST', path: '/api/agent/decide', body: {strategy: 's', state: {}}});
        assert.strictEqual(result.status, 502);
        assert.strictEqual(result.body.error, 'PROVIDER_AUTH_ERROR');
        assert.ok(JSON.stringify(result.body).indexOf('secret-key') === -1);
    });

    await testAsync('decide maps a network failure to PROVIDER_UNAVAILABLE', async () => {
        const app = createApp({
            apiKey: 'k',
            fetchImpl: async () => {
                throw new Error('ECONNRESET');
            },
        });
        const result = await app({method: 'POST', path: '/api/agent/decide', body: {strategy: 's', state: {}}});
        assert.strictEqual(result.status, 502);
        assert.strictEqual(result.body.error, 'PROVIDER_UNAVAILABLE');
    });

    await testAsync('unknown routes return 404', async () => {
        const app = createApp({apiKey: 'k'});
        const result = await app({method: 'GET', path: '/nope'});
        assert.strictEqual(result.status, 404);
        assert.strictEqual(result.body.error, 'NOT_FOUND');
    });

    console.log('All agent proxy tests passed.');
})().catch(error => {
    process.exitCode = 1;
    console.error(error);
});
