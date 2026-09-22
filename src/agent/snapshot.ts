import {
    BuildCandidate,
    EnemyGroup,
    EnemyType,
    GameSnapshot,
    RouteInfo,
    ThreatInfo,
    TowerInfo,
    TowerOption,
} from './types';

/**
 * Turns raw battlefield data into the compact, semantic snapshot the LLM reasons
 * over (issue #4).
 *
 * The whole point is to give the model *understanding* rather than a grid dump:
 * enemy composition and urgency, which towers are actually engaging something,
 * the shape of every enemy route, and the few cells worth building on. Everything
 * here is pure and injected, so it is unit-tested without a DOM; the adapter is
 * the only part that touches the live engine.
 */

export interface EnemySample {
    type: EnemyType;
    life: number;
    damageTaken: number;
    i: number;
    j: number;
    /** Computed by the adapter from the enemy's remaining path and speed. */
    etaSeconds: number;
}

export interface RouteSample {
    spawn: { i: number; j: number };
    /** The full route as grid cells, spawn -> base. */
    cells: Array<{ i: number; j: number }>;
}

export interface SnapshotInput {
    wave: number;
    cash: number;
    baseLife: number;
    baseMaxLife: number;
    gridWidth: number;
    gridHeight: number;
    base: { i: number; j: number };
    spawns: Array<{ i: number; j: number }>;
    enemies: EnemySample[];
    towers: TowerInfo[];
    towerOptions: TowerOption[];
    /** One entry per enemy spawn. There can be 1-4, and every one must be defended. */
    routes: RouteSample[];
    /** Cheap check: is this cell empty? */
    isFree: (i: number, j: number) => boolean;
    /** Authoritative check (runs A*): may a tower legally stand here? */
    isBuildable: (i: number, j: number) => boolean;
}

/** Snapshot size ceiling, in serialized JSON characters. Enforced by tests. */
export const MAX_SNAPSHOT_CHARS = 8000;
export const MAX_TOWERS_IN_SNAPSHOT = 30;
export const MAX_BUILD_CANDIDATES = 8;
/** Reference tower reach used only to rank candidates; the engine stays authoritative. */
export const REFERENCE_AIM_RADIUS_TILES = 2;
/** Cap on A* calls per snapshot: probing legality is the expensive part. */
const MAX_BUILDABILITY_PROBES = 24;

function round(value: number, digits = 1): number {
    const factor = Math.pow(10, digits);
    return Math.round(value * factor) / factor;
}

function groupEnemies(enemies: EnemySample[]): EnemyGroup[] {
    const byType = new Map<EnemyType, { count: number; life: number; remaining: number }>();

    for (const enemy of enemies) {
        const group = byType.get(enemy.type) || { count: 0, life: 0, remaining: 0 };
        group.count += 1;
        group.life += enemy.life;
        group.remaining += Math.max(enemy.life - enemy.damageTaken, 0);
        byType.set(enemy.type, group);
    }

    const groups: EnemyGroup[] = [];
    byType.forEach((group, type) => {
        groups.push({
            type,
            count: group.count,
            avgLife: Math.round(group.life / group.count),
            avgRemainingLife: Math.round(group.remaining / group.count),
        });
    });

    return groups.sort((a, b) => b.count - a.count || a.type.localeCompare(b.type));
}

function nearestThreat(enemies: EnemySample[]): ThreatInfo | null {
    let nearest: ThreatInfo | null = null;

    for (const enemy of enemies) {
        if (nearest && enemy.etaSeconds >= nearest.etaSeconds) continue;
        nearest = {
            type: enemy.type,
            i: enemy.i,
            j: enemy.j,
            remainingLife: Math.round(Math.max(enemy.life - enemy.damageTaken, 0)),
            etaSeconds: round(enemy.etaSeconds),
        };
    }

    return nearest;
}

/** Keep only the cells where the route changes direction, plus both ends. */
function compressRoute(cells: Array<{ i: number; j: number }>): { waypoints: Array<{ i: number; j: number }>; length: number } | null {
    if (cells.length === 0) return null;

    const waypoints = [cells[0]];
    for (let index = 1; index < cells.length - 1; ++index) {
        const previous = cells[index - 1];
        const current = cells[index];
        const next = cells[index + 1];
        const incoming = { x: current.i - previous.i, y: current.j - previous.j };
        const outgoing = { x: next.i - current.i, y: next.j - current.j };

        if (incoming.x !== outgoing.x || incoming.y !== outgoing.y) {
            waypoints.push(current);
        }
    }
    if (cells.length > 1) waypoints.push(cells[cells.length - 1]);

    return { waypoints, length: cells.length - 1 };
}

