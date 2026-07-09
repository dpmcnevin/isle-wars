// Core attack-resolution rules: dice comparison, army loss, and conquest.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freshEngine, newGameState, load, findLandEdge, clearEdge, setHex, withFixedRolls } from './helpers/engine.mjs';

// Builds a clean (no wall/river/tunnel/lane) two-hex attack scenario:
// blue at `from` (attacker) vs. green at `to` (defender), phase already at
// 'attack_rolling' so the test can call rollAttack() directly.
function attackScenario(IW, { fromArmies = 5, toArmies = 5 } = {}) {
	const s = newGameState(IW);
	const [a, b] = findLandEdge(s);
	clearEdge(s, a, b);
	setHex(s, a, 'blue', fromArmies);
	setHex(s, b, 'green', toArmies);
	s.current = 'blue';
	s.phase = 'attack_rolling';
	s.selectedFrom = a;
	s.selectedTo = b;
	load(IW, s);
	return { from: a, to: b };
}

test('attacker roll > defender roll: defender loses one army', () => {
	const IW = freshEngine();
	const { from, to } = attackScenario(IW, { fromArmies: 5, toArmies: 5 });
	const after = withFixedRolls([0.99, 0], () => JSON.parse(IW.rollAttack()));
	assert.equal(after.states[to].armies, 4);
	assert.equal(after.states[to].owner, 'green');
	assert.equal(after.states[from].armies, 5, 'attacker keeps its armies on a win');
});

test('attacker roll <= defender roll: attacker loses one army', () => {
	const IW = freshEngine();
	const { from, to } = attackScenario(IW, { fromArmies: 5, toArmies: 5 });
	const after = withFixedRolls([0, 0.99], () => JSON.parse(IW.rollAttack()));
	assert.equal(after.states[from].armies, 4);
	assert.equal(after.states[to].armies, 5, 'defender keeps its armies on a loss');
});

test('a tied roll favors the defender', () => {
	const IW = freshEngine();
	const { from } = attackScenario(IW, { fromArmies: 5, toArmies: 5 });
	// Same random value on both calls -> same base roll, no bonuses either side.
	const after = withFixedRolls([0.5, 0.5], () => JSON.parse(IW.rollAttack()));
	assert.equal(after.states[from].armies, 4, 'attacker loses the tie');
});

test('defender reduced to 0 armies is conquered: ownership transfers, a garrison moves in', () => {
	const IW = freshEngine();
	const { from, to } = attackScenario(IW, { fromArmies: 5, toArmies: 1 });
	const after = withFixedRolls([0.99, 0], () => JSON.parse(IW.rollAttack()));
	assert.equal(after.states[to].owner, 'blue');
	assert.equal(after.states[to].armies, 1, 'exactly one army moves in by default');
	assert.equal(after.states[from].armies, 4);
	assert.equal(after.phase, 'attack_move_in');
	assert.equal(after.conquests.at(-1).grid, to);
	assert.equal(after.conquests.at(-1).attacker, 'blue');
});

test('mountain terrain gives the defender +1', () => {
	const IW = freshEngine();
	const s = newGameState(IW);
	const [a, b] = findLandEdge(s);
	clearEdge(s, a, b);
	setHex(s, a, 'blue', 5);
	setHex(s, b, 'green', 5);
	s.map.grids[b].terrain = 'mountain';
	s.current = 'blue';
	s.phase = 'attack_rolling';
	s.selectedFrom = a;
	s.selectedTo = b;
	load(IW, s);
	// Same base roll for both sides (0.5/0.5 -> equal dice); the mountain's
	// +1 defense should be enough to make the defender win the tie-break too.
	const after = withFixedRolls([0.5, 0.5], () => JSON.parse(IW.rollAttack()));
	assert.equal(after.states[a].armies, 4, 'attacker loses despite an equal base roll');
});
