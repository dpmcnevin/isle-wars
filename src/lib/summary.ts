// Post-game summary helpers: turns GameState.history + GameState.conquests +
// GameState.log into a small set of "turning point" moments for the
// post-game view, and can reconstruct map ownership at any earlier turn.
// Pure functions — call once after checkWin() sets s.winner.

import type { GameState, ConquestEvent, EdgeEvent, Player } from './game';
import { PLAYERS, PLAYER_NAMES, PLAYER_COLORS, countryCount, armyCount } from './game';

export interface TurningPoint {
	turn: number;
	/** Change in the winner's own territory count on this turn (signed). */
	delta: number;
	/** Winner's territory count as of this turn, for display. */
	territoriesAfter: number;
	/** Change in the winner's own total army count on this turn (signed) —
	 *  what actually earned this turn its spot when it was a big-battle pick
	 *  rather than a territory swing (e.g. a huge attrition fight that
	 *  didn't flip the hex). */
	armyDelta: number;
	/** Hexes that changed hands this turn where the winner was attacker or defender. */
	conquests: ConquestEvent[];
	/** Narrative line, told from the winner's perspective. */
	headline: string;
	/** True for the turn the game actually ended on — always included, shown with a star instead of a rank number. */
	isFinal: boolean;
}

/**
 * Picks the `count` turns where the eventual winner's own territory count OR
 * total army count swung the most (gains or losses) — the latter catches
 * big battles that cost (or won) a lot of armies without flipping a hex,
 * like a large failed siege. Each metric is scored relative to its own
 * largest swing in the game (so a 40-army battle isn't drowned out by
 * territory counts, which live on a much smaller scale, or vice versa).
 * Always includes the turn the game ended on (marked isFinal) even if its
 * own swing wasn't among the largest. Returns [] if the game hasn't been
 * won yet or there isn't enough turn history to compare.
 */
export function computeTurningPoints(s: GameState, count = 5): TurningPoint[] {
	if (!s.winner || s.history.length < 2) return [];
	const winner = s.winner;

	// snapshot() runs at the *start* of turn T, before that turn's actions —
	// so the delta between history[i-1] and history[i] was produced by
	// history[i-1]'s turn, not history[i]'s. Label it accordingly, or it
	// won't line up with GameState.conquests (which is tagged by the turn
	// the capture actually happened on).
	const deltas: { turn: number; delta: number; territoriesAfter: number; armyDelta: number }[] = [];
	for (let i = 1; i < s.history.length; i++) {
		const before = s.history[i - 1].territories[winner];
		const after = s.history[i].territories[winner];
		const armyBefore = s.history[i - 1].armies[winner];
		const armyAfter = s.history[i].armies[winner];
		if (after !== before || armyAfter !== armyBefore) {
			deltas.push({
				turn: s.history[i - 1].turn,
				delta: after - before,
				territoriesAfter: after,
				armyDelta: armyAfter - armyBefore
			});
		}
	}

	// The final turn (the one the game actually ended on) has no "after"
	// snapshot in history — the game stops before beginTurn() snapshots
	// again — so its own delta has to be computed against the live board.
	const finalTurn = s.turn;
	const lastSnapshot = s.history[s.history.length - 1];
	const finalTerritories = countryCount(s, winner);
	const finalArmies = armyCount(s, winner);
	const finalEntry = {
		turn: finalTurn,
		delta: finalTerritories - lastSnapshot.territories[winner],
		territoriesAfter: finalTerritories,
		armyDelta: finalArmies - lastSnapshot.armies[winner]
	};

	const withoutFinal = deltas.filter((t) => t.turn !== finalTurn);
	const maxTerrSwing = Math.max(1, ...withoutFinal.map((t) => Math.abs(t.delta)));
	const maxArmySwing = Math.max(1, ...withoutFinal.map((t) => Math.abs(t.armyDelta)));
	const score = (t: { delta: number; armyDelta: number }) =>
		Math.max(Math.abs(t.delta) / maxTerrSwing, Math.abs(t.armyDelta) / maxArmySwing);

	const top = [...withoutFinal].sort((a, b) => score(b) - score(a)).slice(0, Math.max(0, count - 1));
	const topTurns = new Set(top.map((t) => t.turn));

	const chosen = withoutFinal.filter((t) => topTurns.has(t.turn)).sort((a, b) => a.turn - b.turn);
	chosen.push(finalEntry);

	return chosen.map(({ turn, delta, territoriesAfter, armyDelta }) => {
		const conquests = s.conquests.filter(
			(c) => c.turn === turn && (c.attacker === winner || c.defender === winner)
		);
		return {
			turn,
			delta,
			territoriesAfter,
			armyDelta,
			conquests,
			headline: describeForWinner(conquests, winner, armyDelta),
			isFinal: turn === finalTurn
		};
	});
}

