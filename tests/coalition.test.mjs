// Coalition: name a rival, everyone (caster included) gets +1 attacking
// them until the caster's own next turn begins. Broken immediately (bonus
// cancelled for everyone) if any bound player attacks someone else instead.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freshEngine, newGameState, load, findLandEdge, clearEdge, setHex } from './helpers/engine.mjs';

const ORDER = ['blue', 'green', 'red', 'brown'];

function coalitionScenario(IW) {
	const s = newGameState(IW);
	const [a, b] = findLandEdge(s);
	clearEdge(s, a, b);
	setHex(s, a, 'blue', 5);
	setHex(s, b, 'green', 5);
	s.current = 'blue';
	s.phase = 'action';
	s.hands.blue = ['coalition'];
	load(IW, s);
	return { from: a, to: b };
}

test('Coalition gives +1 attacking the named target', () => {
	const IW = freshEngine();
	const { to } = coalitionScenario(IW);
	assert.equal(IW.attackerBonus(to), 0);

	let s = JSON.parse(IW.playCard(0));
	assert.equal(s.phase, 'coalition_select');
	s = JSON.parse(IW.selectGrid(to));
	assert.equal(s.phase, 'action');
	assert.equal(s.coalitionTarget, 'green');
	assert.equal(s.coalitionCaster, 'blue');
	assert.equal(IW.attackerBonus(to), 1, 'coalition bonus applied to the named target');
});

test('Coalition expires once the caster\'s own next turn begins', () => {
	const IW = freshEngine();
	const { to } = coalitionScenario(IW);
	IW.playCard(0);
	IW.selectGrid(to);
	// forceEndTurn skips placement/action gating entirely (advances straight
	// to the next player's beginTurn) — endTurn only works from 'action'
	// phase, and each new player starts in 'placing', so it can't be chained.
	let s = JSON.parse(IW.forceEndTurn()); // blue -> green
	assert.equal(s.current, 'green');
	assert.equal(s.coalitionTarget, 'green', 'still active while it is not yet blue\'s turn');
	s = JSON.parse(IW.forceEndTurn()); // green -> red
	assert.equal(s.coalitionTarget, 'green');
	s = JSON.parse(IW.forceEndTurn()); // red -> brown
	assert.equal(s.coalitionTarget, 'green');
	s = JSON.parse(IW.forceEndTurn()); // brown -> blue (caster's next turn)
	assert.equal(s.current, 'blue');
	assert.equal(s.coalitionTarget, null, 'cleared once it is the caster\'s turn again');
	assert.equal(s.coalitionCaster, null);
});

test('attacking someone other than the target breaks the coalition immediately', () => {
	const IW = freshEngine();
	const s0 = newGameState(IW);
	// blue borders both green (the coalition target) and red (a third party) —
	// find a hex with two differently-owned neighbors to set that up directly.
	let from = -1, toGreen = -1, toRed = -1;
	for (const g of s0.map.grids) {
		const neighborOwners = new Set(s0.map.adj[g.id].map((n) => s0.states[n].owner).filter(Boolean));
		if (neighborOwners.size < 2) continue;
		const owners = [...neighborOwners];
		from = g.id;
		toGreen = s0.map.adj[g.id].find((n) => s0.states[n].owner === owners[0]);
		toRed = s0.map.adj[g.id].find((n) => s0.states[n].owner === owners[1]);
		break;
	}
	assert.ok(from >= 0, 'need a hex bordering two different owners for this scenario');
	const s = structuredClone(s0);
	const target = s.states[toGreen].owner;
	const bystander = s.states[toRed].owner;
	if (target === 'blue' || bystander === 'blue') return; // degenerate, skip
	// A wall on either edge would silently block the attack (selectGrid bails
	// out before reaching the treaty-break check), so clear both explicitly
	// rather than depend on what the unseeded map happened to generate.
	clearEdge(s, from, toGreen);
	clearEdge(s, from, toRed);
	setHex(s, from, 'blue', 6);
	s.states[toGreen].owner = target;
	s.states[toRed].owner = bystander;
	s.states[toGreen].armies = 5;
	s.states[toRed].armies = 5;
	s.current = 'blue';
	s.phase = 'action';
	s.hands.blue = ['coalition'];
	load(IW, s);

	IW.playCard(0);
	let st = JSON.parse(IW.selectGrid(toGreen));
	assert.equal(st.coalitionTarget, target);

	IW.beginAttack();
	IW.selectGrid(from);
	st = JSON.parse(IW.selectGrid(toRed));
	assert.equal(st.phase, 'attack_rolling');
	assert.equal(st.coalitionTarget, null, 'attacking the bystander broke the coalition');
	assert.equal(st.coalitionCaster, null);
	assert.equal(IW.attackerBonus(toGreen), 0, 'bonus against the original target is gone too');
});
