import { get } from 'svelte/store';
import {
	game,
	placeArmies,
	beginAttack,
	beginMove,
	selectGrid,
	rollAttack,
	quitAttack,
	cancelAction,
	confirmMoveInAfterConquest,
	confirmMove,
	confirmParatroop,
	discardCard,
	endTurn,
	forceEndTurn,
	playCard,
	canInvasionConnect,
	canTunnelConnect,
	canFerryConnect,
	canArtilleryTarget,
	confirmAir,
	defenseBonus,
	attackerBonus,
	winProbability,
	hasClearWaterPath,
	countryCount,
	PLAYERS,
	buyArmies,
	buyCard,
	rerollMarket,
	rerollCost,
	finishShopping,
	cardPrice,
	CARD_BY_ID,
	type Player,
	type CardType,
	type GameState
} from './game';
import { crossesRiver, wallBetween } from './map';
import { predictWinProb } from './valueNet';

/**
 * When true, `runAiTurn` skips every cosmetic `await wait()` pause, so its
 * whole body executes synchronously in one tick (an async function runs
 * straight through when it never actually awaits). The iOS host sets this:
 * its JSContext has no real event loop, and relying on the microtask queue to
 * resume the awaits was flaky — a turn could suspend at the first `await` and
 * never resume, freezing the AI mid-placement. The web keeps it false so the
 * turn still animates move-by-move.
 */
let synchronousAi = false;
export function setAiSynchronous(v: boolean) {
	synchronousAi = v;
}

/**
 * Players whose main attack-selection loop uses the trained value network
 * (src/lib/valueNet.ts) instead of the hand-tuned heuristic in
 * `findBestAttack`. Per-player rather than a single global switch so a
 * headless sim can pit the two policies against each other in the same game
 * (see scripts/simulate.mjs's --value-net-players).
 */
let valueNetPlayers = new Set<Player>();
export function setValueNetPlayers(players: Player[]) {
	valueNetPlayers = new Set(players);
}

/**
 * Run one full turn for an AI player. Assumes current player === p and
 * we are at the top of the turn (phase = 'placing'). Returns nothing.
 */
export async function runAiTurn(p: Player, tickMs = 90) {
	const wait = () => new Promise((r) => setTimeout(r, tickMs));

	// Eliminated player? Just advance the turn. Prevents auto-play from
	// hanging on a dead player who can't place or attack.
	{
		const s0 = get(game);
		const owned = s0.map.grids.reduce((n, g) => n + (s0.states[g.id].owner === p ? 1 : 0), 0);
		if (owned === 0) {
			forceEndTurn();
			return;
		}
	}

	// --- Resume from any in-progress phase (e.g. after loading a saved game
	// mid-AI-turn). Normalize to `placing` or `action` before continuing. ---
	{
		const phase = get(game).phase;
		if (phase === 'attack_rolling') {
			let rolls = 0;
			while (get(game).phase === 'attack_rolling' && rolls++ < 20000) {
				rollAttack();
				const s2 = get(game);
				if (
					s2.phase === 'attack_rolling' && s2.selectedFrom != null && s2.selectedTo != null &&
					!attackWorthContinuing(s2, s2.selectedFrom, s2.selectedTo)
				) {
					quitAttack();
					break;
				}
			}
		}
		if (get(game).phase === 'attack_move_in') {
			const s = get(game);
			const from = s.states[s.selectedFrom!];
			confirmMoveInAfterConquest(Math.max(0, Math.floor(from.armies / 2)));
		}
		// Cancel ANY leftover card-targeting/selection phase so the turn doesn't
		// start wedged. Listing individual phases here is a maintenance trap — a
		// new card's steps (e.g. wall_from, breach_from) would be missed and the
		// turn would return early below without ever ending, deadlocking the AI.
		// So we cancel everything except the phases the code above already handled
		// (roll/move-in) or that runAiTurn proceeds from normally (placing/action)
		// or that resolve elsewhere (discard/game_over).
		const p2 = get(game).phase;
		if (
			p2 !== 'buy' && p2 !== 'placing' && p2 !== 'action' && p2 !== 'discard' && p2 !== 'game_over' &&
			p2 !== 'attack_rolling' && p2 !== 'attack_move_in'
		) {
			cancelAction();
		}
		// Auto-discard oldest card(s) until hand size is under the limit.
		let safety = 0;
		while (get(game).phase === 'discard' && safety++ < 20) {
			discardCard(0);
		}
	}
	// If somehow we can't recover, end the turn to unstick.
	if (get(game).phase !== 'buy' && get(game).phase !== 'placing' && get(game).phase !== 'action') {
		return;
	}

	// --- Shopping: buy armies and cards, then move on to placing/action ---
	if (get(game).phase === 'buy' && get(game).current === p) {
		runAiMarket(p);
		if (!synchronousAi) await wait();
	}

	// --- Water-invasion planning ---
	// If the only way to reach a holdout enemy is an amphibious assault, we may
	// need to funnel armies to the launch hex first. `staging` means we're
	// dominant, a plan exists, and its launch hex isn't yet strong enough to
	// win the assault.
	const invasionPlan = bestInvasionPlan(get(game), p);
	const staging = invasionPlan != null && !invasionPlan.ready && isDominant(get(game), p);

	// --- Placement --- When staging for an invasion, pile every reinforcement
	// onto the launch hex so it climbs toward a winning force; otherwise reinforce
	// the front. (Income staging works even across water, since placement only
	// needs to own the hex — so a launch site on its own islet still fills up.)
	while (get(game).phase === 'placing' && get(game).current === p) {
		const s = get(game);
		const target = staging ? invasionPlan!.from : choosePlacementTarget(s, p);
		if (target == null) break;
		// Place all remaining on best target (simple but decisive)
		placeArmies(target, s.armiesToPlace);
		if (!synchronousAi) await wait();
	}

	// --- Pre-attack buff cards (Elite / Bridge / Mountaineering) ---
	// Must run BEFORE the attack loop: each sets a one-shot flag
	// (eliteAttackActive/bridgeAttackActive/mountainAttackActive) that's
	// consumed by the first attack roll AND unconditionally reset by the very
	// next beginTurn — including the next PLAYER's beginTurn, since these
	// flags aren't scoped per-player. Playing one of these cards after this
	// player's own attack loop already ran (as tryPlayCardAction alone would)
	// wastes the card: the buff never gets used before it's wiped. None of
	// these bonuses factor into findBestAttack's target choice (attackerBonus
	// deliberately excludes Elite; the opening odds check doesn't know about
	// Bridge/Mountaineering either), so playing the card here doesn't change
	// which target the attack loop below picks.
	if (get(game).phase === 'action' && get(game).current === p) {
		tryPlayAttackBuffCard(p);
		if (!synchronousAi) await wait();
	}

	// --- Attack loop ---
	let attackAttempts = 0;
	while (get(game).phase === 'action' && get(game).current === p && attackAttempts < 20) {
		const s = get(game);
		const opp = valueNetPlayers.has(p) ? findBestAttackWithValueNet(s, p) : findBestAttack(s, p);
		if (!opp) break;
		beginAttack();
		selectGrid(opp.from);
		if (get(game).phase !== 'attack_select_to') {
			// Source selection didn't take — bail out cleanly rather than hang.
			cancelAction();
			break;
		}
		selectGrid(opp.to);
		// Attacking an empty (neutral, 0-army) hex auto-conquers immediately —
		// selectGrid jumps straight to 'attack_move_in' (or back to 'action' if
		// the source was drained) with no dice roll. Only bail if we land
		// somewhere else unexpected.
		if (
			get(game).phase !== 'attack_rolling' &&
			get(game).phase !== 'attack_move_in' &&
			get(game).phase !== 'action'
		) {
			// Target selection failed — bail cleanly.
			cancelAction();
			break;
		}
		// Roll until conquer, forfeit, or advantage lost. Roll without waiting
		// inside a single attack — otherwise a 100-vs-50 fight can take a
		// minute of wall-clock time. High cap so the fight actually resolves.
		let rolls = 0;
		while (get(game).phase === 'attack_rolling' && rolls++ < 20000) {
			rollAttack();
			const s2 = get(game);
			if (
				s2.phase === 'attack_rolling' && s2.selectedFrom != null && s2.selectedTo != null &&
				!attackWorthContinuing(s2, s2.selectedFrom, s2.selectedTo)
			) {
				quitAttack();
				break;
			}
		}
		if (get(game).phase === 'attack_move_in') {
			// Move most of the remaining into new grid
			const s3 = get(game);
			const from = s3.states[s3.selectedFrom!];
			confirmMoveInAfterConquest(Math.max(0, Math.floor(from.armies / 2)));
		}
		attackAttempts++;
		// One visible pause per attack — spaces out the flurry visually but
		// doesn't stall on individual rolls.
		if (!synchronousAi) await wait();
	}

	// --- Water Invasion: reach an enemy hex that shares no land/sea-lane border
	// with us — e.g. an opponent's last, water-locked territory — by opening a
	// lane and storming across it. Without this the AI can stall one hex short of
	// a win forever. It spends our one card for the turn, so it runs before the
	// other action cards. ---
	if (get(game).phase === 'action' && get(game).current === p) {
		if (tryWaterInvasion(p) && !synchronousAi) await wait();
	}

	// --- Card play during action phase (bomb, elite, etc.) if we didn't
	// already spend our card on placement or a Water Invasion.
	tryPlayCardAction(p);
	if (!synchronousAi) await wait();

	// --- Out of attacks: shift an idle rear stack forward. When we're staging a
	// water invasion, march our biggest stack toward the launch hex so the
	// assault force assembles faster than income alone would manage; otherwise
	// just pull idle rear stacks toward the general front. Moving ends the turn,
	// so this replaces the plain "pass" below when it fires. ---
	if (get(game).phase === 'action' && get(game).current === p) {
		const plan2 = bestInvasionPlan(get(game), p);
		const moved = plan2 && !plan2.ready && isDominant(get(game), p)
			? stageTowardLaunch(p, plan2.from)
			: tryRepositionStack(p);
		if (moved) {
			if (!synchronousAi) await wait();
			return;
		}
	}

	// --- End turn. If we're stuck in a mid-action phase, cancel back to
	// action first. If we still can't reach action, force-advance the turn. ---
	if (get(game).current === p && get(game).phase !== 'action' && get(game).phase !== 'placing') {
		cancelAction();
	}
	// Drain any still-owed placement (e.g. a card played during placement can
	// bounce us out of the main placement loop, leaving armies unplaced). If we
	// don't finish placing, the turn can't end and the AI deadlocks.
	let placeSafety = 0;
	while (get(game).phase === 'placing' && get(game).current === p && placeSafety++ < 100) {
		const s = get(game);
		const target = choosePlacementTarget(s, p);
		if (target == null) break;
		placeArmies(target, s.armiesToPlace);
	}
	if (get(game).phase === 'action' && get(game).current === p) {
		endTurn();
	} else if (get(game).current === p && get(game).phase !== 'game_over') {
		// Last-resort unstick — includes a lingering `placing` phase we couldn't
		// drain above, which previously left the AI frozen mid-turn.
		forceEndTurn();
	}
}