function describeForWinner(conquests: ConquestEvent[], winner: Player, armyDelta: number): string {
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
	if (parts.length === 0) {
		// No hex changed hands — this turn only made the cut because of a big
		// army-count swing (a large battle that didn't flip the hex, or a
		// card/event that moved a lot of armies at once).
		if (armyDelta > 0) return `${PLAYER_NAMES[winner]}'s armies increased by ${armyDelta}.`;
		if (armyDelta < 0) return `${PLAYER_NAMES[winner]}'s armies decreased by ${-armyDelta}.`;
		return `${PLAYER_NAMES[winner]}'s territory count shifted.`;
	}
	return `${parts.join(', ')}.`;
}

// Both reconstruct* functions only ever touch these specific fields — kept
// as minimal structural types (rather than the full GameState) so the
// shareable recap page (which has no map/hex-state, only a trimmed replay
// log) can call them with a lightweight stand-in object instead of a real
// GameState. A real GameState satisfies both shapes as-is.
export interface OwnerReplayState {
	states: { owner: Player | null }[];
	conquests: ConquestEvent[];
}
export interface EdgeReplayState {
	map: { walls?: [number, number][]; seaLanes: [number, number][] };
	edgeEvents?: EdgeEvent[];
}

/**
 * Reconstructs hex ownership as of the end of `turn` by starting from the
 * final GameState.states and undoing every conquest that happened after
 * that turn, in reverse chronological order. There's no per-turn ownership
 * snapshot stored during play, so this replay is the only way to answer
 * "what did the map look like back then" — it only recovers ownership
 * (not army counts), which is all a turning-point map overlay needs.
 */
export function reconstructOwnersAtTurn(s: OwnerReplayState, turn: number): (Player | null)[] {
	const owners = s.states.map((st) => st.owner);
	for (let i = s.conquests.length - 1; i >= 0; i--) {
		const c = s.conquests[i];
		if (c.turn > turn) owners[c.grid] = c.defender;
	}
	return owners;
}

/**
 * Reconstructs which wall/sea-lane edges existed as of the end of `turn` by
 * starting from the final map.walls/seaLanes and undoing every edgeEvent
 * that happened after that turn, in reverse chronological order — same
 * approach as reconstructOwnersAtTurn, just for edges instead of hexes.
 * Walls built (or lanes opened) after `turn` are removed from the result;
 * walls/lanes torn down after `turn` are added back in.
 */
export function reconstructEdgesAtTurn(
	s: EdgeReplayState,
	turn: number
): { walls: [number, number][]; seaLanes: [number, number][] } {
	// Sort endpoints — map.seaLanes stores lanes in whatever from/to order the
	// player picked (cards.ts pushes [from, to] as-is), but edgeEvents.edge
	// is always normalized to sorted order (see pushEdgeEvent in game.ts).
	// Without sorting here too, e.g. a stored [39, 18] and its event's
	// [18, 39] hash to different keys, so the "remove this lane before its
	// turn" lookup below silently misses and the lane leaks into every
	// earlier turning-point map regardless of when it actually opened.
	const edgeKey = ([a, b]: [number, number]) => (a < b ? `${a},${b}` : `${b},${a}`);
	const walls = new Map((s.map.walls ?? []).map((e) => [edgeKey(e), e]));
	const seaLanes = new Map(s.map.seaLanes.map((e) => [edgeKey(e), e]));
	const events = s.edgeEvents ?? [];
	for (let i = events.length - 1; i >= 0; i--) {
		const ev = events[i];
		if (ev.turn <= turn) continue;
		const target = ev.kind === 'wall' ? walls : seaLanes;
		const key = edgeKey(ev.edge);
		if (ev.added) target.delete(key); // built/opened after `turn` — wasn't there yet
		else target.set(key, ev.edge); // torn down after `turn` — was still there
	}
	return { walls: [...walls.values()], seaLanes: [...seaLanes.values()] };
}

/**
 * Splits a turning-point headline like "Green captured 3 hexes, lost 2 hexes
 * to Red." on player names so a UI can color each mention inline. Lives here
 * (rather than in the UI) because it's the counterpart to describeForWinner
 * above — anywhere a headline string is displayed needs the same split.
 */
export function headlineParts(text: string): { text: string; color?: string }[] {
	const re = new RegExp(`(${PLAYERS.map((p) => PLAYER_NAMES[p]).join('|')})`, 'g');
	const parts: { text: string; color?: string }[] = [];
	let lastIndex = 0;
	for (const m of text.matchAll(re)) {
		if (m.index! > lastIndex) parts.push({ text: text.slice(lastIndex, m.index) });
		const player = PLAYERS.find((p) => PLAYER_NAMES[p] === m[0]);
		parts.push({ text: m[0], color: player ? PLAYER_COLORS[player] : undefined });
		lastIndex = m.index! + m[0].length;
	}
	if (lastIndex < text.length) parts.push({ text: text.slice(lastIndex) });
	return parts;
}
