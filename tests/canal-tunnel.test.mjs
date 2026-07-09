// Canal (digs a river) / Levee (drains one), and Tunnel (bypasses all
// defender bonuses, permanent on a win, collapses on a loss) / Collapse
// (severs an existing tunnel).
//
// Not covered here: Canal severing a tunnel whose straight line crosses the
// new river (severTunnelsCrossingCanal in game.ts). That needs two edges
// that actually cross in map-generated coordinates, which isn't reliably
// constructible from a same-edge or same-island-adjacent pair — left as a
// known gap for this minimal harness rather than a fragile geometry search.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freshEngine, newGameState, load, findLandEdge, findTunnelPair, clearEdge, setHex, withFixedRolls } from './helpers/engine.mjs';

test('Canal digs a river, adding the +1 crossing bonus', () => {
	const IW = freshEngine();
	const s = newGameState(IW);
	const [a, b] = findLandEdge(s);
	clearEdge(s, a, b);
	setHex(s, a, 'blue', 5);
	setHex(s, b, 'green', 5);
	s.current = 'blue';
	s.phase = 'action';
	s.hands.blue = ['canal'];
	load(IW, s);

	assert.equal(IW.crossingDefenseBonus(a, b), 0);
	let st = JSON.parse(IW.playCard(0));
	assert.equal(st.phase, 'canal_from');
	st = JSON.parse(IW.selectGrid(a));
	assert.equal(st.phase, 'canal_to');
	st = JSON.parse(IW.selectGrid(b));
	assert.equal(st.phase, 'action');
	assert.ok(st.map.rivers.some(([x, y]) => (x === a && y === b) || (x === b && y === a)));
	assert.equal(IW.crossingDefenseBonus(a, b), 1);
});

test('Levee drains a river, removing the crossing bonus', () => {
	const IW = freshEngine();
	const s = newGameState(IW);
	const [a, b] = findLandEdge(s);
	clearEdge(s, a, b);
	s.map.rivers.push([a, b]);
	setHex(s, a, 'blue', 5);
	setHex(s, b, 'green', 5);
	s.current = 'blue';
	s.phase = 'action';
	s.hands.blue = ['levee'];
	load(IW, s);

	assert.equal(IW.crossingDefenseBonus(a, b), 1);
	let st = JSON.parse(IW.playCard(0));
	assert.equal(st.phase, 'levee_from');
	st = JSON.parse(IW.selectGrid(a));
	assert.equal(st.phase, 'levee_to');
	st = JSON.parse(IW.selectGrid(b));
	assert.equal(st.phase, 'action');
	assert.ok(!st.map.rivers.some(([x, y]) => (x === a && y === b) || (x === b && y === a)));
	assert.equal(IW.crossingDefenseBonus(a, b), 0);
	assert.equal(st.hands.blue.length, 0, 'card consumed');
});

function tunnelScenario(IW, { fromArmies = 5, toArmies = 5 } = {}) {
	const s0 = newGameState(IW);
	// A tunnel target must NOT already be directly adjacent (canTunnelConnect
	// rejects that as "nothing to tunnel to"), so this needs a real 2-3-hop
	// search rather than findLandEdge's direct-neighbor pair.
	const [a, b] = findTunnelPair(IW, s0);
	const s = structuredClone(s0);
	s.map.walls = [];
	s.map.rivers = [];
	s.map.tunnels = [];
	setHex(s, a, 'blue', fromArmies);
	setHex(s, b, 'green', toArmies);
	s.map.grids[b].terrain = 'mountain';
	s.states[b].fortified = true;
	s.states[b].rampart = true;
	s.current = 'blue';
	s.phase = 'action';
	s.hands.blue = ['tunnel'];
	load(IW, s);
	return { from: a, to: b };
}

test('Tunnel bypasses every defender bonus', () => {
	const IW = freshEngine();
	const { from, to } = tunnelScenario(IW);
	assert.equal(IW.defenseBonus(to, from), 4, 'sanity check: mountain +1, fortified +2, rampart +1');

	let s = JSON.parse(IW.playCard(0));
	assert.equal(s.phase, 'tunnel_from');
	s = JSON.parse(IW.selectGrid(from));
	assert.equal(s.phase, 'tunnel_to');
	s = JSON.parse(IW.selectGrid(to));
	assert.equal(s.phase, 'attack_rolling', 'tunnel resolves straight into an attack');
	assert.equal(IW.defenseBonus(to, from), 0, 'all bonuses bypassed underground');
});

test('Tunnel persists as a permanent route after a successful assault', () => {
	const IW = freshEngine();
	const { from, to } = tunnelScenario(IW, { toArmies: 1 });
	IW.playCard(0);
	IW.selectGrid(from);
	IW.selectGrid(to);
	const s = withFixedRolls([0.99, 0], () => JSON.parse(IW.rollAttack()));
	assert.equal(s.states[to].owner, 'blue', 'conquered through the tunnel');
	assert.ok(s.map.tunnels.some(([x, y]) => (x === from && y === to) || (x === to && y === from)));
	assert.ok(s.map.adj[from].includes(to) && s.map.adj[to].includes(from));
	assert.equal(s.pendingTunnel, null);
});

test('Tunnel collapses when the assault fails', () => {
	const IW = freshEngine();
	// Attacker starts at the minimum (2) so one lost roll drops it to 1 and
	// forces the forfeit-loss path, which is what tears the tunnel back out.
	const { from, to } = tunnelScenario(IW, { fromArmies: 2, toArmies: 5 });
	IW.playCard(0);
	IW.selectGrid(from);
	IW.selectGrid(to);
	const s = withFixedRolls([0, 0.99], () => JSON.parse(IW.rollAttack()));
	assert.ok(
		!s.map.tunnels.some(([x, y]) => (x === from && y === to) || (x === to && y === from)),
		'tunnel removed from map.tunnels'
	);
	assert.ok(!s.map.adj[from].includes(to) && !s.map.adj[to].includes(from), 'adjacency reverted');
	assert.equal(s.pendingTunnel, null);
});

test('Collapse severs an existing tunnel', () => {
	const IW = freshEngine();
	const s = newGameState(IW);
	const [a, b] = findLandEdge(s);
	clearEdge(s, a, b);
	s.map.tunnels.push([a, b]);
	s.map.adj[a].push(b);
	s.map.adj[b].push(a);
	setHex(s, a, 'blue', 5);
	setHex(s, b, 'green', 5);
	s.current = 'blue';
	s.phase = 'action';
	s.hands.blue = ['collapse'];
	load(IW, s);

	let st = JSON.parse(IW.playCard(0));
	assert.equal(st.phase, 'collapse_from');
	st = JSON.parse(IW.selectGrid(a));
	assert.equal(st.phase, 'collapse_to');
	st = JSON.parse(IW.selectGrid(b));
	assert.equal(st.phase, 'action');
	assert.ok(!st.map.tunnels.some(([x, y]) => (x === a && y === b) || (x === b && y === a)));
	assert.ok(!st.map.adj[a].includes(b) && !st.map.adj[b].includes(a));
});