// Roll the current attack (phase === 'attack_rolling') to a conclusion: keep
// rolling until we conquer, or quit once the attacker no longer holds a clear
// edge. Mirrors the inline logic in the main attack loop; reused by the
// Water-Invasion path.
function rollOutCurrentAttack() {
	let rolls = 0;
	while (get(game).phase === 'attack_rolling' && rolls++ < 20000) {
		rollAttack();
		const s = get(game);
		if (
			s.phase === 'attack_rolling' && s.selectedFrom != null && s.selectedTo != null &&
			!attackWorthContinuing(s, s.selectedFrom, s.selectedTo)
		) {
			quitAttack();
			break;
		}
	}
	if (get(game).phase === 'attack_move_in') {
		const s = get(game);
		const from = s.states[s.selectedFrom!];
		confirmMoveInAfterConquest(Math.max(0, Math.floor(from.armies / 2)));
	}
}

// How much of an army edge an amphibious assault needs to be worth launching.
// The temporary invasion lane gives the DEFENDER +1, so the attacker only wins
// ~36% of rounds and burns ~1.8 armies per defender killed. A ~2:1 stack wins
// ~99% of the time (verified by simulation); below that it's a coin flip or a
// loss. We add a small flat buffer so tiny garrisons still get a sane threshold.
function invasionForceNeeded(defenderArmies: number): number {
	return Math.ceil(defenderArmies * 2.1) + 5;
}

interface InvasionPlan { from: number; to: number; needed: number; ready: boolean; }
// The best amphibious-closeout plan: an enemy hex we can't reach by land/sea-lane
// at all, plus the strongest of our hexes that has a clear straight-water launch
// line to it. `needed` is the force that launch hex must reach to win the assault
// across the invasion lane; `ready` is whether it's already there. Prefer the
// cheapest target (smallest garrison). Returns null if no enemy hex is reachable
// only by water. This is how the AI closes out water-locked opponents — and, via
// `needed`/`ready`, how it knows when to *stage* armies before committing.
function bestInvasionPlan(s: GameState, p: Player): InvasionPlan | null {
	let best: InvasionPlan | null = null;
	let bestScore = -Infinity;
	for (const t of s.map.grids) {
		const st = s.states[t.id];
		if (!st.owner || st.owner === p) continue; // enemy hexes only
		// Skip anything we can already reach by land or an existing sea lane —
		// those don't need an invasion, a normal attack will do.
		if (s.map.adj[t.id].some((n) => s.states[n].owner === p)) continue;
		// Our strongest hex with a clear straight-water line to the target becomes
		// the launch (and staging) site.
		let launch = -1, launchArm = -1;
		for (const g of s.map.grids) {
			if (s.states[g.id].owner !== p) continue;
			if (s.states[g.id].armies < 2) continue;
			if (s.map.adj[g.id].includes(t.id)) continue;
			if (!hasClearWaterPath(s, g.id, t.id)) continue;
			if (s.states[g.id].armies > launchArm) { launchArm = s.states[g.id].armies; launch = g.id; }
		}
		if (launch < 0) continue; // unreachable even by water — nothing we can do
		const needed = invasionForceNeeded(st.armies);
		const score = -st.armies; // cheapest garrison to crack first
		if (score > bestScore) {
			bestScore = score;
			best = { from: launch, to: t.id, needed, ready: launchArm >= needed };
		}
	}
	return best;
}

// Are we dominant enough that closing out a water-locked holdout should drive our
// play? Used to gate *staging* (funnelling armies to a launch hex) so ordinary
// mid-game maps — where transient water-locked hexes are common — aren't hijacked.
function isDominant(s: GameState, p: Player): boolean {
	let mine = 0, foes = 0;
	for (const g of s.map.grids) {
		const o = s.states[g.id].owner;
		if (o === p) mine++;
		else if (o) foes++;
	}
	return foes > 0 && mine >= (mine + foes) * 0.55;
}

// Play a Water Invasion when we hold the card and a launch hex is already strong
// enough to win the assault. Returns true if we launched one (which spends our
// card and resolves the attack). The temporary lane is cleaned up by the engine
// if the attack fails.
function tryWaterInvasion(p: Player): boolean {
	const s = get(game);
	if (s.cardPlayedThisTurn) return false;
	const idx = s.hands[p].findIndex((c) => c === 'invasion');
	if (idx < 0) return false;
	const plan = bestInvasionPlan(s, p);
	if (!plan || !plan.ready) return false;
	playCard(idx);
	if (get(game).phase !== 'invasion_from') { cancelAction(); return false; }
	selectGrid(plan.from);
	if (get(game).phase !== 'invasion_to') { cancelAction(); return false; }
	selectGrid(plan.to);
	// A successful launch drops straight into attack_rolling.
	if (get(game).phase !== 'attack_rolling') { cancelAction(); return false; }
	rollOutCurrentAttack();
	return true;
}

