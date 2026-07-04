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
	endTurn,
	playCard,
	type Player,
	type CardType,
	type GameState
} from './game';

/**
 * Run one full turn for an AI player. Assumes current player === p and
 * we are at the top of the turn (phase = 'placing'). Returns nothing.
 */
export async function runAiTurn(p: Player, tickMs = 90) {
	const wait = () => new Promise((r) => setTimeout(r, tickMs));

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
			p2 === 'bomb_select' || p2 === 'air_from' || p2 === 'air_to' || p2 === 'air_qty'
		) {
			cancelAction();
		}
	}
	// If somehow we can't recover, end the turn to unstick.
	if (get(game).phase !== 'placing' && get(game).phase !== 'action') {
		return;
	}

	// --- Optional card plays during placement phase ---
	tryPlayBonusCards();
	tryPlayDouble();
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
		selectGrid(opp.to);
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

	// --- Play a bomb card opportunistically ---
	tryPlayBomb(p);
	await wait();

	// --- End turn (skip move to keep AI simple) ---
	if (get(game).phase === 'action' && get(game).current === p) {
		endTurn();
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

function tryPlayBonusCards() {
	let s = get(game);
	// play all bonus cards
	for (;;) {
		s = get(game);
		const idx = s.hands[s.current].findIndex((c) => c === 'bonus5' || c === 'bonus8' || c === 'bonus15');
		if (idx < 0) break;
		playCard(idx);
	}
}

function tryPlayDouble() {
	const s = get(game);
	// Play only if placement pool is decent
	if (s.armiesToPlace >= 5) {
		const idx = s.hands[s.current].findIndex((c) => c === 'double');
		if (idx >= 0) playCard(idx);
	}
}

function tryPlayBomb(p: Player) {
	const s = get(game);
	const idx = s.hands[p].findIndex((c) => c === 'bomb');
	if (idx < 0) return;
	// pick fattest enemy grid on our border
	let best = -1;
	let bestArm = 0;
	for (const g of s.map.grids) {
		if (s.states[g.id].owner === p || !s.states[g.id].owner) continue;
		const borders = s.map.adj[g.id].some((n) => s.states[n].owner === p);
		if (!borders) continue;
		if (s.states[g.id].armies > bestArm) { bestArm = s.states[g.id].armies; best = g.id; }
	}
	if (best < 0 || bestArm < 8) return; // only worth it on beefy targets
	playCard(idx);
	if (get(game).phase === 'bomb_select') selectGrid(best);
}
