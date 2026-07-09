// Minimal test harness for src/lib's game engine.
//
// Per CLAUDE.md's "Verifying changes" section, there's no unit-test harness —
// the established way to exercise game logic headlessly is to eval the
// compiled ios/IsleWars/Resources/game-bundle.js in Node and drive
// `globalThis.IsleWars` (see scripts/simulate.mjs for the same pattern).
// This module formalizes that into something node:test files can import.
//
// IMPORTANT: run `npm run build:ios-bridge` before running tests if src/lib
// changed — the bundle is a build artifact, not regenerated automatically
// here (keeps test runs fast; `npm test` does it for you).

import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BUNDLE_PATH = path.join(__dirname, '../../ios/IsleWars/Resources/game-bundle.js');

if (!existsSync(BUNDLE_PATH)) {
	throw new Error(`${BUNDLE_PATH} not found — run \`npm run build:ios-bridge\` first.`);
}
const bundleCode = readFileSync(BUNDLE_PATH, 'utf8');

/**
 * Evaluates a fresh copy of the compiled engine into the current global
 * scope, replacing `globalThis.IsleWars`. The bundle is an esbuild IIFE
 * (`(() => { ... })()`), so its `let`/`const` module state is scoped to that
 * closure, not the real global lexical environment — re-eval-ing it here is
 * safe to call once per test and gives each test its own isolated engine
 * instance (no state leaking from a previous test in the same file).
 */
export function freshEngine() {
	(0, eval)(bundleCode);
	const IW = globalThis.IsleWars;
	if (!IW) throw new Error('game-bundle.js did not set globalThis.IsleWars');
	return IW;
}

/** Starts a game and returns the parsed state. */
export function newGameState(IW, difficulty = 2, startingArmies = 3) {
	return JSON.parse(IW.startGame(difficulty, startingArmies));
}

/**
 * Replaces the whole engine state (the bridge's `loadState` does a full
 * `game.set`) and returns the state as read back from the engine. Lets a
 * test build an exact board — owners, armies, walls/rivers/tunnels, phase,
 * hands — instead of fighting map generation and turn-start RNG to reach it.
 */
export function load(IW, state) {
	return JSON.parse(IW.loadState(JSON.stringify(state)));
}

/**
 * Finds a same-island adjacent hex pair. Tests that need a specific two-hex
 * scenario (attacks, walls, rivers, tunnels) use this instead of hardcoding
 * grid ids, since the map is procedurally generated per seed.
 */
export function findLandEdge(state) {
	for (const g of state.map.grids) {
		for (const n of state.map.adj[g.id]) {
			if (n > g.id && state.map.grids[n].island === g.island) return [g.id, n];
		}
	}
	throw new Error('No adjacent same-island hex pair found on this map');
}

/**
 * Finds a non-adjacent hex pair with a clear straight-line water path
 * between them (what Ferry/Water Invasion require), via `IW.hasClearWaterPath`
 * — an O(n^2) scan over the generated map, fine for a one-off test setup.
 */
export function findWaterCrossing(IW, state) {
	const ids = state.map.grids.map((g) => g.id);
	for (const a of ids) {
		for (const b of ids) {
			if (b <= a) continue;
			if (state.map.adj[a].includes(b)) continue;
			if (IW.hasClearWaterPath(a, b)) return [a, b];
		}
	}
	throw new Error('No clear water crossing found on this map');
}

/**
 * Finds a legal Tunnel pair: NOT already adjacent (canTunnelConnect rejects
 * an existing route — "nothing to tunnel to"), but reachable within
 * TUNNEL_MAX_STEPS over land, with a straight line that stays clear.
 * Strips every wall/river/tunnel map-wide first so only real geometry (not
 * leftover map-gen obstacles) decides reachability — callers should apply
 * the same wipe to the state they actually load for the test.
 */
export function findTunnelPair(IW, baseState) {
	const s = structuredClone(baseState);
	s.map.walls = [];
	s.map.rivers = [];
	s.map.tunnels = [];
	const grids = s.map.grids;
	for (const start of grids) {
		const dist = new Map([[start.id, 0]]);
		const queue = [start.id];
		const candidates = [];
		while (queue.length) {
			const cur = queue.shift();
			const d = dist.get(cur);
			if (d >= 3) continue;
			for (const nb of s.map.adj[cur]) {
				if (dist.has(nb)) continue;
				if (grids[nb].island !== start.island) continue;
				const isSeaLane = s.map.seaLanes.some(([x, y]) => (x === cur && y === nb) || (x === nb && y === cur));
				if (isSeaLane) continue;
				dist.set(nb, d + 1);
				queue.push(nb);
				if (!s.map.adj[start.id].includes(nb)) candidates.push(nb);
			}
		}
		for (const b of candidates) {
			const trial = structuredClone(s);
			setHex(trial, start.id, 'blue', 5);
			setHex(trial, b, 'green', 5);
			trial.current = 'blue';
			load(IW, trial);
			if (IW.canTunnelConnect(start.id, b)) return [start.id, b];
		}
	}
	throw new Error('No legal tunnel pair found on this map');
}

/** Clears any wall/river/tunnel/sea-lane already on an edge, so a test starts
 *  from a known-clean edge regardless of what map generation put there. */
export function clearEdge(state, a, b) {
	const same = ([x, y]) => (x === a && y === b) || (x === b && y === a);
	state.map.walls = (state.map.walls ?? []).filter((e) => !same(e));
	state.map.rivers = (state.map.rivers ?? []).filter((e) => !same(e));
	state.map.tunnels = (state.map.tunnels ?? []).filter((e) => !same(e));
	state.map.seaLanes = (state.map.seaLanes ?? []).filter((e) => !same(e));
}

/**
 * Sets ownership/armies for a hex in place, and normalizes it to a plain,
 * unmodified hex (terrain 'plain', no fortify/rampart) — the procedurally
 * generated map can hand back any terrain for a given id, and leftover
 * mountain/forest/fortify bonuses would silently confound a test that isn't
 * deliberately exercising terrain. Tests that want a specific terrain or
 * modifier set it explicitly afterward.
 */
export function setHex(state, id, owner, armies) {
	state.states[id].owner = owner;
	state.states[id].armies = armies;
	state.states[id].fortified = false;
	state.states[id].rampart = false;
	state.map.grids[id].terrain = 'plain';
}

/**
 * Runs `fn` with `Math.random()` returning a fixed queue of values (falling
 * back to the real generator once the queue is exhausted), then restores it.
 * `rollDie()` (src/lib/game.ts) calls `Math.random()` directly with no
 * seedable RNG, so this is how tests force a specific attack roll — e.g.
 * `withFixedRolls([0.99, 0], () => IW.rollAttack())` forces the attacker's
 * die to its max face and the defender's to its min face. Works against the
 * eval'd bundle because indirect eval runs in the real global scope, so it
 * shares this process's single `Math` object.
 */
export function withFixedRolls(values, fn) {
	const real = Math.random;
	const queue = [...values];
	Math.random = () => (queue.length ? queue.shift() : real());
	try {
		return fn();
	} finally {
		Math.random = real;
	}
}
