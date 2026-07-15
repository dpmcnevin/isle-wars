// Relocate Capital: move your capital to any hex you own. The old capital
// stays a normal city; the destination becomes one if it wasn't already, and
// starts paying the +3 capitalBonus / +2 city income immediately.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freshEngine, newGameState, load } from './helpers/engine.mjs';

test('relocating moves the capital and starts paying its bonus at the new hex', () => {
	const IW = freshEngine();
	const s = newGameState(IW);
	const oldCap = s.capitals.blue;
	// A plain (non-city) hex of blue's own, distinct from the old capital.
	const dest = s.states.findIndex(
		(st, id) => st.owner === 'blue' && id !== oldCap && !s.map.grids[id].production
	);
	assert.ok(dest >= 0, 'blue needs a non-city hex to relocate to for this scenario');
	s.hands.blue = ['relocate'];
	s.current = 'blue';
	s.phase = 'action';
	load(IW, s);

	assert.equal(IW.capitalBonus('blue'), 3, 'starts paying the bonus at the original capital');
	const incomeBefore = IW.cityIncome('blue');

	let st = JSON.parse(IW.playCard(0));
	assert.equal(st.phase, 'relocate_select');
	st = JSON.parse(IW.selectGrid(dest));
	assert.equal(st.phase, 'action');

	assert.equal(st.capitals.blue, dest, 'capital points at the new hex');
	assert.ok(st.map.grids[dest].production, 'destination is promoted to a city');
	assert.equal(st.hands.blue.length, 0, 'card was consumed');
	assert.ok(st.map.grids[oldCap].production, 'old capital stays a city');
	assert.equal(IW.capitalBonus('blue'), 3, 'still paying the bonus, now at the new hex');

	// The bonus must fully MOVE, not duplicate: the old capital drops from a
	// capital's +2 city income to a normal city's +1, while the new capital
	// picks up +2 (it was a non-city contributing 0 before). Net effect on
	// blue's total city income is exactly +1, not +2 — proof the old capital
	// isn't still secretly paying out after the move.
	assert.equal(IW.cityIncome('blue'), incomeBefore + 1, 'old capital demoted to normal-city income, not double-counted');
});

test('the old capital stops being anyone\'s capital once relocated — no stale entry left behind', () => {
	const IW = freshEngine();
	const s = newGameState(IW);
	const oldCap = s.capitals.blue;
	const dest = s.states.findIndex((st, id) => st.owner === 'blue' && id !== oldCap);
	assert.ok(dest >= 0);
	s.hands.blue = ['relocate'];
	s.current = 'blue';
	s.phase = 'action';
	load(IW, s);

	IW.playCard(0);
	const st = JSON.parse(IW.selectGrid(dest));

	// s.capitals is one hex id per player — reassigning it IS the reset, so
	// the old hex can't appear as blue's capital anywhere anymore.
	assert.equal(Object.values(st.capitals).filter((id) => id === oldCap).length, 0);
	assert.notEqual(st.capitals.blue, oldCap);
});

test('relocating reclaims the capitalBonus after the original capital was lost', () => {
	const IW = freshEngine();
	const s = newGameState(IW);
	const oldCap = s.capitals.blue;
	const dest = s.states.findIndex(
		(st, id) => st.owner === 'blue' && id !== oldCap
	);
	assert.ok(dest >= 0);
	// Simulate the capital being captured by an enemy.
	s.states[oldCap] = { ...s.states[oldCap], owner: 'green', armies: 3 };
	s.hands.blue = ['relocate'];
	s.current = 'blue';
	s.phase = 'action';
	load(IW, s);

	assert.equal(IW.capitalBonus('blue'), 0, 'no bonus while the original capital is occupied');

	IW.playCard(0);
	const st = JSON.parse(IW.selectGrid(dest));

	assert.equal(st.capitals.blue, dest);
	assert.equal(IW.capitalBonus('blue'), 3, 'bonus restored at the new capital');
});

test('cannot relocate onto a hex you do not own, or re-pick the current capital', () => {
	const IW = freshEngine();
	const s = newGameState(IW);
	const oldCap = s.capitals.blue;
	const enemyHex = s.states.findIndex((st) => st.owner && st.owner !== 'blue');
	assert.ok(enemyHex >= 0);
	s.hands.blue = ['relocate'];
	s.current = 'blue';
	s.phase = 'action';
	load(IW, s);

	IW.playCard(0);
	let st = JSON.parse(IW.selectGrid(enemyHex));
	assert.equal(st.phase, 'relocate_select', 'rejected: not our territory');

	st = JSON.parse(IW.selectGrid(oldCap));
	assert.equal(st.phase, 'relocate_select', 'rejected: already the capital');
});
