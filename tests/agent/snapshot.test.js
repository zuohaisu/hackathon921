const assert = require('assert');
const {
    buildSnapshot,
    formatSnapshot,
    MAX_SNAPSHOT_CHARS,
    MAX_TOWERS_IN_SNAPSHOT,
    MAX_BUILD_CANDIDATES,
} = require('../../.test-build/agent/snapshot.js');

/**
 * DOM-free tests for the compressed observation (issue #4) and its multi-route
 * defence (issue #38).
 *
 * buildSnapshot is pure and injected, so the metrics the model reasons over —
 * composition, urgency, route shape, per-lane candidate balance, size — are all
 * pinned down here without touching the engine.
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

function enemy(type, over = {}) {
    return {type, life: 100, damageTaken: 0, i: 0, j: 0, etaSeconds: 10, ...over};
}

function tower(i, j, level = 1, dps = 50) {
    return {
        id: `${i}:${j}`,
        type: 'canon',
        i,
        j,
        level,
        upgradeCost: 30,
        aimRadius: 100,
        damage: 25,
        reloadMs: 400,
        dps,
        targetInRange: false,
    };
}

function route(spawn, cells) {
    return {spawn, cells};
}

function straightRoute(i = 0) {
    return route({i: 0, j: i}, [{i: 0, j: i}, {i: 1, j: i}, {i: 2, j: i}, {i: 3, j: i}, {i: 4, j: i}]);
}

function baseInput(over = {}) {
    return {
        wave: 4,
        cash: 250,
        baseLife: 12,
        baseMaxLife: 15,
        gridWidth: 8,
        gridHeight: 5,
        base: {i: 4, j: 2},
        spawns: [{i: 0, j: 0}],
        enemies: [],
        towers: [],
        towerOptions: [{type: 'canon', name: 'Canon', description: '', cost: 50, aimRadius: 100, dps: 62.5}],
        routes: [],
        isFree: () => true,
        isBuildable: () => true,
        ...over,
    };
}

console.log('snapshot');

test('groups enemies by type with average life and remaining life', () => {
    const snapshot = buildSnapshot(baseInput({
        enemies: [
            enemy('simple', {life: 100, damageTaken: 0}),
            enemy('simple', {life: 100, damageTaken: 40}),
            enemy('fast', {life: 60, damageTaken: 0}),
        ],
    }));

    assert.strictEqual(snapshot.enemies.total, 3);

    const simple = snapshot.enemies.groups.find(group => group.type === 'simple');
    assert.strictEqual(simple.count, 2);
    assert.strictEqual(simple.avgLife, 100);
    assert.strictEqual(simple.avgRemainingLife, 80);
});

test('nearestThreat is the enemy with the smallest ETA', () => {
    const snapshot = buildSnapshot(baseInput({
        enemies: [
            enemy('simple', {etaSeconds: 30}),
            enemy('boss', {etaSeconds: 4, life: 500, damageTaken: 120, i: 3, j: 2}),
        ],
    }));

    assert.deepStrictEqual(snapshot.enemies.nearestThreat, {
        type: 'boss',
        i: 3,
        j: 2,
        remainingLife: 380,
        etaSeconds: 4,
    });
});

test('every route is reported with its spawn, compressed waypoints and length', () => {
    const snapshot = buildSnapshot(baseInput({
        routes: [
            route({i: 0, j: 0}, [{i: 0, j: 0}, {i: 1, j: 0}, {i: 2, j: 0}, {i: 2, j: 1}, {i: 2, j: 2}]),
            straightRoute(4),
        ],
    }));

    assert.strictEqual(snapshot.routes.length, 2);
    assert.deepStrictEqual(snapshot.routes[0], {
        spawn: {i: 0, j: 0},
        waypoints: [{i: 0, j: 0}, {i: 2, j: 0}, {i: 2, j: 2}],
        length: 4,
    });
    assert.deepStrictEqual(snapshot.routes[1].spawn, {i: 0, j: 4});
});

test('no routes means no candidates', () => {
    const snapshot = buildSnapshot(baseInput());
    assert.deepStrictEqual(snapshot.routes, []);
    assert.deepStrictEqual(snapshot.buildCandidates, []);
});

test('candidates are off-route, free, legal, and ranked within their route', () => {
    const snapshot = buildSnapshot(baseInput({
        routes: [straightRoute(0)],
        isFree: (i, j) => !(i === 1 && j === 1),
        isBuildable: (i, j) => !(i === 3 && j === 1),
    }));

    const candidates = snapshot.buildCandidates;
    assert.ok(candidates.length > 0);
    assert.ok(candidates.every(candidate => candidate.route === 0));
    assert.ok(!candidates.some(c => c.j === 0 && c.i <= 4), 'route cells must not be candidates');
    assert.ok(!candidates.some(c => c.i === 1 && c.j === 1), 'occupied cells are excluded');
    assert.ok(!candidates.some(c => c.i === 3 && c.j === 1), 'cells the engine rejects are excluded');

    for (let index = 1; index < candidates.length; ++index) {
        assert.ok(
            candidates[index - 1].coverage >= candidates[index].coverage,
            'candidates must be ranked by coverage first'
        );
    }
});

test('every lane gets recommended cells, so no route is ignored', () => {
    const snapshot = buildSnapshot(baseInput({
        routes: [straightRoute(0), straightRoute(4)],
    }));

    const routes = new Set(snapshot.buildCandidates.map(candidate => candidate.route));
    assert.ok(routes.has(0), 'bottom lane must be covered');
    assert.ok(routes.has(1), 'top lane must be covered');

    const perRoute = {};
    snapshot.buildCandidates.forEach(candidate => {
        perRoute[candidate.route] = (perRoute[candidate.route] || 0) + 1;
    });
    assert.ok(perRoute[0] >= 1 && perRoute[1] >= 1, `expected both lanes to get candidates, got ${JSON.stringify(perRoute)}`);
});

test('a cell covering several routes is marked as a shared choke point', () => {
    const snapshot = buildSnapshot(baseInput({
        gridHeight: 5,
        routes: [
            // Two lanes converging on the base at (4,2).
            route({i: 0, j: 0}, [{i: 0, j: 0}, {i: 1, j: 0}, {i: 2, j: 0}, {i: 3, j: 0}, {i: 4, j: 0}, {i: 4, j: 1}, {i: 4, j: 2}]),
            route({i: 0, j: 4}, [{i: 0, j: 4}, {i: 1, j: 4}, {i: 2, j: 4}, {i: 3, j: 4}, {i: 4, j: 4}, {i: 4, j: 3}, {i: 4, j: 2}]),
        ],
    }));

    const shared = snapshot.buildCandidates.filter(candidate => candidate.routesCovered >= 2);
    assert.ok(shared.length > 0, 'expected at least one candidate covering both lanes');
});

test('candidates are capped', () => {
    const cells = [];
    for (let i = 0; i < 40; ++i) cells.push({i: i % 40, j: 0});

    const snapshot = buildSnapshot(baseInput({
        gridWidth: 60,
        gridHeight: 3,
        routes: [route({i: 0, j: 0}, cells)],
    }));

    assert.ok(snapshot.buildCandidates.length <= MAX_BUILD_CANDIDATES);
});

test('towers are ranked by level and capped', () => {
    const towers = [];
    for (let index = 0; index < 80; ++index) towers.push(tower(index % 40, Math.floor(index / 40) + 1, (index % 5) + 1));

    const snapshot = buildSnapshot(baseInput({gridWidth: 40, gridHeight: 10, towers}));

    assert.strictEqual(snapshot.towers.length, MAX_TOWERS_IN_SNAPSHOT);
    for (let index = 1; index < snapshot.towers.length; ++index) {
        assert.ok(snapshot.towers[index - 1].level >= snapshot.towers[index].level);
    }
});

test('a busy battlefield with four lanes still fits the token budget', () => {
    const enemies = [];
    const types = ['simple', 'fast', 'armored', 'healer', 'boss'];
    for (let index = 0; index < 300; ++index) {
        enemies.push(enemy(types[index % types.length], {i: index % 60, j: index % 30, etaSeconds: 100 - (index % 90)}));
    }

    const towers = [];
    for (let index = 0; index < 80; ++index) towers.push(tower(index % 60, index % 30, 3));

    const routes = [
        route({i: 0, j: 0}, Array.from({length: 90}, (_, index) => ({i: index, j: 0}))),
        route({i: 60, j: 0}, Array.from({length: 90}, (_, index) => ({i: 60 - index, j: 30}))),
        route({i: 0, j: 30}, Array.from({length: 90}, (_, index) => ({i: index, j: 30}))),
        route({i: 60, j: 30}, Array.from({length: 90}, (_, index) => ({i: 60 - index, j: 0}))),
    ];

    const snapshot = buildSnapshot(baseInput({
        gridWidth: 61,
        gridHeight: 31,
        enemies,
        towers,
        routes,
        spawns: routes.map(entry => entry.spawn),
    }));

    const size = JSON.stringify(snapshot).length;
    assert.ok(size <= MAX_SNAPSHOT_CHARS, `snapshot is ${size} chars, budget is ${MAX_SNAPSHOT_CHARS}`);
});

test('formatSnapshot renders the facts the model saw', () => {
    const snapshot = buildSnapshot(baseInput({
        enemies: [enemy('fast', {etaSeconds: 3})],
        towers: [{...tower(2, 1, 2), targetInRange: true}],
        routes: [straightRoute(0), straightRoute(4)],
    }));

    const text = formatSnapshot(snapshot);
    assert.ok(text.includes('Wave 4'));
    assert.ok(text.includes('fast x1'));
    assert.ok(text.includes('ETA 3s'));
    assert.ok(text.includes('canon L2@(2,1)*'));
    assert.ok(text.includes('Routes (2)'));
    assert.ok(text.includes('Build candidates'));
});

console.log('All snapshot tests passed.');