// Stage for a future invasion: move our biggest reachable stack one hop toward
// the launch hex, over our own territory. Mirrors `tryRepositionStack` but aims
// at a specific destination (the launch site) instead of the general front. Only
// used in dominant closeout positions. Returns true if a move was made (which
// ends the turn).
function stageTowardLaunch(p: Player, launch: number): boolean {
	const s = get(game);
	// BFS outward from the launch hex over our own territory to get each owned
	// hex's distance to it.
	const dist = new Map<number, number>();
	dist.set(launch, 0);
	const queue: number[] = [launch];
	let qi = 0;
	while (qi < queue.length) {
		const cur = queue[qi++];
		const d = dist.get(cur)!;
		for (const n of s.map.adj[cur]) {
			if (s.states[n].owner !== p || dist.has(n)) continue;
			if (wallBetween(s.map, cur, n)) continue;
			dist.set(n, d + 1);
			queue.push(n);
		}
	}
	// The hex (other than the launch site) whose armies × distance is largest —
	// the most misplaced mass — is the one worth marching forward.
	let bestFrom = -1, bestScore = -Infinity;
	for (const g of s.map.grids) {
		if (s.states[g.id].owner !== p) continue;
		const d = dist.get(g.id);
		if (!d) continue; // undefined (unreachable) or 0 (already the launch hex)
		const armies = s.states[g.id].armies;
		if (armies < 4) continue;
		const score = armies * d;
		if (score > bestScore) { bestScore = score; bestFrom = g.id; }
	}
	if (bestFrom < 0) return false;
	// Step toward the launch hex: the friendly neighbour with the smallest dist.
	const fromDist = dist.get(bestFrom)!;
	let bestNeighbor = -1, bestNeighborDist = fromDist;
	for (const n of s.map.adj[bestFrom]) {
		if (s.states[n].owner !== p) continue;
		if (wallBetween(s.map, bestFrom, n)) continue;
		const nd = dist.get(n);
		if (nd != null && nd < bestNeighborDist) { bestNeighborDist = nd; bestNeighbor = n; }
	}
	if (bestNeighbor < 0) return false;
	const qty = Math.max(1, s.states[bestFrom].armies - 1);
	beginMove();
	selectGrid(bestFrom);
	if (get(game).phase !== 'move_select_to') { cancelAction(); return false; }
	selectGrid(bestNeighbor);
	if (get(game).phase !== 'move_qty') { cancelAction(); return false; }
	confirmMove(qty); // ends the turn
	return true;
}

// Move a stranded rear stack one hop toward the nearest front-line hex
// (one of our own territories that borders an enemy or neutral hex). Only
// fires when there's a meaningfully large stack sitting idle away from the
// front — small garrisons are left alone. Returns true if a move was made
// (which ends the turn).
function tryRepositionStack(p: Player): boolean {
	const s = get(game);
	const frontline: number[] = [];
	for (const g of s.map.grids) {
		if (s.states[g.id].owner !== p) continue;
		if (s.map.adj[g.id].some((n) => s.states[n].owner !== p)) frontline.push(g.id);
	}
	if (frontline.length === 0) return false;

	// BFS from every front-line hex simultaneously, over our own territory
	// only, to get each owned hex's distance to the nearest front.
	const dist = new Map<number, number>();
	const queue: number[] = [];
	for (const id of frontline) { dist.set(id, 0); queue.push(id); }
	let qi = 0;
	while (qi < queue.length) {
		const cur = queue[qi++];
		const d = dist.get(cur)!;
		for (const n of s.map.adj[cur]) {
			if (s.states[n].owner !== p || dist.has(n)) continue;
			if (wallBetween(s.map, cur, n)) continue; // can't reposition across a wall
			dist.set(n, d + 1);
			queue.push(n);
		}
	}

	// Find the rear hex (distance ≥ 1 from any front-line hex) with the
	// biggest army count weighted by how far it is from the action.
	let bestFrom = -1;
	let bestScore = -Infinity;
	for (const g of s.map.grids) {
		if (s.states[g.id].owner !== p) continue;
		const d = dist.get(g.id);
		if (!d) continue; // d undefined (unreachable) or 0 (already front-line)
		const armies = s.states[g.id].armies;
		if (armies < 4) continue;
		const score = armies * d;
		if (score > bestScore) { bestScore = score; bestFrom = g.id; }
	}
	if (bestFrom < 0) return false;

	// Step one hop toward the front: the friendly neighbor with the smallest
	// distance value.
	const fromDist = dist.get(bestFrom)!;
	let bestNeighbor = -1;
	let bestNeighborDist = fromDist;
	for (const n of s.map.adj[bestFrom]) {
		if (s.states[n].owner !== p) continue;
		if (wallBetween(s.map, bestFrom, n)) continue;
		const nd = dist.get(n);
		if (nd != null && nd < bestNeighborDist) { bestNeighborDist = nd; bestNeighbor = n; }
	}
	if (bestNeighbor < 0) return false;

	const qty = Math.max(1, s.states[bestFrom].armies - 1); // leave a token garrison
	beginMove();
	selectGrid(bestFrom);
	if (get(game).phase !== 'move_select_to') { cancelAction(); return false; }
	selectGrid(bestNeighbor);
	if (get(game).phase !== 'move_qty') { cancelAction(); return false; }
	confirmMove(qty); // ends the turn
	return true;
}

function pickPlacementTarget(s: GameState, p: Player): number | null {
	// Prefer grids that (a) border enemies, weighted by enemy threat.
	let best = -1;
	let bestScore = -Infinity;
	for (const g of s.map.grids) {
		if (s.states[g.id].owner !== p) continue;
		let enemyForce = 0;
		let borders = 0;
		for (const n of s.map.adj[g.id]) {
			const st = s.states[n];
			if (st.owner && st.owner !== p) {
				borders++;
				enemyForce += st.armies;
			}
		}
		if (borders === 0) continue;
		// score: threat/opportunity - our armies
		const score = enemyForce * 2 + borders * 3 - s.states[g.id].armies;
		if (score > bestScore) { bestScore = score; best = g.id; }
	}
	if (best < 0) {
		// no borders — pick any owned grid
		for (const g of s.map.grids) if (s.states[g.id].owner === p) return g.id;
		return null;
	}
	return best;
}

// Same "must border an enemy" candidate set as pickPlacementTarget, but ranks
// candidates by the value network's predicted win probability after dumping
// this turn's reinforcements there, rather than the hand-tuned threat score.
function pickPlacementTargetWithValueNet(s: GameState, p: Player): number | null {
	let best = -1;
	let bestScore = -Infinity;
	for (const g of s.map.grids) {
		if (s.states[g.id].owner !== p) continue;
		const borders = s.map.adj[g.id].some((n) => s.states[n].owner && s.states[n].owner !== p);
		if (!borders) continue;

		const hypothetical: GameState = {
			...s,
			states: s.states.map((state, id) =>
				id === g.id ? { owner: p, armies: state.armies + s.armiesToPlace } : state
			)
		};
		const score = predictWinProb(hypothetical, p);
		if (score > bestScore) { bestScore = score; best = g.id; }
	}
	if (best < 0) {
		for (const g of s.map.grids) if (s.states[g.id].owner === p) return g.id;
		return null;
	}
	return best;
}

function choosePlacementTarget(s: GameState, p: Player): number | null {
	return valueNetPlayers.has(p) ? pickPlacementTargetWithValueNet(s, p) : pickPlacementTarget(s, p);
}

// Minimum estimated conquest probability before the AI opens an attack, by
// game difficulty (1..4). This is what makes the difficulty setting actually
// matter: low difficulties pick fights recklessly, high ones only commit when
// clearly favored. Uses the exact winProbability the human's UI shows, with
// the same terrain/fortification/crossing bonuses factored in.
const ATTACK_PROB_FLOOR: Record<number, number> = { 1: 0.3, 2: 0.45, 3: 0.55, 4: 0.65 };

// Whether attacking `to` from `from` clears the difficulty's win-chance bar.
// Undefended hexes are always worth walking into.
function attackWorthOpening(s: GameState, from: number, to: number): boolean {
	const def = s.states[to].armies;
	if (def <= 0) return true;
	const floor = ATTACK_PROB_FLOOR[s.difficulty] ?? 0.45;
	return winProbability(s.states[from].armies, def, defenseBonus(s, to, from), attackerBonus(s, to)) >= floor;
}

