import { get } from 'svelte/store';
import {
	game,
	placeArmies,
	beginAttack,
	selectGrid,
	rollAttack,
	quitAttack,
	cancelAction,
	confirmMoveInAfterConquest,
	discardCard,
	endTurn,
	forceEndTurn,
	playCard,
	type Player,
	type CardType,
	type GameState
} from './game';
import { crossesRiver } from './map';

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
			while (get(game).phase === 'attack_rolling' && rolls++ < 500) {
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
		const p2 = get(game).phase;
		if (
			p2 === 'attack_select_from' || p2 === 'attack_select_to' ||
			p2 === 'move_select_from' || p2 === 'move_select_to' || p2 === 'move_qty' ||
			p2 === 'bomb_select' || p2 === 'air_from' || p2 === 'air_to' || p2 === 'air_qty' ||
			p2 === 'reinforce_select' || p2 === 'sabotage_select' || p2 === 'fortify_select' ||
			p2 === 'ferry_from' || p2 === 'ferry_to' || p2 === 'invasion_from' || p2 === 'invasion_to' ||
			p2 === 'deforest_select' || p2 === 'oasis_select' || p2 === 'storm_from' || p2 === 'storm_to'
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

	// --- Card play during placement (one per turn — highest-value wins) ---
	tryPlayCardPlacement(p);
	await wait();

	// --- Placement ---
	while (get(game).phase === 'placing' && get(game).current === p) {
		const s = get(game);
		const target = pickPlacementTarget(s, p);
		if (target == null) break;
		// Place all remaining on best target (simple but decisive)
		placeArmies(target, s.armiesToPlace);
		await wait();
	}

	// --- Attack loop ---
	let attackAttempts = 0;
	while (get(game).phase === 'action' && get(game).current === p && attackAttempts < 20) {
		const s = get(game);
		const opp = findBestAttack(s, p);
		if (!opp) break;
		beginAttack();
		selectGrid(opp.from);
		if (get(game).phase !== 'attack_select_to') {
			// Source selection didn't take — bail out cleanly rather than hang.
			cancelAction();
			break;
		}
		selectGrid(opp.to);
		if (get(game).phase !== 'attack_rolling') {
			// Target selection failed — bail cleanly.
			cancelAction();
			break;
		}
		// Roll until conquer, forfeit, or advantage lost. Roll without waiting
		// inside a single attack — otherwise a 100-vs-50 fight can take a
		// minute of wall-clock time. High cap so the fight actually resolves.
		let rolls = 0;
		while (get(game).phase === 'attack_rolling' && rolls++ < 500) {
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
		await wait();
	}

	// --- Card play during action phase (bomb, elite, etc.) if we didn't
	// already spend our card on placement.
	tryPlayCardAction(p);
	await wait();

	// --- End turn. If we're stuck in a mid-action phase, cancel back to
	// action first. If we still can't reach action, force-advance the turn. ---
	if (get(game).current === p && get(game).phase !== 'action' && get(game).phase !== 'placing') {
		cancelAction();
	}
	if (get(game).phase === 'action' && get(game).current === p) {
		endTurn();
	} else if (get(game).current === p && get(game).phase !== 'game_over' && get(game).phase !== 'placing') {
		forceEndTurn();
	}
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
			if (!st.owner || st.owner === p) continue;
			const margin = myArmies - st.armies;
			if (margin < 2) continue;
			const score = margin * 4 - st.armies;
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
	// Fortify weakest border.
	s = get(game);
	{
		const idx = s.hands[p].findIndex((c) => c === 'fortify');
		const target = findWeakestBorder(s, p);
		if (idx >= 0 && target != null && !s.cardPlayedThisTurn) {
			playCard(idx);
			if (get(game).phase === 'fortify_select') selectGrid(target);
			return;
		}
	}
	// Sabotage a big enemy hex.
	s = get(game);
	{
		const idx = s.hands[p].findIndex((c) => c === 'sabotage');
		const target = findStrongestBorderEnemy(s, p);
		if (idx >= 0 && target != null && s.states[target].armies >= 5 && !s.cardPlayedThisTurn) {
			playCard(idx);
			if (get(game).phase === 'sabotage_select') selectGrid(target);
			return;
		}
	}
	// Deforest an adjacent enemy forest.
	s = get(game);
	{
		const idx = s.hands[p].findIndex((c) => c === 'deforest');
		const target = findForestNeighbor(s, p);
		if (idx >= 0 && target != null && !s.cardPlayedThisTurn) {
			playCard(idx);
			if (get(game).phase === 'deforest_select') selectGrid(target);
			return;
		}
	}
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
}
