// Desert heat attrition: at the START of a player's turn every desert hex
// they hold loses 1 army, flooring at 0 (the hex stays owned, just
// undefended). This replaced the old "burn 1 army on move-in" rule — moving
// or conquering into a desert costs nothing on arrival.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freshEngine, newGameState, load } from './helpers/engine.mjs';

const ORDER = ['blue', 'green', 'red', 'brown'];

// Ends the current turn so the NEXT player's beginTurn (where attrition
// runs) fires. Returns the resulting state.
function advanceToNextTurn(IW) {
	return JSON.parse(IW.endTurn());
}

test('start of turn: each owned desert hex loses 1 army, floored at 0', () => {
	const IW = freshEngine();
	const s = newGameState(IW);
	const next = ORDER[(ORDER.indexOf(s.current) + 1) % ORDER.length];
	const owned = s.states.map((st, i) => (st.owner === next ? i : -1)).filter((i) => i >= 0);
	assert.ok(owned.length >= 3, 'next player needs 3 hexes for the scenario');
	// The map is procedurally generated (unseeded), so `next` may already own
	// other desert hexes by chance — neutralize those first so only the three
	// hexes below contribute to the attrition count.
	for (const g of s.map.grids) {
		if (g.terrain === 'desert' && s.states[g.id].owner === next) g.terrain = 'plain';
	}
	const [d3, d1, d0] = owned;
	s.map.grids[d3].terrain = 'desert';
	s.states[d3].armies = 3;
	s.map.grids[d1].terrain = 'desert';
	s.states[d1].armies = 1;
	s.map.grids[d0].terrain = 'desert';
	s.states[d0].armies = 0;
	s.phase = 'action';
	// startGame's own initial beginTurn may have already logged desert events
	// for whichever player went first (if they happened to own a natural
	// desert hex) — clear the log so only this test's turn transition counts.
	s.armyEvents = [];
	load(IW, s);

	const after = advanceToNextTurn(IW);
	assert.equal(after.current, next);
	assert.equal(after.states[d3].armies, 2, '3 armies -> 2');
	assert.equal(after.states[d1].armies, 0, '1 army -> 0 (floor)');
	assert.equal(after.states[d0].armies, 0, '0 armies stays 0, never negative');
	assert.equal(after.states[d1].owner, next, 'a 0-army desert hex stays owned');
	const desertEvents = (after.armyEvents ?? []).filter((e) => e.cause === 'desert');
	assert.equal(desertEvents.length, 2, 'one army event per hex that actually lost an army');
	assert.ok(
		after.log.some((l) => l.text.includes('Desert heat')),
		'attrition is logged'
	);
});

test("other players' desert hexes are untouched at your turn start", () => {
	const IW = freshEngine();
	const s = newGameState(IW);
	const next = ORDER[(ORDER.indexOf(s.current) + 1) % ORDER.length];
	const other = ORDER[(ORDER.indexOf(s.current) + 2) % ORDER.length];
	const otherHex = s.states.findIndex((st) => st.owner === other);
	assert.ok(otherHex >= 0);
	s.map.grids[otherHex].terrain = 'desert';
	s.states[otherHex].armies = 5;
	s.phase = 'action';
	load(IW, s);

	const after = advanceToNextTurn(IW);
	assert.equal(after.current, next);
	assert.equal(after.states[otherHex].armies, 5, 'attrition only hits the player whose turn begins');
});

test('moving into a desert no longer costs an army on arrival', () => {
	const IW = freshEngine();
	const s = newGameState(IW);
	// Find two adjacent hexes we can hand to blue, target being made desert.
	let from = -1;
	let to = -1;
	outer: for (let i = 0; i < s.states.length; i++) {
		for (const n of s.map.adj[i]) {
			if (n !== i) {
				from = i;
				to = n;
				break outer;
			}
		}
	}
	assert.ok(from >= 0 && to >= 0);
	s.states[from] = { ...s.states[from], owner: 'blue', armies: 6 };
	s.states[to] = { ...s.states[to], owner: 'blue', armies: 2 };
	s.map.grids[to].terrain = 'desert';
	// Clear any wall on the edge so the move is legal.
	s.map.walls = (s.map.walls ?? []).filter(
		([a, b]) => !(a === Math.min(from, to) && b === Math.max(from, to))
	);
	s.current = 'blue';
	s.phase = 'action';
	load(IW, s);

	JSON.parse(IW.beginMove());
	JSON.parse(IW.selectGrid(from));
	JSON.parse(IW.selectGrid(to));
	const after = JSON.parse(IW.confirmMove(3));
	assert.equal(after.states[to].armies, 5, '2 + 3 arrive intact, no heat toll');
});
