// Gold economy: income at the start of a turn, buying armies/cards in the
// 'buy' phase, escalating-then-resetting reroll cost, and the hand-limit
// discard flow now that a market purchase is the only way to go over
// HAND_MAX (there's no more free per-turn card draw).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freshEngine, newGameState, load, findLandEdge, clearEdge, setHex } from './helpers/engine.mjs';

/** Minimal blue-vs-green board, blue's turn, phase 'buy', with a known gold
 *  balance and market offer so tests don't depend on procedural map/deck
 *  randomness. */
function buyScenario(IW, { gold = 20, marketOffer = ['bomb', 'antibomb', null], hand = [] } = {}) {
	const s = newGameState(IW);
	const [a, b] = findLandEdge(s);
	clearEdge(s, a, b);
	setHex(s, a, 'blue', 5);
	setHex(s, b, 'green', 5);
	s.current = 'blue';
	s.phase = 'buy';
	s.gold.blue = gold;
	s.marketOffer = marketOffer;
	s.marketRerollCount = 0;
	s.armiesToPlace = 0;
	s.hands.blue = hand;
	load(IW, s);
	return { from: a, to: b };
}

test('gold income at game start matches the territory/island/city/capital formula', () => {
	const IW = freshEngine();
	const s = newGameState(IW);
	assert.equal(s.phase, 'buy');
	const p = s.current;
	const base = Math.max(2, Math.floor(IW.countryCount(p) / 3));
	const expected = base + IW.fullIslandBonus(p) + IW.cityIncome(p) + IW.capitalBonus(p);
	assert.equal(s.gold[p], expected);
	assert.equal(s.goldIncomeThisTurn, expected);
});

test('gold carries over unspent across a full turn cycle', () => {
	const IW = freshEngine();
	let s = newGameState(IW);
	s.eventIntensity = 'off'; // no random world events to perturb territories/income
	load(IW, s);
	const player = s.current;
	const goldBefore = s.gold[player];
	// Spend nothing; finish shopping and cycle all the way back to this
	// player's next turn via forceEndTurn (advances straight through
	// placing/action regardless of phase, like the coalition tests do).
	JSON.parse(IW.finishShopping());
	for (let i = 0; i < 4; i++) s = JSON.parse(IW.forceEndTurn());
	assert.equal(s.current, player);
	assert.equal(s.phase, 'buy');
	assert.equal(s.gold[player], goldBefore + s.goldIncomeThisTurn);
	assert.ok(s.gold[player] > goldBefore, 'gold grew rather than resetting');
});

test('buyArmies clamps to what current gold affords at the 1:1 rate', () => {
	const IW = freshEngine();
	buyScenario(IW, { gold: 5 });
	let s = JSON.parse(IW.buyArmies(100));
	assert.equal(s.armiesToPlace, 5);
	assert.equal(s.gold.blue, 0);
	assert.equal(s.phase, 'buy', 'buying armies does not change phase');
});

test('buyCard no-ops when the card is unaffordable', () => {
	const IW = freshEngine();
	buyScenario(IW, { gold: 3, marketOffer: ['bomb', null, null] }); // bomb costs 8
	const s = JSON.parse(IW.buyCard(0));
	assert.equal(s.gold.blue, 3);
	assert.deepEqual(s.marketOffer, ['bomb', null, null]);
	assert.deepEqual(s.hands.blue, []);
});

test('buyCard succeeds: gold deducted by price, card in hand, slot nulled', () => {
	const IW = freshEngine();
	buyScenario(IW, { gold: 20, marketOffer: ['bomb', 'antibomb', null] });
	const s = JSON.parse(IW.buyCard(0));
	assert.equal(s.gold.blue, 12); // 20 - cardPrice(weight 1) = 20 - 8
	assert.deepEqual(s.hands.blue, ['bomb']);
	assert.equal(s.marketOffer[0], null);
	assert.equal(s.marketOffer[1], 'antibomb');
});

test('a purchase that overflows the hand limit pauses for discard, then resumes into buy', () => {
	const IW = freshEngine();
	buyScenario(IW, {
		gold: 20,
		marketOffer: ['bomb', null, null],
		hand: ['antibomb', 'fortify', 'sabotage', 'elite', 'spy'] // already at HAND_MAX (5)
	});
	let s = JSON.parse(IW.buyCard(0));
	assert.equal(s.phase, 'discard');
	assert.equal(s.hands.blue.length, 6);
	s = JSON.parse(IW.discardCard(0));
	assert.equal(s.phase, 'buy', 'resumes to buy, not the next player\'s turn');
	assert.equal(s.hands.blue.length, 5);
	assert.ok(s.hands.blue.includes('bomb'), 'the bought card stayed; the discarded one left');
});

test('rerollMarket cost escalates within a turn and resets to base next turn', () => {
	const IW = freshEngine();
	buyScenario(IW, { gold: 100 });
	assert.equal(JSON.parse(IW.getState()).marketRerollCount, 0);
	let s = JSON.parse(IW.rerollMarket());
	assert.equal(s.gold.blue, 98); // 100 - (2 + 0*2)
	assert.equal(s.marketRerollCount, 1);
	s = JSON.parse(IW.rerollMarket());
	assert.equal(s.gold.blue, 94); // 98 - (2 + 1*2)
	assert.equal(s.marketRerollCount, 2);
	// Cycle back to blue's next turn — reroll count/cost should reset.
	s.eventIntensity = 'off';
	load(IW, s);
	JSON.parse(IW.finishShopping());
	for (let i = 0; i < 4; i++) s = JSON.parse(IW.forceEndTurn());
	assert.equal(s.current, 'blue');
	assert.equal(s.marketRerollCount, 0, 'reroll count reset at the start of the new turn');
});

test('rerollMarket recirculates unbought offered cards into the discard pile, not lost', () => {
	const IW = freshEngine();
	buyScenario(IW, { gold: 100, marketOffer: ['bomb', 'antibomb', null] });
	const s = JSON.parse(IW.rerollMarket());
	assert.ok(s.discardPile.includes('bomb'));
	assert.ok(s.discardPile.includes('antibomb'));
	assert.equal(s.marketOffer.filter((c) => c != null).length, 3, 'a fresh full offer was drawn');
});

test('finishShopping with 0 armies bought skips placing and goes straight to action', () => {
	const IW = freshEngine();
	buyScenario(IW, { gold: 20 });
	const s = JSON.parse(IW.finishShopping());
	assert.equal(s.phase, 'action');
	assert.deepEqual(s.marketOffer, [null, null, null]);
});

test('finishShopping with armies bought enters placing, and placeArmies still works end to end', () => {
	const IW = freshEngine();
	const { from } = buyScenario(IW, { gold: 20 });
	JSON.parse(IW.buyArmies(4));
	let s = JSON.parse(IW.finishShopping());
	assert.equal(s.phase, 'placing');
	assert.equal(s.armiesToPlace, 4);
	s = JSON.parse(IW.placeArmies(from, 4));
	assert.equal(s.phase, 'action');
	assert.equal(s.armiesToPlace, 0);
});

test('a full AI turn from a fresh buy phase completes without deadlocking', () => {
	const IW = freshEngine();
	const s0 = newGameState(IW);
	assert.equal(s0.phase, 'buy');
	IW.runAiTurn(s0.current);
	const s = JSON.parse(IW.getState());
	// The AI should have shopped, placed (if it bought armies), attacked/moved,
	// and ended its turn — landing on the next player's fresh 'buy' phase.
	assert.notEqual(s.current, s0.current);
	assert.equal(s.phase, 'buy');
});
