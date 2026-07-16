// Artillery: bombards a hex within 2 steps from a city, four guaranteed-roll
// shots, attacker never loses armies. Ignores mountain/fortified/rampart
// defense bonuses — the point of the card is to be a second hard counter to
// a dug-in defender that doesn't need Tunnel's land-path geometry.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freshEngine, newGameState, load, findLandEdge, clearEdge, setHex, withFixedRolls } from './helpers/engine.mjs';

function artilleryScenario(IW) {
	const s = newGameState(IW);
	const [a, b] = findLandEdge(s);
	clearEdge(s, a, b);
	setHex(s, a, 'blue', 5);
	setHex(s, b, 'green', 5);
	s.map.grids[a].production = 1;
	s.map.grids[b].terrain = 'mountain';
	s.states[b].fortified = true;
	s.states[b].rampart = true;
	s.current = 'blue';
	s.phase = 'action';
	s.hands.blue = ['artillery'];
	load(IW, s);
	return { from: a, to: b };
}

test('Artillery ignores mountain/fortified/rampart bonuses', () => {
	const IW = freshEngine();
	const { from, to } = artilleryScenario(IW);
	assert.equal(IW.defenseBonus(to), 4, 'sanity check: mountain +1, fortified +2, rampart +1');

	let s = JSON.parse(IW.playCard(0));
	assert.equal(s.phase, 'artillery_from');
	s = JSON.parse(IW.selectGrid(from));
	assert.equal(s.phase, 'artillery_to');
	// atk die 4 vs def die 1: a hit only if the +4 defense bonus is bypassed
	// (unbypassed it'd be 4 vs 1+4=5, a miss) — repeated for all 4 shots.
	s = withFixedRolls([0.5, 0, 0.5, 0, 0.5, 0, 0.5, 0], () => JSON.parse(IW.selectGrid(to)));
	assert.equal(s.phase, 'action');
	assert.equal(s.states[to].armies, 1, 'all 4 shots hit despite the defender\'s stacked bonuses');
});