// Below this in-progress win probability, an already-committed attack is no
// longer worth continuing to roll. Lower than ATTACK_PROB_FLOOR (which gates
// *opening* a fight) since a few unlucky early rolls in an otherwise-good
// fight shouldn't cause an instant bail — but it stops the AI from grinding a
// stack down round after round once the odds have clearly turned against it
// (e.g. a defender bonus the raw army-count comparison doesn't see).
const ATTACK_CONTINUE_FLOOR = 0.2;

// Whether an in-progress attack (already past the opening odds check) is
// still worth another round of rolling, using the same win-probability model
// as attackWorthOpening rather than a raw army-count comparison.
function attackWorthContinuing(s: GameState, from: number, to: number): boolean {
	const fromArm = s.states[from].armies;
	if (fromArm < 3) return false;
	const toArm = s.states[to].armies;
	if (toArm <= 0) return true;
	return winProbability(fromArm, toArm, defenseBonus(s, to, from), attackerBonus(s, to)) >= ATTACK_CONTINUE_FLOOR;
}

interface AttackChoice { from: number; to: number; }
// Anti-snowball nudge: the player with strictly the most territory among
// those still alive (null if tied or fewer than 2 alive players), so attack
// scoring can lean toward ganging up on whoever's currently ahead instead of
// always picking the locally-best target. A flat bonus rather than a
// multiplier so it breaks ties/near-ties without overriding a clearly better
// opportunity elsewhere.
function territoryLeader(s: GameState): Player | null {
	let leader: Player | null = null;
	let bestCount = -1;
	let tied = false;
	for (const q of PLAYERS) {
		if (!s.alive[q]) continue;
		const c = countryCount(s, q);
		if (c > bestCount) { bestCount = c; leader = q; tied = false; }
		else if (c === bestCount) tied = true;
	}
	return tied ? null : leader;
}
const LEADER_ATTACK_BONUS = 5;

function findBestAttack(s: GameState, p: Player): AttackChoice | null {
	let best: AttackChoice | null = null;
	let bestScore = -Infinity;
	const leader = territoryLeader(s);
	for (const g of s.map.grids) {
		if (s.states[g.id].owner !== p) continue;
		const myArmies = s.states[g.id].armies;
		if (myArmies < 3) continue;
		for (const n of s.map.adj[g.id]) {
			const st = s.states[n];
			// Neutral (owner === null) hexes are valid targets too — only skip
			// our own territory.
			if (st.owner === p) continue;
			// A wall on this edge blocks the attack entirely.
			if (wallBetween(s.map, g.id, n)) continue;
			const margin = myArmies - st.armies;
			if (margin < 2) continue;
			if (!attackWorthOpening(s, g.id, n)) continue;
			// Neutrals are effectively free real estate; weight them so the AI
			// prefers scooping up an empty hex over grinding an enemy.
			let score = st.owner ? margin * 4 - st.armies : margin * 4 + 20;
			if (st.owner && st.owner === leader) score += LEADER_ATTACK_BONUS;
			if (score > bestScore) { bestScore = score; best = { from: g.id, to: n }; }
		}
	}
	return best;
}

// Same candidate generation/legality as findBestAttack, but ranks candidates
// by the value network's predicted win probability of the post-conquest
// board rather than the hand-tuned margin heuristic. The post-conquest state
// is approximate (assumes the attack succeeds and moves in half the stack —
// mirroring the move-in the attack loop actually performs) since we can't
// know the real dice outcome ahead of time; this is a 1-ply lookahead over
// "what if I take this hex," not a full attack simulation.
function findBestAttackWithValueNet(s: GameState, p: Player): AttackChoice | null {
	let best: AttackChoice | null = null;
	let bestScore = -Infinity;
	const leader = territoryLeader(s);
	for (const g of s.map.grids) {
		const myArmies = s.states[g.id].armies;
		if (s.states[g.id].owner !== p || myArmies < 3) continue;
		for (const n of s.map.adj[g.id]) {
			const st = s.states[n];
			if (st.owner === p) continue;
			if (wallBetween(s.map, g.id, n)) continue;
			const margin = myArmies - st.armies;
			if (margin < 2) continue;
			if (!attackWorthOpening(s, g.id, n)) continue;

			const movedIn = Math.max(1, Math.floor(myArmies / 2));
			const hypothetical: GameState = {
				...s,
				states: s.states.map((state, id) => {
					if (id === g.id) return { owner: p, armies: myArmies - movedIn };
					if (id === n) return { owner: p, armies: movedIn };
					return state;
				})
			};
			// Value net scores are win probabilities in [0, 1]; a flat 5%
			// nudge mirrors the heuristic's LEADER_ATTACK_BONUS in spirit.
			let score = predictWinProb(hypothetical, p);
			if (st.owner && st.owner === leader) score += 0.05;
			if (score > bestScore) { bestScore = score; best = { from: g.id, to: n }; }
		}
	}
	return best;
}

// Pick the strongest enemy hex that borders us (for bomb / sabotage targets).
function findStrongestBorderEnemy(s: GameState, p: Player): number | null {
	let best = -1;
	let bestArm = 0;
	for (const g of s.map.grids) {
		const st = s.states[g.id];
		if (!st.owner || st.owner === p) continue;
		const borders = s.map.adj[g.id].some((n) => s.states[n].owner === p);
		if (!borders) continue;
		if (st.armies > bestArm) { bestArm = st.armies; best = g.id; }
	}
	return best >= 0 ? best : null;
}
// Pick our weakest border hex for fortification.
function findWeakestBorder(s: GameState, p: Player): number | null {
	let best = -1;
	let bestArm = Infinity;
	for (const g of s.map.grids) {
		if (s.states[g.id].owner !== p) continue;
		if (s.states[g.id].fortified) continue;
		const borders = s.map.adj[g.id].some((n) => s.states[n].owner && s.states[n].owner !== p);
		if (!borders) continue;
		if (s.states[g.id].armies < bestArm) { bestArm = s.states[g.id].armies; best = g.id; }
	}
	return best >= 0 ? best : null;
}
// Pick a wall placement: seal off the edge where a weak border hex of ours
// faces its strongest adjacent enemy. Returns the {from: owned, to: enemy}
// pair, skipping river edges and edges already walled.
interface WallChoice { from: number; to: number; }
function findWallPlacement(s: GameState, p: Player): WallChoice | null {
	let best: WallChoice | null = null;
	let bestScore = -Infinity;
	for (const g of s.map.grids) {
		if (s.states[g.id].owner !== p) continue;
		for (const n of s.map.adj[g.id]) {
			const nt = s.states[n];
			if (!nt.owner || nt.owner === p) continue; // only wall off enemies
			if (s.map.grids[n].island !== s.map.grids[g.id].island) continue; // needs a shared edge
			if (crossesRiver(s.map, g.id, n)) continue; // rivers can't be walled
			if (wallBetween(s.map, g.id, n)) continue; // already walled
			// Wall off the biggest threat relative to how thin our garrison is.
			const score = nt.armies * 2 - s.states[g.id].armies;
			if (score > bestScore) { bestScore = score; best = { from: g.id, to: n }; }
		}
	}
	return best;
}
// Pick a wall to tear down: an edge between one of our hexes and an enemy's,
// preferring the case where that enemy is the last rival standing — a
// self-walled-in "stronghold" is otherwise an unconquerable stalemate that
// would deadlock the game forever (Wall has no aging/limit, so a defender can
// keep sealing every remaining edge). Mirrors findWallPlacement but for the
// opposite goal: reopening an attack lane rather than closing one.
function findBreachTarget(s: GameState, p: Player): WallChoice | null {
	let best: WallChoice | null = null;
	let bestScore = -Infinity;
	const aliveOthers = PLAYERS.filter((q) => q !== p && s.alive[q]).length;
	for (const [a, b] of s.map.walls ?? []) {
		const ours = s.states[a].owner === p ? a : s.states[b].owner === p ? b : null;
		if (ours == null) continue;
		const other = ours === a ? b : a;
		const ot = s.states[other];
		if (!ot.owner || ot.owner === p) continue; // only breach into an enemy
		// Last-rival stalemate takes priority over ordinary tactical breaches;
		// otherwise prefer breaching where we already outnumber the defender.
		const score = (aliveOthers <= 1 ? 1000 : 0) + s.states[ours].armies - ot.armies;
		if (score > bestScore) { bestScore = score; best = { from: ours, to: other }; }
	}
	return best;
}
// Pick a river edge between us and an enemy to drain (Levee): permanently
// removes the +1 river-crossing defender bonus there, prepping a future
// attack across that edge. Prefer the edge where we already have the bigger
// army edge, i.e. the crossing we're most likely to actually use.
function findLeveeTarget(s: GameState, p: Player): WallChoice | null {
	let best: WallChoice | null = null;
	let bestScore = -Infinity;
	for (const [a, b] of s.map.rivers) {
		const oa = s.states[a].owner, ob = s.states[b].owner;
		let mine = -1, foe = -1;
		if (oa === p && ob && ob !== p) { mine = a; foe = b; }
		else if (ob === p && oa && oa !== p) { mine = b; foe = a; }
		else continue;
		const score = s.states[mine].armies - s.states[foe].armies;
		if (score > bestScore) { bestScore = score; best = { from: mine, to: foe }; }
	}
	return best;
}
// Worth relocating our capital? Either we've already lost it (occupied by an
// enemy — relocating immediately regains the +3 capitalBonus on a hex we
// actually hold) or it's sitting exposed on the front line (bordering an
// enemy), which is worth trading a card to fix before it's captured.
function needsCapitalRelocation(s: GameState, p: Player): boolean {
	const cap = s.capitals?.[p];
	if (cap == null) return false;
	const st = s.states[cap];
	if (st.owner !== p) return true;
	return s.map.adj[cap].some((n) => s.states[n].owner && s.states[n].owner !== p);
}
// Best relocation target: our strongest owned hex that ISN'T on the front
// line (a safe interior hex), so the new capital doesn't just repeat the
// problem next turn.
function bestRelocateTarget(s: GameState, p: Player): number | null {
	let best = -1, bestScore = -Infinity;
	for (const g of s.map.grids) {
		if (s.states[g.id].owner !== p) continue;
		if (s.capitals?.[p] === g.id) continue;
		const onFront = s.map.adj[g.id].some((n) => s.states[n].owner && s.states[n].owner !== p);
		const score = s.states[g.id].armies - (onFront ? 20 : 0);
		if (score > bestScore) { bestScore = score; best = g.id; }
	}
	return best >= 0 ? best : null;
}
// Pick an adjacent enemy plains/forest hex to burn to desert (Scorched
// Earth): unlike Deforestation's one-time bonus removal, this saddles
// whoever holds the hex with ongoing per-turn attrition, so the biggest
// enemy garrison on a burnable border hex is the best payoff.
function findScorchedTarget(s: GameState, p: Player): number | null {
	let best = -1, bestArm = -1;
	for (const g of s.map.grids) {
		if (g.production) continue;
		if (g.terrain !== 'plain' && g.terrain !== 'forest') continue;
		const st = s.states[g.id];
		if (!st.owner || st.owner === p) continue;
		if (!s.map.adj[g.id].some((n) => s.states[n].owner === p)) continue;
		if (st.armies > bestArm) { bestArm = st.armies; best = g.id; }
	}
	return best >= 0 ? best : null;
}
// Pick an adjacent enemy forest hex to clear.
function findForestNeighbor(s: GameState, p: Player): number | null {
	for (const g of s.map.grids) {
		if (s.states[g.id].owner !== p) continue;
		for (const n of s.map.adj[g.id]) {
			const nt = s.states[n];
			if (nt.owner && nt.owner !== p && s.map.grids[n].terrain === 'forest') return n;
		}
	}
	return null;
}