interface ScoredCell {
    i: number;
    j: number;
    /** Route this cell primarily serves. */
    route: number;
    /** Cells of that route within the reference radius. */
    coverage: number;
    distanceToBase: number;
    /** Total coverage summed over every route this cell overlaps. */
    totalCoverage: number;
    routesCovered: number;
}

/** Free cells adjacent to a route, scored by how much of it a tower would cover. */
function scoreRoute(
    input: SnapshotInput,
    cells: Array<{ i: number; j: number }>,
    routeIndex: number
): ScoredCell[] {
    if (cells.length === 0) return [];

    const onRoute = new Set<string>();
    cells.forEach(cell => onRoute.add(`${cell.i}:${cell.j}`));

    const inGrid = (i: number, j: number) =>
        i >= 0 && j >= 0 && i < input.gridWidth && j < input.gridHeight;

    const neighbours = new Map<string, { i: number; j: number }>();
    for (const cell of cells) {
        for (let di = -1; di <= 1; ++di) {
            for (let dj = -1; dj <= 1; ++dj) {
                if (di === 0 && dj === 0) continue;
                const i = cell.i + di;
                const j = cell.j + dj;
                if (!inGrid(i, j)) continue;
                const key = `${i}:${j}`;
                if (onRoute.has(key) || neighbours.has(key)) continue;
                if (!input.isFree(i, j)) continue;
                neighbours.set(key, { i, j });
            }
        }
    }

    const radiusSquared = REFERENCE_AIM_RADIUS_TILES * REFERENCE_AIM_RADIUS_TILES;
    const scored: ScoredCell[] = [];

    neighbours.forEach(cell => {
        let coverage = 0;
        let deepestIndex = -1;

        for (let index = 0; index < cells.length; ++index) {
            const di = cells[index].i - cell.i;
            const dj = cells[index].j - cell.j;
            if (di * di + dj * dj <= radiusSquared) {
                coverage += 1;
                deepestIndex = index;
            }
        }

        if (coverage === 0) return;
        scored.push({
            i: cell.i,
            j: cell.j,
            route: routeIndex,
            coverage,
            distanceToBase: cells.length - 1 - deepestIndex,
            totalCoverage: coverage,
            routesCovered: 1,
        });
    });

    return scored;
}

/**
 * Best buildable cells across every route.
 *
 * A cell can serve more than one route; those shared choke points score higher.
 * Each route gets a reserved quota first, so enabling a second/third/fourth
 * spawn can never leave that lane with nothing recommended (issue #38).
 */
