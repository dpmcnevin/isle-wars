// Water Invasion: opens a temporary sea lane and attacks across it — the
// lane stays only if the attack conquers the target. Naval Patrol sinks the
// landing fleet before the lane ever opens.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freshEngine, newGameState, load, findWaterCrossing, setHex, withFixedRolls } from './helpers/engine.mjs';

function invasionScenario(IW, { fromArmies = 5, toArmies = 5, defenderHand = [] } = {}) {
	const s = newGameState(IW);
	const [a, b] = findWaterCrossing(IW, s);
	setHex(s, a, 'blue', fromArmies);
	setHex(s, b, 'green', toArmies);
	s.hands.green = defenderHand;
	s.current = 'blue';
	s.phase = 'action';
	s.hands.blue = ['invasion'];
	load(IW, s);
	return { from: a, to: b };
}

function launchInvasion(IW, from, to) {
	let s = JSON.parse(IW.playCard(0));
	assert.equal(s.phase, 'invasion_from');
	s = JSON.parse(IW.selectGrid(from));
	assert.equal(s.phase, 'invasion_to');
	return JSON.parse(IW.selectGrid(to));
}

test('Water Invasion opens a temporary lane with a +1 crossing bonus (not the full +2)', () => {
	const IW = freshEngine();
	const { from, to } = invasionScenario(IW);
	const s = launchInvasion(IW, from, to);
	assert.equal(s.phase, 'attack_rolling');
	assert.ok(s.map.seaLanes.some(([x, y]) => (x === from && y === to) || (x === to && y === from)));
	assert.equal(IW.crossingDefenseBonus(from, to), 1);
});

test('the lane stays permanent after a successful invasion', () => {
	const IW = freshEngine();
	const { from, to } = invasionScenario(IW, { toArmies: 1 });
	launchInvasion(IW, from, to);
	const s = withFixedRolls([0.99, 0], () => JSON.parse(IW.rollAttack()));
	assert.equal(s.states[to].owner, 'blue');
	assert.ok(s.map.seaLanes.some(([x, y]) => (x === from && y === to) || (x === to && y === from)));
	assert.equal(s.pendingInvasionLane, null);
});

test('the lane collapses when the invasion fails', () => {
	const IW = freshEngine();
	const { from, to } = invasionScenario(IW, { fromArmies: 2, toArmies: 5 });
	launchInvasion(IW, from, to);
	const s = withFixedRolls([0, 0.99], () => JSON.parse(IW.rollAttack()));
	assert.ok(!s.map.seaLanes.some(([x, y]) => (x === from && y === to) || (x === to && y === from)));
	assert.ok(!s.map.adj[from].includes(to) && !s.map.adj[to].includes(from));
	assert.equal(s.pendingInvasionLane, null);
});

test('Naval Patrol sinks the invasion before any lane opens', () => {
	const IW = freshEngine();
	const { from, to } = invasionScenario(IW, { defenderHand: ['navalpatrol'] });
	const s = launchInvasion(IW, from, to);
	assert.equal(s.phase, 'action', 'no attack roll happens — sunk before landing');
	assert.ok(!s.map.seaLanes.some(([x, y]) => (x === from && y === to) || (x === to && y === from)));
	assert.equal(s.hands.blue.length, 0, 'invasion card spent');
	assert.equal(s.hands.green.length, 0, 'naval patrol spent');
	assert.equal(s.lastAttackResult, 'loss');
});
