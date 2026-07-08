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
	confirmParatroop,
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
	selectableHexes,
	cardCatalog,
	armyCount,
	PLAYERS,
	type GameState,
	type Player,
	type CardType
} from '../../src/lib/game';
import { canPlayCardNow } from '../../src/lib/cards';
import { computeTurningPoints, reconstructOwnersAtTurn, reconstructEdgesAtTurn } from '../../src/lib/summary';
import { buildRecap } from '../../src/lib/recap';
import { runAiTurn, setAiSynchronous, setValueNetPlayers } from '../../src/lib/ai';

// The iOS JSContext has no real event loop, so cosmetic `await` pauses in the
// AI turn can suspend and never resume (freezing the AI mid-turn). Run the AI
// fully synchronously here — Swift owns all pacing/animation natively.
setAiSynchronous(true);

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

	startGame: (difficulty: number, startingArmies: number, seed?: string) => {
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
	confirmParatroop: withState(confirmParatroop),
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

	// Tier 3 additions: let Swift drive card display and hex-selection
	// highlighting straight from the engine instead of re-declaring the rules.
	selectableHexes: () => JSON.stringify(selectableHexes(latestState)),
	cardCatalog: () => JSON.stringify(cardCatalog()),
	canPlayCardNow: (card: CardType) => canPlayCardNow(latestState, card),

	// Post-game recap: turning points + a share-link payload. `buildRecapJSON`
	// returns plain (uncompressed) JSON — Swift base64url-encodes it itself
	// with the 'r' (raw) format tag encodeRecap also uses, so a link built on
	// iOS still decodes on the web /recap page. Skipping the web's gzip path
	// entirely sidesteps CompressionStream, which JavaScriptCore doesn't have.
	computeTurningPoints: (count: number) => JSON.stringify(computeTurningPoints(latestState, count)),
	reconstructOwnersAtTurn: (turn: number) => JSON.stringify(reconstructOwnersAtTurn(latestState, turn)),
	reconstructEdgesAtTurn: (turn: number) => JSON.stringify(reconstructEdgesAtTurn(latestState, turn)),
	buildRecapJSON: () => {
		if (!latestState.winner) return null;
		const s = latestState;
		const recap = buildRecap({
			seed: s.seed,
			winner: s.winner,
			turn: s.turn,
			turningPoints: computeTurningPoints(s, 15),
			history: s.history,
			stats: s.stats,
			finalArmies: Object.fromEntries(PLAYERS.map((p) => [p, armyCount(s, p)])) as Record<Player, number>,
			finalOwners: s.states.map((st) => st.owner),
			conquests: s.conquests,
			edgeEvents: s.edgeEvents,
			hexArmyDeltas: s.hexArmyDeltas,
			finalWalls: s.map.walls ?? [],
			finalSeaLanes: s.map.seaLanes,
			terrainEvents: s.terrainEvents ?? []
		});
		return JSON.stringify(recap);
	},

	// Fire-and-forget: `runAiTurn` is async purely for cosmetic pacing. The
	// host installs a synchronous setTimeout shim, so by the time this
	// evaluateScript call returns to Swift, the microtask queue has already
	// drained and the whole AI turn (including all state mutation) has run
	// to completion. Swift reads the result via a separate getState() call
	// rather than relying on this function's own return value.
	runAiTurn: (player: Player) => {
		void runAiTurn(player, 0);
	},

	// Lets a headless sim (or, later, a Swift debug toggle) put a subset of
	// players on the trained value-network attack evaluator instead of the
	// hand-tuned heuristic, so the two policies can be pitted against each
	// other within the same game. `players` is a JSON array of player names.
	setValueNetPlayers: (playersJson: string) => {
		setValueNetPlayers(JSON.parse(playersJson));
	}
};
