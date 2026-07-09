// River crossing bonus and the Bridge card that cancels it for one attack.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freshEngine, newGameState, load, findLandEdge, clearEdge, setHex, withFixedRolls } from './helpers/engine.mjs';

function riverScenario(IW, { hand = [] } = {}) {
	const s = newGameState(IW);
	const [a, b] = findLandEdge(s);
	clearEdge(s, a, b);
	s.map.rivers.push([a, b]);
	setHex(s, a, 'blue', 5);
	setHex(s, b, 'green', 5);
	s.current = 'blue';
	s.phase = 'action';
	s.hands.blue = hand;
	load(IW, s);
	return { from: a, to: b };
}

test('a river between attacker and defender gives the defender +1', () => {
	const IW = freshEngine();
	const { from, to } = riverScenario(IW);
	assert.equal(IW.crossingDefenseBonus(from, to), 1);
	assert.equal(IW.defenseBonus(to, from), 1);
});

test('no river, no bonus', () => {
	const IW = freshEngine();
	const s = newGameState(IW);
	const [a, b] = findLandEdge(s);
	// Deliberately leave the edge clean, unlike riverScenario().
	s.map.rivers = s.map.rivers.filter(([x, y]) => !((x === a && y === b) || (x === b && y === a)));
	setHex(s, a, 'blue', 5);
	setHex(s, b, 'green', 5);
	load(IW, s);
	assert.equal(IW.crossingDefenseBonus(a, b), 0);
});

test('Bridge cancels the river bonus for the attack it is played into', () => {
	const IW = freshEngine();
	const { from, to } = riverScenario(IW, { hand: ['bridge'] });

	let s = JSON.parse(IW.playCard(0));
	assert.equal(s.bridgeAttackActive, true);
	assert.equal(s.phase, 'action', 'Bridge is an immediate flag card, not a targeting one');

	s = JSON.parse(IW.beginAttack());
	assert.equal(s.phase, 'attack_select_from');
	s = JSON.parse(IW.selectGrid(from));
	assert.equal(s.phase, 'attack_select_to');
	s = JSON.parse(IW.selectGrid(to));
	assert.equal(s.phase, 'attack_rolling');

	assert.equal(IW.crossingDefenseBonus(from, to), 0, 'Bridge negates the river bonus');
});

test('Bridge stays active across a multi-round attack and clears on conquest', () => {
	const IW = freshEngine();
	const { from, to } = riverScenario(IW, { hand: ['bridge'] });
	IW.playCard(0);
	IW.beginAttack();
	IW.selectGrid(from);
	IW.selectGrid(to); // defender has 5 armies, won't be conquered on one win

	let s = withFixedRolls([0.99, 0], () => JSON.parse(IW.rollAttack()));
	assert.equal(s.phase, 'attack_rolling', 'not conquered yet');
	assert.equal(s.bridgeAttackActive, true, 'Bridge is not spent by an inconclusive round');
	assert.equal(IW.crossingDefenseBonus(from, to), 0);

	// Force-win every remaining round to conquer the hex.
	for (let i = 0; i < 10 && s.phase === 'attack_rolling'; i++) {
		s = withFixedRolls([0.99, 0], () => JSON.parse(IW.rollAttack()));
	}
	assert.equal(s.states[to].owner, 'blue', 'eventually conquered');
	assert.equal(s.bridgeAttackActive, false, 'Bridge is consumed once the attack concludes');
});