function buildCandidates(input: SnapshotInput): BuildCandidate[] {
    if (input.routes.length === 0) return [];

    // Merge per-route scores into one record per cell.
    const merged = new Map<string, ScoredCell>();
    input.routes.forEach((route, routeIndex) => {
        for (const cell of scoreRoute(input, route.cells, routeIndex)) {
            const key = `${cell.i}:${cell.j}`;
            const entry = merged.get(key);
            if (!entry) {
                merged.set(key, cell);
                continue;
            }
            entry.totalCoverage += cell.coverage;
            entry.routesCovered += 1;
            if (cell.coverage > entry.coverage) {
                entry.coverage = cell.coverage;
                entry.route = routeIndex;
                entry.distanceToBase = cell.distanceToBase;
            }
        }
    });

    const all = Array.from(merged.values());
    const accepted: ScoredCell[] = [];
    const acceptedKeys = new Set<string>();
    let probes = 0;

    const accept = (cell: ScoredCell): boolean => {
        if (accepted.length >= MAX_BUILD_CANDIDATES || probes >= MAX_BUILDABILITY_PROBES) return false;
        const key = `${cell.i}:${cell.j}`;
        if (acceptedKeys.has(key)) return false;
        probes += 1;
        if (!input.isBuildable(cell.i, cell.j)) return false;
        accepted.push(cell);
        acceptedKeys.add(key);
        return true;
    };

    // Pass 1: reserve a fair share per route so no lane is ignored.
    const quota = Math.max(1, Math.ceil(MAX_BUILD_CANDIDATES / input.routes.length));
    input.routes.forEach((_, routeIndex) => {
        const forRoute = all
            .filter(cell => cell.route === routeIndex)
            .sort((a, b) => b.coverage - a.coverage || a.distanceToBase - b.distanceToBase);

        let taken = 0;
        for (const cell of forRoute) {
            if (taken >= quota) break;
            if (accept(cell)) taken += 1;
        }
    });

    // Pass 2: fill the rest by overall value; cells covering several routes rank high.
    const rest = all
        .filter(cell => !acceptedKeys.has(`${cell.i}:${cell.j}`))
        .sort((a, b) => b.totalCoverage - a.totalCoverage || a.distanceToBase - b.distanceToBase);
    for (const cell of rest) {
        if (accepted.length >= MAX_BUILD_CANDIDATES || probes >= MAX_BUILDABILITY_PROBES) break;
        accept(cell);
    }

    return accepted
        .sort((a, b) => a.route - b.route || b.coverage - a.coverage || a.distanceToBase - b.distanceToBase)
        .map(cell => ({
            i: cell.i,
            j: cell.j,
            route: cell.route,
            coverage: cell.coverage,
            distanceToBase: cell.distanceToBase,
            routesCovered: cell.routesCovered,
        }));
}

export function buildSnapshot(input: SnapshotInput): GameSnapshot {
    const groups = groupEnemies(input.enemies);

    const towers = input.towers
        .slice()
        .sort((a, b) => b.level - a.level || b.dps - a.dps)
        .slice(0, MAX_TOWERS_IN_SNAPSHOT);

    const routes: RouteInfo[] = [];
    for (const route of input.routes) {
        const compressed = compressRoute(route.cells);
        if (compressed) routes.push({ spawn: route.spawn, ...compressed });
    }

    return {
        wave: input.wave,
        cash: input.cash,
        baseLife: input.baseLife,
        baseMaxLife: input.baseMaxLife,
        grid: { width: input.gridWidth, height: input.gridHeight },
        base: input.base,
        spawns: input.spawns,
        enemies: {
            total: input.enemies.length,
            groups,
            nearestThreat: nearestThreat(input.enemies),
        },
        towers,
        towerOptions: input.towerOptions,
        routes,
        buildCandidates: buildCandidates(input),
    };
}

/** Human-readable dump, for comparing what the AI saw against the screen. */
export function formatSnapshot(snapshot: GameSnapshot): string {
    const threat = snapshot.enemies.nearestThreat;
    const groups = snapshot.enemies.groups
        .map(group => `${group.type} x${group.count} (hp~${group.avgRemainingLife}/${group.avgLife})`)
        .join(', ');

    const towers = snapshot.towers
        .map(tower => `${tower.type} L${tower.level}@(${tower.i},${tower.j})${tower.targetInRange ? '*' : ''}`)
        .join(', ');

    const routes = snapshot.routes
        .map((route, index) => `#${index} from (${route.spawn.i},${route.spawn.j}) ${route.waypoints.length}wp/${route.length}t`)
        .join('; ');

    const candidates = snapshot.buildCandidates
        .map(candidate => `r${candidate.route}(${candidate.i},${candidate.j}) cov${candidate.coverage}${candidate.routesCovered > 1 ? ` x${candidate.routesCovered}` : ''} dBase${candidate.distanceToBase}`)
        .join('; ');

    return [
        `Wave ${snapshot.wave} · cash ${snapshot.cash} · base ${snapshot.baseLife}/${snapshot.baseMaxLife}`,
        `Enemies (${snapshot.enemies.total}): ${groups || 'none'}`,
        `Nearest threat: ${threat ? `${threat.type} at (${threat.i},${threat.j}) ETA ${threat.etaSeconds}s hp ${threat.remainingLife}` : 'none'}`,
        `Towers (${snapshot.towers.length}): ${towers || 'none'}`,
        `Routes (${snapshot.routes.length}): ${routes || 'none'}`,
        `Build candidates: ${candidates || 'none'}`,
    ].join('\n');
}