// Best Artillery shot: from one of our cities (2+ armies), bombard the
// strongest reachable (within 2 steps) enemy/neutral hex — the card's four
// guaranteed hits with zero attacker risk make raw target strength (not
// margin) the right thing to maximize.
function bestArtilleryPlan(s: GameState, p: Player): { from: number; to: number } | null {
	let best: { from: number; to: number } | null = null;
	let bestScore = -Infinity;
	for (const g of s.map.grids) {
		if (s.states[g.id].owner !== p || !g.production) continue;
		if (s.states[g.id].armies < 2) continue;
		for (const t of s.map.grids) {
			if (!canArtilleryTarget(s, g.id, t.id)) continue;
			const st = s.states[t.id];
			if (st.armies < 3) continue; // not worth the card on a nearly-empty hex
			const score = st.armies + (st.owner ? 2 : 0);
			if (score > bestScore) { bestScore = score; best = { from: g.id, to: t.id }; }
		}
	}
	return best;
}

// Best Air Move: instantly relocate our biggest stack that has no overland
// route to any front-line hex (e.g. stranded on an islet with no sea lane)
// onto the front-line hex facing the biggest threat. Mirrors
// tryRepositionStack's frontline BFS, but Air Move is worth spending on a
// stack that BFS can't reach at all, not just one that's merely far away.
function bestAirLiftPlan(s: GameState, p: Player): { from: number; to: number; qty: number } | null {
	const frontline: number[] = [];
	for (const g of s.map.grids) {
		if (s.states[g.id].owner !== p) continue;
		if (s.map.adj[g.id].some((n) => s.states[n].owner !== p)) frontline.push(g.id);
	}
	if (frontline.length === 0) return null;
	const dist = new Map<number, number>();
	const queue: number[] = [];
	for (const id of frontline) { dist.set(id, 0); queue.push(id); }
	let qi = 0;
	while (qi < queue.length) {
		const cur = queue[qi++];
		const d = dist.get(cur)!;
		for (const n of s.map.adj[cur]) {
			if (s.states[n].owner !== p || dist.has(n)) continue;
			if (wallBetween(s.map, cur, n)) continue;
			dist.set(n, d + 1);
			queue.push(n);
		}
	}
	let from = -1, fromArm = -1;
	for (const g of s.map.grids) {
		if (s.states[g.id].owner !== p || dist.has(g.id)) continue; // reachable overland — not stranded
		if (s.states[g.id].armies < 4) continue;
		if (s.states[g.id].armies > fromArm) { fromArm = s.states[g.id].armies; from = g.id; }
	}
	if (from < 0) return null;
	let to = -1, bestScore = -Infinity;
	for (const id of frontline) {
		let enemyForce = 0;
		for (const n of s.map.adj[id]) {
			const st = s.states[n];
			if (st.owner && st.owner !== p) enemyForce += st.armies;
		}
		const score = enemyForce - s.states[id].armies;
		if (score > bestScore) { bestScore = score; to = id; }
	}
	if (to < 0) return null;
	return { from, to, qty: Math.max(1, s.states[from].armies - 1) };
}

// Best Ferry Route: link our strongest owned hex (the "mainland" anchor) to
// whichever of our own hexes is cut off from it by water — same "stranded"
// definition as bestAirLiftPlan, but a Ferry is a permanent fix rather than a
// one-off airlift, so prefer it when a clean water path exists.
function bestFerryPlan(s: GameState, p: Player): { from: number; to: number } | null {
	let anchor = -1, anchorArm = -1;
	for (const g of s.map.grids) {
		if (s.states[g.id].owner === p && s.states[g.id].armies > anchorArm) {
			anchorArm = s.states[g.id].armies;
			anchor = g.id;
		}
	}
	if (anchor < 0) return null;
	const reachable = new Set<number>([anchor]);
	const queue = [anchor];
	let qi = 0;
	while (qi < queue.length) {
		const cur = queue[qi++];
		for (const n of s.map.adj[cur]) {
			if (s.states[n].owner !== p || reachable.has(n)) continue;
			if (wallBetween(s.map, cur, n)) continue;
			reachable.add(n);
			queue.push(n);
		}
	}
	let bestFrom = -1, bestTo = -1, bestScore = -Infinity;
	for (const g of s.map.grids) {
		if (s.states[g.id].owner !== p || reachable.has(g.id)) continue;
		for (const m of reachable) {
			if (!canFerryConnect(s, m, g.id)) continue;
			const score = s.states[g.id].armies + s.states[m].armies;
			if (score > bestScore) { bestScore = score; bestFrom = m; bestTo = g.id; }
		}
	}
	return bestFrom >= 0 ? { from: bestFrom, to: bestTo } : null;
}

