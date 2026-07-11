// Lifetime (cross-game) stats for the local player, persisted in
// localStorage. Web-only: nothing in the core engine depends on this —
// the page records a finished game once (guarded by GameState.lifetimeRecorded
// so a reloaded finished save doesn't double-count) and renders the totals
// in a modal.
import type { GameState, Player } from './game';

export interface LifetimeStats {
	gamesPlayed: number;
	wins: number;
	currentStreak: number; // consecutive wins; resets on a loss
	bestStreak: number;
	totalTurns: number; // sum of final turn counts, for avg game length
	fastestWinTurns: number | null;
	attacksWon: number;
	attacksLost: number;
	territoriesCaptured: number;
	territoriesLost: number;
	cardsDrawn: number;
	cardsPlayed: number;
	armiesLostToEvents: number;
}

const KEY = 'isle-wars-lifetime-v1';

export function emptyLifetimeStats(): LifetimeStats {
	return {
		gamesPlayed: 0,
		wins: 0,
		currentStreak: 0,
		bestStreak: 0,
		totalTurns: 0,
		fastestWinTurns: null,
		attacksWon: 0,
		attacksLost: 0,
		territoriesCaptured: 0,
		territoriesLost: 0,
		cardsDrawn: 0,
		cardsPlayed: 0,
		armiesLostToEvents: 0
	};
}

export function loadLifetimeStats(): LifetimeStats {
	if (typeof window === 'undefined') return emptyLifetimeStats();
	try {
		const raw = localStorage.getItem(KEY);
		if (!raw) return emptyLifetimeStats();
		// Spread over the empty shape so fields added in later versions
		// default sanely when reading an older payload.
		return { ...emptyLifetimeStats(), ...(JSON.parse(raw) as Partial<LifetimeStats>) };
	} catch {
		return emptyLifetimeStats();
	}
}

function save(stats: LifetimeStats) {
	if (typeof window === 'undefined') return;
	try {
		localStorage.setItem(KEY, JSON.stringify(stats));
	} catch { /* quota / privacy mode */ }
}

/** Folds a finished game into the lifetime totals and persists them.
 *  Returns the updated stats. The caller is responsible for calling this
 *  exactly once per game (see GameState.lifetimeRecorded). */
export function recordFinishedGame(s: GameState, human: Player): LifetimeStats {
	const stats = loadLifetimeStats();
	const ps = s.stats[human];
	const won = s.winner === human;
	stats.gamesPlayed += 1;
	stats.totalTurns += s.turn;
	if (won) {
		stats.wins += 1;
		stats.currentStreak += 1;
		stats.bestStreak = Math.max(stats.bestStreak, stats.currentStreak);
		if (stats.fastestWinTurns == null || s.turn < stats.fastestWinTurns) {
			stats.fastestWinTurns = s.turn;
		}
	} else {
		stats.currentStreak = 0;
	}
	stats.attacksWon += ps.attacksWon;
	stats.attacksLost += ps.attacksLost;
	stats.territoriesCaptured += ps.territoriesCaptured;
	stats.territoriesLost += ps.territoriesLost;
	stats.cardsDrawn += ps.cardsDrawn;
	stats.cardsPlayed += ps.cardsPlayed;
	stats.armiesLostToEvents += ps.armiesLostToEvents;
	save(stats);
	return stats;
}

export function resetLifetimeStats(): LifetimeStats {
	const stats = emptyLifetimeStats();
	save(stats);
	return stats;
}
