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
	hasClearWaterPath,
	PLAYERS,
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
				if (s2.phase === 'attack_rolling' && s2.selectedFrom != null && s2.selectedTo != null) {
					const fromArm = s2.states[s2.selectedFrom].armies;
					const toArm = s2.states[s2.selectedTo].armies;
					if (fromArm <= toArm + 1 || fromArm < 3) { quitAttack(); break; }
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
			p2 !== 'placing' && p2 !== 'action' && p2 !== 'discard' && p2 !== 'game_over' &&
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
	if (get(game).phase !== 'placing' && get(game).phase !== 'action') {
		return;
	}

	// --- Water-invasion planning ---
	// If the only way to reach a holdout enemy is an amphibious assault, we may
	// need to hold our card for it and/or funnel armies to the launch hex first.
	// Compute the plan once up front. `staging` means we're dominant, a plan
	// exists, and its launch hex isn't yet strong enough to win the assault.
	const invasionPlan = bestInvasionPlan(get(game), p);
	const staging = invasionPlan != null && !invasionPlan.ready && isDominant(get(game), p);

	// --- Card play during placement (one per turn — highest-value wins) ---
	// If a Water Invasion is ready (or we're staging toward one), save our one
	// card for it: a territory capture — often the closing blow against a
	// water-locked opponent — outranks routine placement/defense cards. Without
	// this the AI keeps spending its card on fortify/rampart and stalls a hex
	// short of victory.
	const holdCardForInvasion =
		get(game).hands[p].includes('invasion') && invasionPlan != null && (invasionPlan.ready || staging);
	if (!holdCardForInvasion) {
		tryPlayCardPlacement(p);
		if (!synchronousAi) await wait();
	}

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
			if (s2.phase === 'attack_rolling' && s2.selectedFrom != null && s2.selectedTo != null) {
				const fromArm = s2.states[s2.selectedFrom].armies;
				const toArm = s2.states[s2.selectedTo].armies;
				if (fromArm <= toArm + 1 || fromArm < 3) {
					quitAttack();
					break;
				}
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
		if (s.phase === 'attack_rolling' && s.selectedFrom != null && s.selectedTo != null) {
			const fromArm = s.states[s.selectedFrom].armies;
			const toArm = s.states[s.selectedTo].armies;
			if (fromArm <= toArm + 1 || fromArm < 3) { quitAttack(); break; }
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

interface AttackChoice { from: number; to: number; }
function findBestAttack(s: GameState, p: Player): AttackChoice | null {
	let best: AttackChoice | null = null;
	let bestScore = -Infinity;
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
			// Neutrals are effectively free real estate; weight them so the AI
			// prefers scooping up an empty hex over grinding an enemy.
			const score = st.owner ? margin * 4 - st.armies : margin * 4 + 20;
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
	for (const g of s.map.grids) {
		const myArmies = s.states[g.id].armies;
		if (s.states[g.id].owner !== p || myArmies < 3) continue;
		for (const n of s.map.adj[g.id]) {
			const st = s.states[n];
			if (st.owner === p) continue;
			if (wallBetween(s.map, g.id, n)) continue;
			const margin = myArmies - st.armies;
			if (margin < 2) continue;

			const movedIn = Math.max(1, Math.floor(myArmies / 2));
			const hypothetical: GameState = {
				...s,
				states: s.states.map((state, id) => {
					if (id === g.id) return { owner: p, armies: myArmies - movedIn };
					if (id === n) return { owner: p, armies: movedIn };
					return state;
				})
			};
			const score = predictWinProb(hypothetical, p);
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

// Try to play one card during the placement phase. First eligible wins
// because of the one-card-per-turn rule.
function tryPlayCardPlacement(p: Player) {
	const play = (cond: () => number) => {
		const s = get(game);
		if (s.cardPlayedThisTurn) return true;
		const idx = cond();
		if (idx < 0) return false;
		playCard(idx);
		return true;
	};
	// Priority: biggest army boost first.
	let s = get(game);
	for (const kind of ['bonus15', 'bonus8', 'bonus5'] as CardType[]) {
		if (play(() => s.hands[p].findIndex((c) => c === kind))) return;
	}
	// Double if we have a decent pool.
	s = get(game);
	if (s.armiesToPlace >= 6) {
		if (play(() => s.hands[p].findIndex((c) => c === 'double'))) return;
	}
	// Reinforce: +3 armies to a border hex.
	s = get(game);
	{
		const idx = s.hands[p].findIndex((c) => c === 'reinforce');
		if (idx >= 0 && !s.cardPlayedThisTurn) {
			playCard(idx);
			const target = pickPlacementTarget(get(game), p);
			if (get(game).phase === 'reinforce_select' && target != null) selectGrid(target);
			return;
		}
	}
	// Everything else (fortify, walls, sabotage, spy, …) is action-only now:
	// non-boost cards can't be played until all reinforcements are placed
	// (see cards.ts's ACTION_ONLY) — tryPlayCardAction handles them.
}

// Try to play one card during the action phase. Elite before big attacks;
// bomb on beefy targets; deforest to clear an attack lane.
function tryPlayCardAction(p: Player) {
	let s = get(game);
	if (s.cardPlayedThisTurn) return;
	const opp = findBestAttack(s, p);
	// Elite Troops before a good attack.
	{
		const idx = s.hands[p].findIndex((c) => c === 'elite');
		if (idx >= 0 && opp) {
			playCard(idx);
			return;
		}
	}
	// Bridge before an attack that crosses a river.
	{
		const idx = s.hands[p].findIndex((c) => c === 'bridge');
		if (idx >= 0 && opp && crossesRiver(s.map, opp.from, opp.to)) {
			playCard(idx);
			return;
		}
	}
	// Mountaineering before an attack on a mountain hex.
	{
		const idx = s.hands[p].findIndex((c) => c === 'mountaineer');
		if (idx >= 0 && opp && s.map.grids[opp.to].terrain === 'mountain') {
			playCard(idx);
			return;
		}
	}
	// Paratroop a strong stack onto a weak, valuable enemy hex.
	{
		const idx = s.hands[p].findIndex((c) => c === 'paratroop');
		const plan = idx >= 0 ? bestParatroopPlan(s, p) : null;
		if (idx >= 0 && plan) {
			playCard(idx);
			if (get(game).phase === 'paratroop_from') selectGrid(plan.from);
			if (get(game).phase === 'paratroop_to') selectGrid(plan.to);
			if (get(game).phase === 'paratroop_qty') confirmParatroop(plan.qty);
			else cancelAction();
			return;
		}
	}
	// Breach a wall blocking an attack — critical when an enemy has sealed
	// itself in behind Wall cards, since that's otherwise unconquerable and
	// would deadlock the game (see findBreachTarget).
	s = get(game);
	{
		const idx = s.hands[p].findIndex((c) => c === 'breach');
		const target = findBreachTarget(s, p);
		if (idx >= 0 && target != null) {
			playCard(idx);
			if (get(game).phase === 'breach_from') selectGrid(target.from);
			if (get(game).phase === 'breach_to') selectGrid(target.to);
			return;
		}
	}
	// Bomb a beefy enemy hex on our border.
	s = get(game);
	{
		const idx = s.hands[p].findIndex((c) => c === 'bomb');
		const target = findStrongestBorderEnemy(s, p);
		if (idx >= 0 && target != null && s.states[target].armies >= 6) {
			playCard(idx);
			if (get(game).phase === 'bomb_select') selectGrid(target);
			return;
		}
	}
	// Sabotage as a fallback.
	s = get(game);
	{
		const idx = s.hands[p].findIndex((c) => c === 'sabotage');
		const target = findStrongestBorderEnemy(s, p);
		if (idx >= 0 && target != null && s.states[target].armies >= 5) {
			playCard(idx);
			if (get(game).phase === 'sabotage_select') selectGrid(target);
			return;
		}
	}
	// Deforest an adjacent enemy forest to weaken future defense.
	s = get(game);
	{
		const idx = s.hands[p].findIndex((c) => c === 'deforest');
		const target = findForestNeighbor(s, p);
		if (idx >= 0 && target != null) {
			playCard(idx);
			if (get(game).phase === 'deforest_select') selectGrid(target);
			return;
		}
	}
	// Oasis: irrigate one of our own desert hexes to remove heat attrition.
	s = get(game);
	{
		const idx = s.hands[p].findIndex((c) => c === 'oasis');
		const target = s.map.grids.findIndex(
			(g) => g.terrain === 'desert' && s.states[g.id].owner === p
		);
		if (idx >= 0 && target >= 0) {
			playCard(idx);
			if (get(game).phase === 'oasis_select') selectGrid(target);
			return;
		}
	}
	// Fortify weakest border if nothing else applies.
	s = get(game);
	{
		const idx = s.hands[p].findIndex((c) => c === 'fortify');
		const target = findWeakestBorder(s, p);
		if (idx >= 0 && target != null) {
			playCard(idx);
			if (get(game).phase === 'fortify_select') selectGrid(target);
			return;
		}
	}
	// Rampart weakest border if nothing else applies.
	s = get(game);
	{
		const idx = s.hands[p].findIndex((c) => c === 'rampart');
		const target = findWeakestBorder(s, p);
		if (idx >= 0 && target != null) {
			playCard(idx);
			if (get(game).phase === 'rampart_select') selectGrid(target);
			return;
		}
	}
	// Spy: steal from the richest hand as soon as anyone has cards to take.
	s = get(game);
	{
		const idx = s.hands[p].findIndex((c) => c === 'spy');
		const anyLoot = PLAYERS.some((q) => q !== p && s.alive[q] && s.hands[q].length > 0);
		if (idx >= 0 && anyLoot) {
			playCard(idx);
			return;
		}
	}
	// Wall off a threatening enemy edge if nothing else applies.
	s = get(game);
	{
		const idx = s.hands[p].findIndex((c) => c === 'wall');
		const target = findWallPlacement(s, p);
		if (idx >= 0 && target != null) {
			playCard(idx);
			if (get(game).phase === 'wall_from') selectGrid(target.from);
			if (get(game).phase === 'wall_to') selectGrid(target.to);
			return;
		}
	}
	// Canal: same "seal the scariest border edge" logic as Wall, but with the
	// +1 river-crossing bonus instead of a hard block (identical edge
	// constraints, so findWallPlacement's choice is always canal-legal).
	s = get(game);
	{
		const idx = s.hands[p].findIndex((c) => c === 'canal');
		const target = findWallPlacement(s, p);
		if (idx >= 0 && target != null) {
			playCard(idx);
			if (get(game).phase === 'canal_from') selectGrid(target.from);
			if (get(game).phase === 'canal_to') selectGrid(target.to);
			return;
		}
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