// Best Storm target: sever a sea lane that gives an enemy a water route
// straight onto one of our hexes — an existing invasion/ferry lane sitting on
// our border is a standing threat, so cutting the biggest one (by the
// attacker's army edge) is the priority. Mirrors bestCollapseTarget's
// same-shape "cut the threatening route" logic for tunnels.
function findStormTarget(s: GameState, p: Player): { from: number; to: number } | null {
	let best: { from: number; to: number } | null = null;
	let bestScore = -Infinity;
	for (const [a, b] of s.map.seaLanes) {
		const oa = s.states[a].owner, ob = s.states[b].owner;
		let mine = -1, foe = -1;
		if (oa === p && ob && ob !== p) { mine = a; foe = b; }
		else if (ob === p && oa && oa !== p) { mine = b; foe = a; }
		else continue;
		const threat = s.states[foe].armies - s.states[mine].armies;
		if (threat < 1) continue;
		if (threat > bestScore) { bestScore = threat; best = { from: mine, to: foe }; }
	}
	return best;
}

// Play Elite Troops / Bridge / Mountaineering ahead of the attack loop, if we
// hold one and it would apply to the attack the loop is about to make. Must
// run BEFORE findBestAttack's chosen target is attacked — see the call site
// in runAiTurn for why. Priority mirrors the old in-loop order: Elite (always
// good) > Bridge (river crossing) > Mountaineering (mountain target).
function tryPlayAttackBuffCard(p: Player): boolean {
	const s = get(game);
	if (s.cardPlayedThisTurn) return false;
	const opp = valueNetPlayers.has(p) ? findBestAttackWithValueNet(s, p) : findBestAttack(s, p);
	if (!opp) return false;
	{
		const idx = s.hands[p].findIndex((c) => c === 'elite');
		if (idx >= 0) { playCard(idx); return true; }
	}
	{
		const idx = s.hands[p].findIndex((c) => c === 'bridge');
		if (idx >= 0 && crossesRiver(s.map, opp.from, opp.to)) { playCard(idx); return true; }
	}
	{
		const idx = s.hands[p].findIndex((c) => c === 'mountaineer');
		if (idx >= 0 && s.map.grids[opp.to].terrain === 'mountain') { playCard(idx); return true; }
	}
	return false;
}

// A legal, executable card play, plus a score in the same rough
// "army-equivalent value" currency across every card kind (grounded in the
// same magnitude estimates used for the card rarity rebalance -- see the
// card-power analysis this session). `find` is a pure board-state query --
// it does NOT check whether the card is actually in hand, so it doubles as
// a "would this be worth buying right now" check for runAiMarket below. A
// single source of truth here means a card's AI-perceived value can't
// silently drift between "should I play this" and "should I buy this" the
// way two separately maintained heuristics would.
interface CardOpportunity {
	score: number;
	play: (idx: number) => void;
}
type OpportunityFinder = (s: GameState, p: Player) => CardOpportunity | null;

// Every card tryPlayCardAction can actually execute. (Elite/Bridge/
// Mountaineering are handled earlier by tryPlayAttackBuffCard instead, since
// they must run before the attack loop; Water Invasion by tryWaterInvasion,
// since it drives a whole attack sequence of its own. Antibomb/Antiair/Naval
// Patrol are passive -- never actively played at all. All seven still get a
// buy-time-only value below, in BUY_ONLY_VALUE.)
const CARD_PLAY_FINDERS: Partial<Record<CardType, OpportunityFinder>> = {
	// Reinforce: +3 armies straight onto a border hex. Flat, reliable value —
	// bought in the market like any other card, so it needs its own play here
	// now (used to be played the instant it was drawn, during placement).
	reinforce: (s, p) => {
		const target = pickPlacementTarget(s, p);
		if (target == null) return null;
		return { score: 3, play: (idx) => { playCard(idx); if (get(game).phase === 'reinforce_select') selectGrid(target); } };
	},
	// Paratroop a strong stack onto a weak, valuable enemy hex.
	paratroop: (s, p) => {
		const plan = bestParatroopPlan(s, p);
		if (!plan) return null;
		return {
			score: 4,
			play: (idx) => {
				playCard(idx);
				if (get(game).phase === 'paratroop_from') selectGrid(plan.from);
				if (get(game).phase === 'paratroop_to') selectGrid(plan.to);
				if (get(game).phase === 'paratroop_qty') confirmParatroop(plan.qty);
				else cancelAction();
			}
		};
	},
	// Artillery: risk-free hits on the strongest reachable target from a city.
	artillery: (s, p) => {
		const plan = bestArtilleryPlan(s, p);
		if (!plan) return null;
		return {
			score: 5,
			play: (idx) => {
				playCard(idx);
				if (get(game).phase === 'artillery_from') selectGrid(plan.from);
				if (get(game).phase === 'artillery_to') selectGrid(plan.to);
			}
		};
	},
	// Tunnel under a fortified/mountain hex (or one we can't reach overland)
	// and storm it with every defense bonus stripped away. Drives the roll
	// out just like a Water Invasion, since it also drops into attack_rolling.
	// Scored highest of the attack cards: it's the only hard counter to a
	// permanently-fortified hex (see this session's late-game-grind finding).
	tunnel: (s, p) => {
		const plan = bestTunnelPlan(s, p);
		if (!plan) return null;
		return {
			score: 6,
			play: (idx) => {
				playCard(idx);
				if (get(game).phase !== 'tunnel_from') { cancelAction(); return; }
				selectGrid(plan.from);
				if (get(game).phase !== 'tunnel_to') { cancelAction(); return; }
				selectGrid(plan.to);
				if (get(game).phase === 'attack_rolling') rollOutCurrentAttack();
				else cancelAction();
			}
		};
	},
	// Collapse an enemy tunnel that opens onto us before they can exploit it.
	collapse: (s, p) => {
		const target = bestCollapseTarget(s, p);
		if (!target) return null;
		return {
			score: 3,
			play: (idx) => {
				playCard(idx);
				if (get(game).phase === 'collapse_from') selectGrid(target.from);
				if (get(game).phase === 'collapse_to') selectGrid(target.to);
			}
		};
	},
	// Breach a wall blocking an attack — critical when an enemy has sealed
	// itself in behind Wall cards, since that's otherwise unconquerable and
	// would deadlock the game (see findBreachTarget) — scored accordingly high.
	breach: (s, p) => {
		const target = findBreachTarget(s, p);
		if (target == null) return null;
		return {
			score: 5,
			play: (idx) => {
				playCard(idx);
				if (get(game).phase === 'breach_from') selectGrid(target.from);
				if (get(game).phase === 'breach_to') selectGrid(target.to);
			}
		};
	},
	// Storm a sea lane an enemy could invade us through.
	storm: (s, p) => {
		const target = findStormTarget(s, p);
		if (target == null) return null;
		return {
			score: 2,
			play: (idx) => {
				playCard(idx);
				if (get(game).phase === 'storm_from') selectGrid(target.from);
				if (get(game).phase === 'storm_to') selectGrid(target.to);
			}
		};
	},
	// Coalition: rally everyone (ourselves included) against whoever's
	// currently leading in territory -- the deliberate, player-triggerable
	// cousin of the LEADER_ATTACK_BONUS nudge above. Skip if one's already
	// active (don't waste a second copy) or if we ourselves are the leader
	// (nothing to gang up on).
	coalition: (s, p) => {
		if (s.coalitionTarget) return null;
		const leader = territoryLeader(s);
		const targetHex = leader && leader !== p ? s.map.grids.find((g) => s.states[g.id].owner === leader)?.id : undefined;
		if (targetHex == null) return null;
		return {
			score: 3,
			play: (idx) => {
				playCard(idx);
				if (get(game).phase === 'coalition_select') selectGrid(targetHex);
			}
		};
	},
	// Bomb a beefy enemy hex on our border — scaled up with target size on
	// top of the base value, so a truly juicy target can outrank cards that
	// otherwise score higher on a thin one.
	bomb: (s, p) => {
		const target = findStrongestBorderEnemy(s, p);
		if (target == null || s.states[target].armies < 6) return null;
		return {
			score: 3 + s.states[target].armies * 0.3,
			play: (idx) => {
				playCard(idx);
				if (get(game).phase === 'bomb_select') selectGrid(target);
			}
		};
	},
	// Sabotage as a fallback.
	sabotage: (s, p) => {
		const target = findStrongestBorderEnemy(s, p);
		if (target == null || s.states[target].armies < 5) return null;
		return {
			score: 3 + s.states[target].armies * 0.3,
			play: (idx) => {
				playCard(idx);
				if (get(game).phase === 'sabotage_select') selectGrid(target);
			}
		};
	},
	// Deforest an adjacent enemy forest to weaken future defense.
	deforest: (s, p) => {
		const target = findForestNeighbor(s, p);
		if (target == null) return null;
		return { score: 2, play: (idx) => { playCard(idx); if (get(game).phase === 'deforest_select') selectGrid(target); } };
	},
	// Scorched Earth: burn a border enemy hex to desert for ongoing attrition.
	scorched: (s, p) => {
		const target = findScorchedTarget(s, p);
		if (target == null) return null;
		return { score: 3, play: (idx) => { playCard(idx); if (get(game).phase === 'scorched_select') selectGrid(target); } };
	},
	// Oasis: irrigate one of our own desert hexes to remove heat attrition.
	oasis: (s, p) => {
		const target = s.map.grids.findIndex((g) => g.terrain === 'desert' && s.states[g.id].owner === p);
		if (target < 0) return null;
		return { score: 2, play: (idx) => { playCard(idx); if (get(game).phase === 'oasis_select') selectGrid(target); } };
	},
	// Fortify weakest border.
	fortify: (s, p) => {
		const target = findWeakestBorder(s, p);
		if (target == null) return null;
		return { score: 4, play: (idx) => { playCard(idx); if (get(game).phase === 'fortify_select') selectGrid(target); } };
	},
	// Rampart weakest border.
	rampart: (s, p) => {
		const target = findWeakestBorder(s, p);
		if (target == null) return null;
		return { score: 2, play: (idx) => { playCard(idx); if (get(game).phase === 'rampart_select') selectGrid(target); } };
	},
	// Spy: steal from the richest hand as soon as anyone has cards to take.
	spy: (s, p) => {
		const anyLoot = PLAYERS.some((q) => q !== p && s.alive[q] && s.hands[q].length > 0);
		if (!anyLoot) return null;
		return { score: 3, play: (idx) => playCard(idx) };
	},
	// Wall off a threatening enemy edge.
	wall: (s, p) => {
		const target = findWallPlacement(s, p);
		if (target == null) return null;
		return {
			score: 4,
			play: (idx) => {
				playCard(idx);
				if (get(game).phase === 'wall_from') selectGrid(target.from);
				if (get(game).phase === 'wall_to') selectGrid(target.to);
			}
		};
	},
	// Canal: same "seal the scariest border edge" logic as Wall, but with the
	// +1 river-crossing bonus instead of a hard block (identical edge
	// constraints, so findWallPlacement's choice is always canal-legal).
	canal: (s, p) => {
		const target = findWallPlacement(s, p);
		if (target == null) return null;
		return {
			score: 3,
			play: (idx) => {
				playCard(idx);
				if (get(game).phase === 'canal_from') selectGrid(target.from);
				if (get(game).phase === 'canal_to') selectGrid(target.to);
			}
		};
	},
	// Levee: drain a river edge we're likely to attack across, permanently
	// removing the crossing bonus that's holding that attack back.
	levee: (s, p) => {
		const target = findLeveeTarget(s, p);
		if (target == null) return null;
		return {
			score: 2,
			play: (idx) => {
				playCard(idx);
				if (get(game).phase === 'levee_from') selectGrid(target.from);
				if (get(game).phase === 'levee_to') selectGrid(target.to);
			}
		};
	},
	// Relocate Capital: reclaim it after losing it, or move it off the front
	// line before it's captured. Only ever a candidate when actually needed
	// (needsCapitalRelocation), so it's scored high — when it applies, it's
	// usually urgent.
	relocate: (s, p) => {
		if (!needsCapitalRelocation(s, p)) return null;
		const target = bestRelocateTarget(s, p);
		if (target == null) return null;
		return { score: 5, play: (idx) => { playCard(idx); if (get(game).phase === 'relocate_select') selectGrid(target); } };
	},
	// Ferry: permanently link a stranded holding back to our main network.
	ferry: (s, p) => {
		const plan = bestFerryPlan(s, p);
		if (!plan) return null;
		return {
			score: 2,
			play: (idx) => {
				playCard(idx);
				if (get(game).phase === 'ferry_from') selectGrid(plan.from);
				if (get(game).phase === 'ferry_to') selectGrid(plan.to);
			}
		};
	},
	// Air Move: rescue a stack stranded with no overland or lane route to any
	// front line at all. Under the old fixed-priority dispatch this was last
	// in line and almost never actually won a turn (nearly any other legal
	// card pre-empted it) — scoring puts it on equal footing whenever it's
	// the genuinely best (or only) option.
	air: (s, p) => {
		const plan = bestAirLiftPlan(s, p);
		if (!plan) return null;
		return {
			score: 3,
			play: (idx) => {
				playCard(idx);
				if (get(game).phase === 'air_from') selectGrid(plan.from);
				if (get(game).phase === 'air_to') selectGrid(plan.to);
				if (get(game).phase === 'air_qty') confirmAir(plan.qty);
				else cancelAction();
			}
		};
	}
};

