// Post-game summary helpers: turns GameState.history + GameState.conquests +
// GameState.log into a small set of "turning point" moments for the
// post-game view, and can reconstruct map ownership at any earlier turn.
// Pure functions — call once after checkWin() sets s.winner.

import type { GameState, ConquestEvent, Player } from './game';
import { PLAYER_NAMES, countryCount } from './game';

export interface TurningPoint {
	turn: number;
	/** Change in the winner's own territory count on this turn (signed). */
	delta: number;
	/** Winner's territory count as of this turn, for display. */
	territoriesAfter: number;
	/** Hexes that changed hands this turn where the winner was attacker or defender. */
	conquests: ConquestEvent[];
	/** Narrative line, told from the winner's perspective. */
	headline: string;
	/** True for the turn the game actually ended on — always included, shown with a star instead of a rank number. */
	isFinal: boolean;
}

/**
 * Picks the `count` turns where the eventual winner's own territory count
 * swung the most (gains or losses), skipping turns where the winner's
 * count didn't change at all, and always includes the turn the game ended
 * on (marked isFinal) even if its own swing wasn't among the largest.
 * Returns [] if the game hasn't been won yet or there isn't enough turn
 * history to compare.
 */
export function computeTurningPoints(s: GameState, count = 5): TurningPoint[] {
	if (!s.winner || s.history.length < 2) return [];
	const winner = s.winner;

	// snapshot() runs at the *start* of turn T, before that turn's actions —
	// so the delta between history[i-1] and history[i] was produced by
	// history[i-1]'s turn, not history[i]'s. Label it accordingly, or it
	// won't line up with GameState.conquests (which is tagged by the turn
	// the capture actually happened on).
	const deltas: { turn: number; delta: number; territoriesAfter: number }[] = [];
	for (let i = 1; i < s.history.length; i++) {
		const before = s.history[i - 1].territories[winner];
		const after = s.history[i].territories[winner];
		if (after !== before) {
			deltas.push({ turn: s.history[i - 1].turn, delta: after - before, territoriesAfter: after });
		}
	}

	// The final turn (the one the game actually ended on) has no "after"
	// snapshot in history — the game stops before beginTurn() snapshots
	// again — so its own delta has to be computed against the live board.
	const finalTurn = s.turn;
	const lastSnapshotTerritories = s.history[s.history.length - 1].territories[winner];
	const finalTerritories = countryCount(s, winner);
	const finalEntry = {
		turn: finalTurn,
		delta: finalTerritories - lastSnapshotTerritories,
		territoriesAfter: finalTerritories
	};

	const withoutFinal = deltas.filter((t) => t.turn !== finalTurn);
	const top = [...withoutFinal].sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta)).slice(0, Math.max(0, count - 1));
	const topTurns = new Set(top.map((t) => t.turn));

	const chosen = withoutFinal.filter((t) => topTurns.has(t.turn)).sort((a, b) => a.turn - b.turn);
	chosen.push(finalEntry);

	return chosen.map(({ turn, delta, territoriesAfter }) => {
		const conquests = s.conquests.filter(
			(c) => c.turn === turn && (c.attacker === winner || c.defender === winner)
		);
		return {
			turn,
			delta,
			territoriesAfter,
			conquests,
			headline: describeForWinner(conquests, winner),
			isFinal: turn === finalTurn
		};
	});
}

function describeForWinner(conquests: ConquestEvent[], winner: Player): string {
	const gains = conquests.filter((c) => c.attacker === winner);
	const losses = conquests.filter((c) => c.defender === winner);
	const parts: string[] = [];
	if (gains.length) {
		parts.push(`${PLAYER_NAMES[winner]} captured ${gains.length} ${gains.length === 1 ? 'hex' : 'hexes'}`);
	}
	if (losses.length) {
		const takers = [...new Set(losses.map((c) => c.attacker))].map((p) => PLAYER_NAMES[p]);
		parts.push(`lost ${losses.length} ${losses.length === 1 ? 'hex' : 'hexes'} to ${takers.join(', ')}`);
	}
	if (parts.length === 0) return `${PLAYER_NAMES[winner]}'s territory count shifted.`;
	return `${parts.join(', ')}.`;
}

/**
 * Reconstructs hex ownership as of the end of `turn` by starting from the
 * final GameState.states and undoing every conquest that happened after
 * that turn, in reverse chronological order. There's no per-turn ownership
 * snapshot stored during play, so this replay is the only way to answer
 * "what did the map look like back then" — it only recovers ownership
 * (not army counts), which is all a turning-point map overlay needs.
 */
export function reconstructOwnersAtTurn(s: GameState, turn: number): (Player | null)[] {
	const owners = s.states.map((st) => st.owner);
	for (let i = s.conquests.length - 1; i >= 0; i--) {
		const c = s.conquests[i];
		if (c.turn > turn) owners[c.grid] = c.defender;
	}
	return owners;
}
