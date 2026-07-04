// Bridge entry point for the JavaScriptCore-hosted game engine used by the
// native iPad app. Bundled with esbuild into game-bundle.js; not part of the
// SvelteKit web build. Imports the existing web game logic unmodified and
// exposes a flat, JSON-in/JSON-out API on `globalThis.IsleWars`.

import {
	game,
	newGame,
	loadSavedGame,
	clearSavedGame,
	getDebugSettings,
	updateDebugSettings,
	placeArmies,
	beginAttack,
	beginMove,
	cancelAction,
	selectGrid,
	endTurn,
	discardCard,
	rollAttack,
	quitAttack,
	confirmMoveInAfterConquest,
	confirmMove,
	confirmAir,
	playCard,
	startGamePlaying,
	forceEndTurn,
	winProbability,
	defenseBonus,
	attackerBonus,
	crossingDefenseBonus,
	hasClearWaterPath,
	canFerryConnect,
	canInvasionConnect,
	canArtilleryTarget,
	countryCount,
	fullIslandBonus,
	type GameState,
	type Player
} from '../../src/lib/game';
import { runAiTurn } from '../../src/lib/ai';

let latestState: GameState;
game.subscribe((s) => {
	latestState = s;
});

function withState<Args extends unknown[]>(fn: (...args: Args) => void) {
	return (...args: Args) => {
		fn(...args);
		return JSON.stringify(latestState);
	};
}

(globalThis as any).IsleWars = {
	getState: () => JSON.stringify(latestState),

	startGame: (difficulty: number, startingArmies: number, seed?: number) => {
		newGame(difficulty, startingArmies, seed);
		return JSON.stringify(latestState);
	},
	loadSavedGame: () => {
		const ok = loadSavedGame();
		return JSON.stringify({ ok, state: latestState });
	},
	clearSavedGame: withState(clearSavedGame),
	// Swift owns persistence (JSC has no localStorage), so this hydrates the
	// JS game store directly from a Swift-provided JSON blob rather than
	// going through the web app's localStorage-based save/load.
	loadState: (json: string) => {
		const parsed = JSON.parse(json) as GameState;
		game.set(parsed);
		return JSON.stringify(latestState);
	},
	getDebugSettings: () => JSON.stringify(getDebugSettings()),
	updateDebugSettings: (patchJson: string) => {
		updateDebugSettings(JSON.parse(patchJson));
		return JSON.stringify(getDebugSettings());
	},

	placeArmies: withState(placeArmies),
	beginAttack: withState(beginAttack),
	beginMove: withState(beginMove),
	cancelAction: withState(cancelAction),
	selectGrid: withState(selectGrid),
	endTurn: withState(endTurn),
	discardCard: withState(discardCard),
	rollAttack: withState(rollAttack),
	quitAttack: withState(quitAttack),
	confirmMoveInAfterConquest: withState(confirmMoveInAfterConquest),
	confirmMove: withState(confirmMove),
	confirmAir: withState(confirmAir),
	playCard: withState(playCard),
	startGamePlaying: withState(startGamePlaying),
	forceEndTurn: withState(forceEndTurn),

	winProbability: (atkArmies: number, defArmies: number, defenderBonus = 0, attackerBonusVal = 0) =>
		winProbability(atkArmies, defArmies, defenderBonus, attackerBonusVal),
	defenseBonus: (gridId: number, fromId?: number) => defenseBonus(latestState, gridId, fromId),
	attackerBonus: (gridId: number) => attackerBonus(latestState, gridId),
	crossingDefenseBonus: (fromId: number, toId: number) => crossingDefenseBonus(latestState, fromId, toId),
	hasClearWaterPath: (fromId: number, toId: number) => hasClearWaterPath(latestState, fromId, toId),
	canFerryConnect: (fromId: number, toId: number) => canFerryConnect(latestState, fromId, toId),
	canInvasionConnect: (fromId: number, toId: number) => canInvasionConnect(latestState, fromId, toId),
	canArtilleryTarget: (fromId: number, toId: number) => canArtilleryTarget(latestState, fromId, toId),
	countryCount: (player: Player) => countryCount(latestState, player),
	fullIslandBonus: (player: Player) => fullIslandBonus(latestState, player),

	// Fire-and-forget: `runAiTurn` is async purely for cosmetic pacing. The
	// host installs a synchronous setTimeout shim, so by the time this
	// evaluateScript call returns to Swift, the microtask queue has already
	// drained and the whole AI turn (including all state mutation) has run
	// to completion. Swift reads the result via a separate getState() call
	// rather than relying on this function's own return value.
	runAiTurn: (player: Player) => {
		void runAiTurn(player, 0);
	}
};