// Try to play one card during the action phase. Elite/Bridge/Mountaineering
// are handled earlier, before the attack loop — see tryPlayAttackBuffCard.
function tryPlayCardAction(p: Player) {
	const s = get(game);
	if (s.cardPlayedThisTurn) return;
	const candidates: { score: number; execute: () => void }[] = [];
	for (let idx = 0; idx < s.hands[p].length; idx++) {
		const opp = CARD_PLAY_FINDERS[s.hands[p][idx]]?.(s, p);
		if (opp) candidates.push({ score: opp.score, execute: () => opp.play(idx) });
	}
	if (candidates.length === 0) return;
	candidates.sort((a, b) => b.score - a.score);
	candidates[0].execute();
}

// Buy-time-only value for cards CARD_PLAY_FINDERS doesn't cover (see its
// comment for why each is handled elsewhere for actually playing it) — still
// need SOME estimate of "is this worth gold right now" so runAiMarket can
// compare them fairly against everything else instead of always losing to a
// cheaper card, which is what made half the roster nearly unbuyable before
// this was tuned (see this session's empirical buy-rate analysis).
const BUY_ONLY_VALUE: Partial<Record<CardType, (s: GameState, p: Player) => number>> = {
	// Same "closer" plans that used to be a separate hardcoded priority list —
	// folded in here so they compete on the same scale as everything else
	// instead of needing their own bypass mechanism.
	invasion: (s, p) => (bestInvasionPlan(s, p) ? 6 : 0),
	// Elite/Bridge/Mountaineering: reuse the same attack lookup
	// tryPlayAttackBuffCard uses to decide whether they'd apply right now.
	elite: (s, p) => ((valueNetPlayers.has(p) ? findBestAttackWithValueNet(s, p) : findBestAttack(s, p)) ? 3 : 0),
	bridge: (s, p) => {
		const opp = valueNetPlayers.has(p) ? findBestAttackWithValueNet(s, p) : findBestAttack(s, p);
		return opp && crossesRiver(s.map, opp.from, opp.to) ? 3 : 0;
	},
	mountaineer: (s, p) => {
		const opp = valueNetPlayers.has(p) ? findBestAttackWithValueNet(s, p) : findBestAttack(s, p);
		return opp && s.map.grids[opp.to].terrain === 'mountain' ? 3 : 0;
	},
	// Passive defenses (never actively played — they just sit in hand and
	// apply automatically) are always modestly useful ambient insurance.
	antibomb: () => 2,
	antiair: () => 2,
	navalpatrol: () => 2
};

function cardValue(s: GameState, p: Player, card: CardType): number {
	return CARD_PLAY_FINDERS[card]?.(s, p)?.score ?? BUY_ONLY_VALUE[card]?.(s, p) ?? 0;
}

