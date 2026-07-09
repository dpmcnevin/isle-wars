// Packed custom-map seeds (the map editor's CUSTOM- format): a custom game's
// seed encodes the whole painted map — terrain, cities, rivers/walls, starting
// placements, and rules — so startGame(…, seed) rebuilds the exact game the
// way a procedural seed does. See the codec in src/lib/map.ts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freshEngine } from './helpers/engine.mjs';

// Hand-written seed on the 11-col canvas grid. Painted cells:
//   1: plain+city  2: plain      (island A; river on their shared edge)
//   5: mountain    6: forest     (island B, not touching island A)
//   12: plain      13: desert    (row 1 — hex-adjacent to cells 1/2, island A)
// Placements (cell/playerIndex/armies): 1/0/5, 2/1/5, 12/2/10, 13/3/10.
// Rules: difficulty 3, startingArmies 3. PLAYERS order: blue,green,red,brown.
const SEED = 'CUSTOM-N2P2NMF5NPD.C01.R0102.G01005021050C20A0D30A.S303';

function startFromSeed(IW, seed = SEED) {
	// Deliberately pass mismatching difficulty/armies — the seed's own must win.
	IW.startGame(1, 9, seed);
	return JSON.parse(IW.getState());
}

test('custom seed decodes to the painted map', () => {
	const s = startFromSeed(freshEngine());
	assert.equal(s.map.grids.length, 6);
	assert.deepEqual(
		s.map.grids.map((g) => g.terrain),
		['plain', 'plain', 'mountain', 'forest', 'plain', 'desert']
	);
	assert.equal(s.map.grids[0].production, true, 'city painted at cell 1');
	assert.deepEqual(s.map.rivers, [[0, 1]], 'river on the 1-2 edge');
	assert.equal(new Set(s.map.grids.map((g) => g.island)).size, 2, 'two islands');
});

test('custom seed applies placements and rules', () => {
	const s = startFromSeed(freshEngine());
	assert.deepEqual(
		s.states.map((st) => st.owner),
		['blue', 'green', null, null, 'red', 'brown']
	);
	assert.deepEqual(
		s.states.map((st) => st.armies),
		[5, 5, 0, 0, 10, 10]
	);
	assert.equal(s.difficulty, 3, "the seed's difficulty beats the passed-in arg");
	assert.equal(s.startingArmies, 3, "the seed's startingArmies beats the passed-in arg");
});

test('custom seed is canonical: state.seed round-trips to the pasted string', () => {
	const s = startFromSeed(freshEngine());
	assert.equal(s.seed, SEED);
});

test('custom seed is deterministic across games (capitals, start player, names)', () => {
	const a = startFromSeed(freshEngine());
	const b = startFromSeed(freshEngine());
	assert.deepEqual(b.capitals, a.capitals);
	assert.equal(b.current, a.current);
	assert.equal(JSON.stringify(b.map), JSON.stringify(a.map), 'identical map incl. island/city names');
});

test('an undecodable CUSTOM- seed falls back to a fresh procedural game', () => {
	const IW = freshEngine();
	const s = startFromSeed(IW, 'CUSTOM-???NOT-A-REAL-SEED');
	assert.ok(!s.seed.startsWith('CUSTOM-'), 'got a real procedural seed, not a garbage board');
	assert.ok(s.map.grids.length > 20, 'procedural map generated');
});
