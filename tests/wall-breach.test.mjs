// Wall blocks attacks/movement across an edge; Breach tears one down.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freshEngine, newGameState, load, findLandEdge, clearEdge, setHex } from './helpers/engine.mjs';

function wallScenario(IW, { hand = [] } = {}) {
	const s = newGameState(IW);
	const [a, b] = findLandEdge(s);
	clearEdge(s, a, b);
	if (!s.map.walls) s.map.walls = [];
	s.map.walls.push([a, b]);
	setHex(s, a, 'blue', 5);
	setHex(s, b, 'green', 5);
	s.current = 'blue';
	s.phase = 'action';
	s.hands.blue = hand;
	load(IW, s);
	return { from: a, to: b };
}

test('a wall blocks an attack across that edge', () => {
	const IW = freshEngine();
	const { from, to } = wallScenario(IW);
	IW.beginAttack();
	let s = JSON.parse(IW.selectGrid(from));
	assert.equal(s.phase, 'attack_select_to');
	s = JSON.parse(IW.selectGrid(to));
	assert.equal(s.phase, 'attack_select_to', 'the pick is rejected, phase does not advance');
	assert.match(s.message, /wall blocks/i);
});

test('a wall blocks a move across that edge', () => {
	const IW = freshEngine();
	const s0 = newGameState(IW);
	const [a, b] = findLandEdge(s0);
	clearEdge(s0, a, b);
	if (!s0.map.walls) s0.map.walls = [];
	s0.map.walls.push([a, b]);
	setHex(s0, a, 'blue', 5);
	setHex(s0, b, 'blue', 3); // both friendly, so only the wall stops the move
	s0.current = 'blue';
	s0.phase = 'action';
	load(IW, s0);
	IW.beginMove();
	let s = JSON.parse(IW.selectGrid(a));
	assert.equal(s.phase, 'move_select_to');
	s = JSON.parse(IW.selectGrid(b));
	assert.equal(s.phase, 'move_select_to', 'the pick is rejected, phase does not advance');
	assert.match(s.message, /wall blocks/i);
});

test('Breach tears down the wall, reopening the edge to attack', () => {
	const IW = freshEngine();
	const { from, to } = wallScenario(IW, { hand: ['breach'] });

	let s = JSON.parse(IW.playCard(0));
	assert.equal(s.phase, 'breach_from');
	s = JSON.parse(IW.selectGrid(from));
	assert.equal(s.phase, 'breach_to');
	s = JSON.parse(IW.selectGrid(to));
	assert.equal(s.phase, 'action');
	assert.ok(
		!(s.map.walls ?? []).some(([x, y]) => (x === from && y === to) || (x === to && y === from)),
		'wall edge removed'
	);
	assert.equal(s.hands.blue.length, 0, 'card consumed');

	IW.beginAttack();
	IW.selectGrid(from);
	s = JSON.parse(IW.selectGrid(to));
	assert.equal(s.phase, 'attack_rolling', 'the attack now goes through');
});