// A card is worth buying once it clears this bar — below it, the gold is
// better banked for armies. Set just under the flat baseline score (2) most
// "always somewhat useful" cards carry (rampart/oasis/storm/deforest/ferry/
// levee/the three passives), so a first copy of one of those is still
// buyable, but a second copy of the same card isn't (2 / (1 + 1 held) = 1,
// below the bar) — the discount-per-copy is what's actually doing the
// "don't overspend on redundant filler" work, not this threshold. Simulation
// history (500-game runs): threshold 1 with an uncapped-per-turn budget share
// → ~290 turns/game (bought too often, sometimes 2-3 cards a turn); threshold
// 3 → zeroed out every flat-2 card entirely, buys=0 for 9 of 29 cards (the
// exact "half the roster is dead" bug this redesign exists to fix, just
// relocated to a different tier); a hard 1-purchase-per-turn cap at a low
// threshold (0.5) → ~270 turns/game (bought *something* nearly every turn
// instead of skipping unless it mattered). 1.5 + the budget share below
// lands at ~170 turns/game (pre-economy baseline ~157) with a ~1% simulated
// timeout rate and every one of the 29 cards bought at a nonzero rate.
const MIN_CARD_VALUE = 1.5;
// Total gold this shopping turn is willing to put toward cards+rerolls,
// shrinking as purchases happen — naturally self-limits to usually one, only
// occasionally two, purchases per turn instead of MIN_CARD_VALUE trying to
// do that job via a hard score cutoff.
const MAX_CARD_SPEND_SHARE = 0.3;

/**
 * Run the AI's shop: repeatedly buy whichever offered card currently scores
 * highest via cardValue (discounted per copy already held, to encourage
 * variety over hoarding five of the same thing), reroll once if nothing in
 * the offer clears the bar, then dump every remaining gold into armies and
 * end shopping. Always calls finishShopping, so the caller can assume phase
 * has moved on to 'placing' or 'action'.
 */
function runAiMarket(p: Player) {
	const startingGold = get(game).gold[p];
	let rerolled = false;

	for (let guard = 0; guard < 8; guard++) {
		// buyCard pauses in 'discard' instead of auto-trimming when the buyer
		// is flagged human (isHumanPlayer) — which stays true for whoever the
		// UI's human slot is even under auto-play, where the AI is actually
		// driving that turn. Nothing is waiting on a real tap here, so resolve
		// it immediately (same arbitrary-index approach runAiTurn's own
		// leftover-phase recovery uses) rather than let the turn get
		// force-cancelled below with the hand never actually trimmed — left
		// alone this grows the hand without bound, turn after turn, since the
		// limit is never enforced (confirmed via simulation: 0 -> 26+ cards
		// over ~170 turns).
		let discardSafety = 0;
		while (get(game).phase === 'discard' && get(game).current === p && discardSafety++ < 20) {
			discardCard(0);
		}
		const s = get(game);
		if (s.phase !== 'buy' || s.current !== p) return;
		const spentSoFar = startingGold - s.gold[p]; // armies aren't bought until after this loop
		const cardBudgetLeft = startingGold * MAX_CARD_SPEND_SHARE - spentSoFar;
		if (cardBudgetLeft <= 0) break;

		let best: { i: number; score: number } | null = null;
		for (let i = 0; i < s.marketOffer.length; i++) {
			const card = s.marketOffer[i];
			if (!card) continue;
			const price = cardPrice(CARD_BY_ID[card].weight);
			if (price > s.gold[p] || price > cardBudgetLeft) continue;
			const held = s.hands[p].filter((c) => c === card).length;
			const score = cardValue(s, p, card) / (1 + held);
			if (score >= MIN_CARD_VALUE && (!best || score > best.score)) best = { i, score };
		}
		if (best) {
			buyCard(best.i);
			continue;
		}
		// Nothing in the current offer is worth buying — try one reroll to see
		// something better, but only once, and only if it's affordable within
		// what's left of the card budget (don't blow the budget hunting).
		if (!rerolled) {
			const cost = rerollCost(s);
			if (cost <= s.gold[p] && cost <= cardBudgetLeft) {
				rerollMarket();
				rerolled = true;
				continue;
			}
		}
		break;
	}

	const s = get(game);
	if (s.phase === 'buy') {
		buyArmies(s.gold[p]);
		finishShopping();
	}
}

// The best paratroop drop, or null when none is worth the card: launch from
// our single biggest stack, onto the enemy hex where a committed force with
// ~2:1 odds (paratroopers fight to the death — no retreating between rolls)
// is affordable and the prize is best. Cities and hexes we can't reach by
// land/lane score extra, since the drop ignores adjacency entirely.
function bestParatroopPlan(s: GameState, p: Player): { from: number; to: number; qty: number } | null {
	let from = -1, fromArm = 0;
	for (const g of s.map.grids) {
		if (s.states[g.id].owner === p && s.states[g.id].armies > fromArm) {
			fromArm = s.states[g.id].armies;
			from = g.id;
		}
	}
	if (from < 0 || fromArm < 8) return null; // don't gut a thin front line for a stunt
	const maxCommit = fromArm - 1;
	let best: { from: number; to: number; qty: number } | null = null;
	let bestScore = -Infinity;
	for (const t of s.map.grids) {
		const st = s.states[t.id];
		if (!st.owner || st.owner === p) continue; // enemy-held hexes only — the card is too rare for neutrals
		const needed = Math.ceil(st.armies * 2) + 3;
		if (needed > maxCommit) continue;
		let score = -st.armies;
		if (t.production) score += 6;
		if (!s.map.adj[t.id].some((n) => s.states[n].owner === p)) score += 8; // unreachable by land: prime target
		if (score > bestScore) {
			bestScore = score;
			best = { from, to: t.id, qty: Math.min(maxCommit, needed) };
		}
	}
	return best;
}

// The best Tunnel assault, or null when none is worth the card. A tunnel is
// worth digging when it lets us hit a hex we CAN'T reach overland (the card
// only connects non-adjacent hexes) AND either the target is a fortified /
// mountainous / rampart'd hex whose bonuses we'd bypass, or a city worth the
// reach. We need a comfortable army margin because the assault is a normal
// retreatable dice sequence — just with the defender stripped of every bonus.
function bestTunnelPlan(s: GameState, p: Player): { from: number; to: number } | null {
	let best: { from: number; to: number } | null = null;
	let bestScore = -Infinity;
	for (const g of s.map.grids) {
		if (s.states[g.id].owner !== p) continue;
		const myArmies = s.states[g.id].armies;
		if (myArmies < 5) continue; // keep a garrison and still field a real force
		for (const t of s.map.grids) {
			if (!canTunnelConnect(s, g.id, t.id)) continue; // enforces reach, non-adjacency, land-only
			const st = s.states[t.id];
			// Bonus stripped by the tunnel (mountain/fortify/rampart; the pair
			// isn't adjacent so there's no crossing term).
			const bypassed = defenseBonus(s, t.id, g.id);
			// With bonuses gone the fight is ~army-vs-army; want a clear edge.
			const margin = myArmies - st.armies;
			if (margin < 3) continue;
			// Prefer stripping real defenses and taking cities we otherwise
			// couldn't touch; enemy hexes over neutrals.
			let score = bypassed * 4 + margin;
			if (s.map.grids[t.id].production) score += 6;
			if (st.owner) score += 3;
			if (score > bestScore) { bestScore = score; best = { from: g.id, to: t.id }; }
		}
	}
	return best;
}

// A tunnel worth caving in with Collapse: an enemy-held tunnel that opens
// straight onto one of our hexes (they can pour through it), preferring the
// one where the enemy end most out-guns the hex it threatens.
function bestCollapseTarget(s: GameState, p: Player): { from: number; to: number } | null {
	let best: { from: number; to: number } | null = null;
	let bestScore = -Infinity;
	for (const [a, b] of s.map.tunnels ?? []) {
		const oa = s.states[a].owner, ob = s.states[b].owner;
		// One end ours, the other an enemy's — that's a live invasion route in.
		let mine = -1, foe = -1;
		if (oa === p && ob && ob !== p) { mine = a; foe = b; }
		else if (ob === p && oa && oa !== p) { mine = b; foe = a; }
		else continue;
		const threat = s.states[foe].armies - s.states[mine].armies;
		if (threat < 2) continue; // not a real threat — leave it (it's also our route out)
		if (threat > bestScore) { bestScore = threat; best = { from: a, to: b }; }
	}
	return best;
}
