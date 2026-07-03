import { writable, derived, get } from 'svelte/store';
import { generateMap, type GameMap } from './map';

export type Player = 'blue' | 'green' | 'red' | 'brown';
export const PLAYERS: Player[] = ['blue', 'green', 'red', 'brown'];
export const PLAYER_COLORS: Record<Player, string> = {
	blue: '#3a7fd5',
	green: '#3ac055',
	red: '#d44',
	brown: '#a06a3a'
};
export const PLAYER_NAMES: Record<Player, string> = {
	blue: 'Blue',
	green: 'Green',
	red: 'Red',
	brown: 'Brown'
};

export type CardType =
	| 'air'
	| 'bonus5'
	| 'bonus8'
	| 'bonus15'
	| 'double'
	| 'bomb'
	| 'antibomb'
	| 'wild'
	| 'reinforce'
	| 'elite'
	| 'sabotage'
	| 'fortify'
	| 'ferry'
	| 'invasion';

export const CARD_LABELS: Record<CardType, string> = {
	air: 'Air Move',
	bonus5: '+5 Armies',
	bonus8: '+8 Armies',
	bonus15: '+15 Armies',
	double: 'Double',
	bomb: 'Bomb',
	antibomb: 'Anti-Bomb',
	wild: 'Wild',
	reinforce: 'Reinforce (+3)',
	elite: 'Elite Troops',
	sabotage: 'Sabotage',
	fortify: 'Fortify',
	ferry: 'Ferry Route',
	invasion: 'Water Invasion'
};

// Weighted card draw pool
const CARD_POOL: CardType[] = [
	'air', 'air',
	'bonus5', 'bonus5', 'bonus5',
	'bonus8', 'bonus8',
	'bonus15',
	'double', 'double',
	'bomb', 'bomb',
	'antibomb', 'antibomb',
	'wild',
	'reinforce', 'reinforce',
	'elite', 'elite',
	'sabotage',
	'fortify',
	'ferry',
	'invasion'
];

export type Phase =
	| 'placing'
	| 'action'
	| 'attack_select_from'
	| 'attack_select_to'
	| 'attack_rolling'
	| 'attack_move_in' // after conquering, how many to move in
	| 'move_select_from'
	| 'move_select_to'
	| 'move_qty'
	| 'bomb_select'
	| 'air_from'
	| 'air_to'
	| 'air_qty'
	| 'reinforce_select'
	| 'sabotage_select'
	| 'fortify_select'
	| 'ferry_from'
	| 'ferry_to'
	| 'invasion_from'
	| 'invasion_to'
	| 'discard'
	| 'game_over';

export interface GridState {
	owner: Player | null;
	armies: number;
	fortified?: boolean; // +2 defense from a Fortify card (persists until conquered)
}

export interface LogEntry {
	turn: number;
	player: Player | null;
	text: string;
	kind?: 'info' | 'attack' | 'event' | 'card' | 'defeat';
}

export interface GameState {
	map: GameMap;
	seed: number;
	difficulty: number; // 1..4
	states: GridState[]; // indexed by grid id
	hands: Record<Player, CardType[]>;
	alive: Record<Player, boolean>;
	current: Player;
	turn: number;
	phase: Phase;
	// Placement state
	armiesToPlace: number;
	doubleActive: boolean; // "Double" card just played, awaiting placement
	// Selection scratch
	selectedFrom: number | null;
	selectedTo: number | null;
	pendingArmies: number; // for move / air-move / place qty
	// Flags
	defeatedThisTurn: boolean;
	turnCardAwarded: boolean;
	// 'win' if the last attack ended in conquest; 'loss' if attacker was
	// reduced to 1 or the player quit-attacked; null if no attack yet.
	lastAttackResult: 'win' | 'loss' | null;
	// Pending draws waiting for the player to choose a discard (hand > HAND_MAX).
	pendingDiscard: boolean;
	// Elite Troops card active — attacker rolls get +2 for the next attack sequence.
	eliteAttackActive: boolean;
	// Water Invasion card added a temporary sea lane for this attack. If the
	// attack succeeds it stays; if it fails, it's removed.
	pendingInvasionLane: [number, number] | null;
	// Log
	log: LogEntry[];
	// UI hints
	message: string;
	// End
	winner: Player | null;
	// Analytics
	history: TurnSnapshot[];
	stats: Record<Player, PlayerStats>;
}

export interface TurnSnapshot {
	turn: number;
	territories: Record<Player, number>;
	armies: Record<Player, number>;
	islands: Record<Player, number>; // full-island count
}

export interface PlayerStats {
	attacksWon: number;
	attacksLost: number;
	territoriesCaptured: number;
	territoriesLost: number;
	cardsDrawn: number;
	cardsPlayed: number;
	armiesLostToEvents: number;
}

function emptyStats(): PlayerStats {
	return {
		attacksWon: 0,
		attacksLost: 0,
		territoriesCaptured: 0,
		territoriesLost: 0,
		cardsDrawn: 0,
		cardsPlayed: 0,
		armiesLostToEvents: 0
	};
}

function emptyStatsMap(): Record<Player, PlayerStats> {
	return { blue: emptyStats(), green: emptyStats(), red: emptyStats(), brown: emptyStats() };
}

export const SAVE_KEY = 'isle-wars-save-v7';

export const game = writable<GameState>(startGame(1, 3));

let persistenceInitialized = false;

/**
 * On first call: try to load a saved game, then start persisting future updates
 * to localStorage. Auto-save is intentionally deferred until AFTER the load
 * attempt — otherwise the fresh initial state would clobber the save before
 * we get a chance to read it. Safe to call multiple times.
 */
export function loadSavedGame(): boolean {
	if (typeof window === 'undefined') return false;
	if (persistenceInitialized) return false;
	let loaded = false;
	try {
		const raw = localStorage.getItem(SAVE_KEY);
		if (raw) {
			const parsed = JSON.parse(raw) as GameState;
			if (parsed && parsed.map && Array.isArray(parsed.map.grids)) {
				game.set(parsed);
				loaded = true;
			}
		}
	} catch { /* corrupt / privacy mode */ }
	// Start auto-saving from here on.
	persistenceInitialized = true;
	game.subscribe((s) => {
		try {
			localStorage.setItem(SAVE_KEY, JSON.stringify(s));
		} catch { /* quota / privacy mode */ }
	});
	return loaded;
}

/**
 * Compute probability the attacker eventually conquers the defender's grid,
 * given `atkArmies` on the source and `defArmies` on the target. Uses the
 * single-die tie-goes-to-defender mechanic. Forfeit at attacker=1.
 *
 * `defenderBonus` is added to the defender's die (e.g. +1 for a mountain hex).
 *
 * Solved as a memoized Markov chain.
 */
const WIN_PROB_CACHE = new Map<string, number>();
function perRollAttackerWin(netModifier: number): number {
	// Net = attackerBonus − defenderBonus. Count (atk, def) pairs where
	// atk + net > def (defender wins ties, as usual).
	let wins = 0;
	for (let atk = 1; atk <= 6; atk++) {
		for (let def = 1; def <= 6; def++) {
			if (atk + netModifier > def) wins++;
		}
	}
	return wins / 36;
}
export function winProbability(atkArmies: number, defArmies: number, defenderBonus = 0, attackerBonus = 0): number {
	if (atkArmies < 2) return 0;
	if (defArmies <= 0) return 1;
	const net = attackerBonus - defenderBonus;
	const key = `${atkArmies},${defArmies},${net}`;
	const hit = WIN_PROB_CACHE.get(key);
	if (hit != null) return hit;
	const p = perRollAttackerWin(net);
	const q = 1 - p;
	const res =
		p * winProbability(atkArmies, defArmies - 1, defenderBonus, attackerBonus) +
		q * winProbability(atkArmies - 1, defArmies, defenderBonus, attackerBonus);
	WIN_PROB_CACHE.set(key, res);
	return res;
}

/** Defense bonus for a hex: mountain terrain (+1) + fortification (+2). */
export function defenseBonus(s: GameState, gridId: number): number {
	let b = 0;
	if (s.map.grids[gridId].terrain === 'mountain') b += 1;
	if (s.states[gridId].fortified) b += 2;
	return b;
}

/** Attacker bonus for a hex being attacked: forest terrain gives attacker
 * cover (+1). Does not include the Elite Troops card — that's applied
 * separately in the roll. */
export function attackerBonus(s: GameState, gridId: number): number {
	return s.map.grids[gridId].terrain === 'forest' ? 1 : 0;
}

function pointInPoly(px: number, py: number, poly: [number, number][]): boolean {
	let inside = false;
	for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
		const xi = poly[i][0], yi = poly[i][1];
		const xj = poly[j][0], yj = poly[j][1];
		const intersect = ((yi > py) !== (yj > py)) &&
			(px < ((xj - xi) * (py - yi)) / (yj - yi) + xi);
		if (intersect) inside = !inside;
	}
	return inside;
}

/**
 * A ferry/invasion route is valid only if the straight-line path between the
 * two hexes passes purely over water — no other island hexes in between.
 */
export function hasClearWaterPath(s: GameState, fromId: number, toId: number): boolean {
	if (fromId === toId) return false;
	const from = s.map.grids[fromId];
	const to = s.map.grids[toId];
	const dx = to.x - from.x;
	const dy = to.y - from.y;
	const dist = Math.hypot(dx, dy);
	const steps = Math.max(4, Math.ceil(dist / 15));
	const startT = 0.06;
	const endT = 0.94;
	for (let i = 0; i <= steps; i++) {
		const t = startT + (endT - startT) * (i / steps);
		const px = from.x + dx * t;
		const py = from.y + dy * t;
		for (const g of s.map.grids) {
			if (g.id === fromId || g.id === toId) continue;
			if (pointInPoly(px, py, g.cell)) return false;
		}
	}
	return true;
}

/** Ferry: two friendly hexes not already connected, water in between. */
export function canFerryConnect(s: GameState, fromId: number, toId: number): boolean {
	if (s.map.adj[fromId].includes(toId)) return false;
	return hasClearWaterPath(s, fromId, toId);
}

/** Water Invasion: friendly source, enemy target, no existing adjacency, water in between. */
export function canInvasionConnect(s: GameState, fromId: number, toId: number): boolean {
	if (s.states[fromId].owner !== s.current) return false;
	if (!s.states[toId].owner || s.states[toId].owner === s.current) return false;
	if (s.map.adj[fromId].includes(toId)) return false;
	if (s.states[fromId].armies < 2) return false;
	return hasClearWaterPath(s, fromId, toId);
}

export function clearSavedGame() {
	if (typeof window !== 'undefined') {
		try { localStorage.removeItem(SAVE_KEY); } catch { /* ignore */ }
	}
}

const HAND_MAX = 5;

function emptyHands(): Record<Player, CardType[]> {
	return { blue: [], green: [], red: [], brown: [] };
}

function emptyAlive(): Record<Player, boolean> {
	return { blue: true, green: true, red: true, brown: true };
}

/**
 * Initialize a new game. Difficulty 1..4 controls how many countries the
 * human player starts with; startingArmies is the initial armies per grid.
 */
export function startGame(difficulty = 2, startingArmies = 3, seed?: number): GameState {
	const s = seed ?? Math.floor(Math.random() * 1e9);
	const map = generateMap(s);
	const states: GridState[] = map.grids.map(() => ({ owner: null, armies: 0 }));

	// Distribute grids. Human (blue) advantage from difficulty setting.
	// Difficulty 1 = easiest → blue gets a bigger share of starting countries
	const shares = { blue: 0.25, green: 0.25, red: 0.25, brown: 0.25 };
	// Bump blue based on difficulty (1 easy → +extra, 4 hard → -less)
	const bump = (5 - difficulty) * 0.06; // diff1=+0.24, diff4=+0.06
	shares.blue += bump;
	const remaining = 1 - shares.blue;
	shares.green = remaining / 3;
	shares.red = remaining / 3;
	shares.brown = remaining / 3;

	// Shuffle grid ids, assign in proportion
	const rand = mulberry32(s ^ 0xa5a5a5);
	const ids = map.grids.map((g) => g.id).sort(() => rand() - 0.5);
	const n = ids.length;
	const cutBlue = Math.floor(n * shares.blue);
	const cutGreen = cutBlue + Math.floor(n * shares.green);
	const cutRed = cutGreen + Math.floor(n * shares.red);
	for (let i = 0; i < n; i++) {
		const id = ids[i];
		const owner: Player =
			i < cutBlue ? 'blue' : i < cutGreen ? 'green' : i < cutRed ? 'red' : 'brown';
		states[id] = { owner, armies: startingArmies };
	}

	const startPlayer: Player = PLAYERS[Math.floor(rand() * 4)];
	const state: GameState = {
		map,
		seed: s,
		difficulty,
		states,
		hands: emptyHands(),
		alive: emptyAlive(),
		current: startPlayer,
		turn: 1,
		phase: 'placing',
		armiesToPlace: 0,
		doubleActive: false,
		selectedFrom: null,
		selectedTo: null,
		pendingArmies: 0,
		defeatedThisTurn: false,
		turnCardAwarded: false,
		lastAttackResult: null,
		pendingDiscard: false,
		eliteAttackActive: false,
		pendingInvasionLane: null,
		log: [
			{
				turn: 1,
				player: null,
				text: `New game (seed ${s}, difficulty ${difficulty}). ${PLAYER_NAMES[startPlayer]} plays first.`,
				kind: 'info'
			}
		],
		message: '',
		winner: null,
		history: [],
		stats: emptyStatsMap()
	};
	// Start first turn
	return beginTurn(state);
}

function mulberry32(a: number) {
	return function () {
		a |= 0;
		a = (a + 0x6d2b79f5) | 0;
		let t = a;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

export function countryCount(s: GameState, p: Player): number {
	let n = 0;
	for (const g of s.states) if (g.owner === p) n++;
	return n;
}

export function fullIslandBonus(s: GameState, p: Player): number {
	let bonus = 0;
	for (const isl of s.map.islands) {
		const gs = s.map.grids.filter((g) => g.island === isl.id);
		if (gs.every((g) => s.states[g.id].owner === p)) bonus += isl.value;
	}
	return bonus;
}

function computeReinforcements(s: GameState, p: Player): number {
	const c = countryCount(s, p);
	const base = Math.max(2, Math.floor(c / 3));
	return base + fullIslandBonus(s, p);
}

function log(s: GameState, text: string, kind: LogEntry['kind'] = 'info', player: Player | null = s.current) {
	s.log = [{ turn: s.turn, player, text, kind }, ...s.log].slice(0, 100);
}

function removePendingInvasionLane(s: GameState) {
	if (!s.pendingInvasionLane) return;
	const [a, b] = s.pendingInvasionLane;
	s.map.seaLanes = s.map.seaLanes.filter(([x, y]) => !((x === a && y === b) || (x === b && y === a)));
	s.map.adj[a] = s.map.adj[a].filter((n) => n !== b);
	s.map.adj[b] = s.map.adj[b].filter((n) => n !== a);
	log(s, `Water Invasion failed — sea route ${gridLabel(s, a)} ↔ ${gridLabel(s, b)} collapsed.`, 'card');
	s.pendingInvasionLane = null;
}

function snapshot(s: GameState) {
	const territories = { blue: 0, green: 0, red: 0, brown: 0 } as Record<Player, number>;
	const armies = { blue: 0, green: 0, red: 0, brown: 0 } as Record<Player, number>;
	for (const g of s.states) {
		if (!g.owner) continue;
		territories[g.owner]++;
		armies[g.owner] += g.armies;
	}
	const islands = { blue: 0, green: 0, red: 0, brown: 0 } as Record<Player, number>;
	for (const isl of s.map.islands) {
		const gs = s.map.grids.filter((g) => g.island === isl.id);
		const owners = new Set(gs.map((g) => s.states[g.id].owner));
		if (owners.size === 1) {
			const o = [...owners][0];
			if (o) islands[o]++;
		}
	}
	s.history = [...s.history, { turn: s.turn, territories, armies, islands }];
}

/**
 * Called once at the top of each player's turn: applies interest-style
 * events, computes reinforcements, and moves into 'placing' phase.
 */
function beginTurn(s: GameState): GameState {
	if (checkWin(s)) return s;
	// If current player is dead, skip
	let safety = 0;
	while (!s.alive[s.current] && safety++ < 4) {
		s.current = nextPlayer(s.current);
	}
	// Snapshot state for analytics at start of each player's turn
	snapshot(s);
	s.defeatedThisTurn = false;
	s.turnCardAwarded = false;
	s.lastAttackResult = null;
	s.pendingDiscard = false;
	s.eliteAttackActive = false;
	s.pendingInvasionLane = null;
	s.doubleActive = false;
	s.selectedFrom = null;
	s.selectedTo = null;
	s.pendingArmies = 0;

	// Random world event 25% chance (skip on turn 1)
	if (s.turn > 1 && Math.random() < 0.25) {
		applyRandomEvent(s);
		if (s.winner) return s;
	}

	// Production centers double at ~10% chance (per manual)
	if (Math.random() < 0.1) {
		let touched = 0;
		for (const g of s.map.grids) {
			if (g.production && s.states[g.id].owner) {
				s.states[g.id].armies *= 2;
				touched++;
			}
		}
		if (touched > 0) log(s, `Production centers active! ${touched} grids doubled.`, 'event', null);
	}

	// Reinforcements
	let reinf = computeReinforcements(s, s.current);
	s.armiesToPlace = reinf;
	log(s, `${PLAYER_NAMES[s.current]}'s turn ${s.turn}. Reinforcements: ${reinf} (${countryCount(s, s.current)} territories, +${fullIslandBonus(s, s.current)} island bonus).`, 'info');
	s.phase = 'placing';
	s.message = `${PLAYER_NAMES[s.current]}: place ${s.armiesToPlace} armies. Click one of your territories.`;
	return s;
}

function nextPlayer(p: Player): Player {
	const idx = PLAYERS.indexOf(p);
	return PLAYERS[(idx + 1) % PLAYERS.length];
}

function checkWin(s: GameState): boolean {
	if (s.map.grids.length === 0) return false; // degenerate: empty map
	const alivePlayers = PLAYERS.filter((p) => s.alive[p]);
	// Someone owns all grids
	for (const p of PLAYERS) {
		if (countryCount(s, p) === s.map.grids.length) {
			s.winner = p;
			s.phase = 'game_over';
			log(s, `${PLAYER_NAMES[p]} has conquered the world!`, 'defeat', null);
			return true;
		}
	}
	if (alivePlayers.length === 1) {
		s.winner = alivePlayers[0];
		s.phase = 'game_over';
		log(s, `${PLAYER_NAMES[alivePlayers[0]]} is the last army standing!`, 'defeat', null);
		return true;
	}
	return false;
}

function updateAlive(s: GameState) {
	for (const p of PLAYERS) {
		if (s.alive[p] && countryCount(s, p) === 0) {
			s.alive[p] = false;
			log(s, `${PLAYER_NAMES[p]} has been eliminated!`, 'defeat', null);
		}
	}
}

function applyRandomEvent(s: GameState) {
	// Bucket weights inside a fired event: earthquake 32%, flood 32%,
	// rebellion 31%, rebels-flip 5% (rare because it teleports ownership).
	const r = Math.random();
	if (r < 0.32) {
		// Earthquake — 3-4 grids
		const count = 3 + Math.floor(Math.random() * 2);
		const hits = pickRandomGrids(s, count);
		for (const id of hits) {
			const g = s.states[id];
			if (g.owner) {
				const loss = Math.min(g.armies, 2 + Math.floor(Math.random() * 4));
				g.armies -= loss;
				if (g.armies < 0) g.armies = 0;
			}
		}
		log(s, `Earthquake devastates ${hits.length} territories!`, 'event', null);
	} else if (r < 0.64) {
		// Flood
		const count = 3 + Math.floor(Math.random() * 2);
		const hits = pickRandomGrids(s, count);
		for (const id of hits) {
			const g = s.states[id];
			if (g.owner) {
				const loss = Math.min(g.armies, 1 + Math.floor(Math.random() * 3));
				g.armies -= loss;
				if (g.armies < 0) g.armies = 0;
			}
		}
		log(s, `Floods inundate ${hits.length} territories!`, 'event', null);
	} else if (r < 0.95) {
		// Rebellion — one grid loses half
		const ids = s.map.grids.filter((g) => s.states[g.id].owner).map((g) => g.id);
		if (ids.length) {
			const id = ids[Math.floor(Math.random() * ids.length)];
			const g = s.states[id];
			const loss = Math.ceil(g.armies / 2);
			g.armies -= loss;
			log(s, `Rebellion in ${gridLabel(s, id)}! ${loss} armies lost.`, 'event', null);
			if (g.armies < 0) g.armies = 0;
		}
	} else {
		// Rebels flip a grid to another owner (anywhere on the map). Rare —
		// weighted low in applyRandomEvent's bucket above.
		const ids = s.map.grids.filter((g) => s.states[g.id].owner).map((g) => g.id);
		if (ids.length) {
			const id = ids[Math.floor(Math.random() * ids.length)];
			const g = s.states[id];
			const oldOwner = g.owner;
			const otherOwners = PLAYERS.filter((p) => p !== oldOwner && s.alive[p]);
			if (otherOwners.length) {
				const newOwner = otherOwners[Math.floor(Math.random() * otherOwners.length)];
				g.owner = newOwner;
				g.armies = Math.max(1, Math.floor(g.armies / 2));
				log(s, `Rebels overthrew ${PLAYER_NAMES[oldOwner!]} in ${gridLabel(s, id)}! Now held by ${PLAYER_NAMES[newOwner]}.`, 'event', null);
			}
		}
	}
	updateAlive(s);
	checkWin(s);
}

function pickRandomGrids(s: GameState, count: number): number[] {
	const shuffled = [...s.map.grids].map((g) => g.id).sort(() => Math.random() - 0.5);
	return shuffled.slice(0, count);
}

function gridLabel(s: GameState, id: number): string {
	const g = s.map.grids[id];
	const isl = s.map.islands.find((i) => i.id === g.island)!;
	const localIdx = s.map.grids.filter((x) => x.island === g.island).findIndex((x) => x.id === id) + 1;
	return `${isl.name}-${localIdx}`;
}

// -- Placement --
export function placeArmies(gridId: number, qty: number): void {
	game.update((s) => {
		if (s.phase !== 'placing') return s;
		if (s.states[gridId].owner !== s.current) {
			s.message = 'You can only place on your own territories.';
			return s;
		}
		const q = Math.max(1, Math.min(qty, s.armiesToPlace));
		s.states[gridId].armies += q;
		s.armiesToPlace -= q;
		if (s.armiesToPlace === 0) {
			if (s.doubleActive) {
				s.doubleActive = false;
			}
			s.phase = 'action';
			s.message = `${PLAYER_NAMES[s.current]}: Attack, move, or pass.`;
		} else {
			s.message = `${PLAYER_NAMES[s.current]}: ${s.armiesToPlace} armies left to place.`;
		}
		return s;
	});
}

// -- Attack flow --
export function beginAttack() {
	game.update((s) => {
		if (s.phase !== 'action') return s;
		s.phase = 'attack_select_from';
		s.selectedFrom = null;
		s.selectedTo = null;
		s.message = 'Select a territory to attack FROM (must have 2+ armies).';
		return s;
	});
}

export function beginMove() {
	game.update((s) => {
		if (s.phase !== 'action') return s;
		s.phase = 'move_select_from';
		s.selectedFrom = null;
		s.selectedTo = null;
		s.message = 'Move: select the source territory.';
		return s;
	});
}

export function cancelAction() {
	game.update((s) => {
		if (s.phase === 'game_over' || s.phase === 'placing') return s;
		s.phase = 'action';
		s.selectedFrom = null;
		s.selectedTo = null;
		s.pendingArmies = 0;
		s.message = 'Cancelled. Attack, move, or pass.';
		return s;
	});
}

export function endTurn() {
	game.update((s) => {
		if (s.phase !== 'action') return s;
		// Card rule: award unless the turn ends with an attack LOSS.
		// (Not attacking at all still yields a card — reward for a peaceful turn.)
		const shouldAward = s.lastAttackResult !== 'loss' && !s.turnCardAwarded;
		if (shouldAward) {
			const card = drawCard(s);
			if (card) {
				s.hands[s.current] = [...s.hands[s.current], card];
				log(s, `${PLAYER_NAMES[s.current]} drew a ${CARD_LABELS[card]} card.`, 'card');
				s.turnCardAwarded = true;
				// If human is over the hand limit, pause for them to pick a discard.
				if (s.current === 'blue' && s.hands.blue.length > HAND_MAX) {
					s.pendingDiscard = true;
					s.phase = 'discard';
					s.message = 'Hand full — click a card to discard.';
					return s;
				}
				enforceHandLimit(s);
			}
		}
		return advanceTurn(s);
	});
}

/** Human clicks a card to discard when their hand is over the limit. */
export function discardCard(index: number) {
	game.update((s) => {
		if (s.phase !== 'discard') return s;
		const hand = s.hands[s.current];
		if (index < 0 || index >= hand.length) return s;
		const discarded = hand[index];
		s.hands[s.current] = hand.filter((_, i) => i !== index);
		log(s, `${PLAYER_NAMES[s.current]} discarded ${CARD_LABELS[discarded]}.`, 'card');
		if (s.hands[s.current].length <= HAND_MAX) {
			s.pendingDiscard = false;
			return advanceTurn(s);
		}
		s.message = 'Hand still full — pick another card to discard.';
		return s;
	});
}

function drawCard(s: GameState): CardType | null {
	// small chance of Lose-All: clear hand instead of drawing
	if (Math.random() < 0.07) {
		if (s.hands[s.current].length > 0) {
			log(s, `${PLAYER_NAMES[s.current]} drew a Lose-All Cards event — their hand was cleared!`, 'card');
			s.hands[s.current] = [];
		}
		return null;
	}
	const card = CARD_POOL[Math.floor(Math.random() * CARD_POOL.length)];
	s.stats[s.current].cardsDrawn++;
	return card;
}

function enforceHandLimit(s: GameState) {
	// If AI over limit, discard random. Human over limit prompted via UI —
	// we auto-discard oldest to avoid a modal for now.
	while (s.hands[s.current].length > HAND_MAX) {
		s.hands[s.current].shift();
	}
}

function advanceTurn(s: GameState): GameState {
	s.turn += 1;
	s.current = nextPlayer(s.current);
	return beginTurn(s);
}

export function selectGrid(gridId: number): void {
	game.update((s) => {
		switch (s.phase) {
			case 'attack_select_from': {
				if (s.states[gridId].owner !== s.current) { s.message = 'Choose your own territory.'; break; }
				if (s.states[gridId].armies < 2) { s.message = 'Need at least 2 armies to attack.'; break; }
				s.selectedFrom = gridId;
				s.phase = 'attack_select_to';
				s.message = 'Select an ADJACENT enemy territory.';
				break;
			}
			case 'attack_select_to': {
				if (s.selectedFrom == null) break;
				if (!s.map.adj[s.selectedFrom].includes(gridId)) { s.message = 'Not adjacent.'; break; }
				if (s.states[gridId].owner === s.current) { s.message = 'Choose an enemy or neutral territory.'; break; }
				s.selectedTo = gridId;
				s.phase = 'attack_rolling';
				s.message = 'Rolling…';
				break;
			}
			case 'attack_move_in': {
				// clicks not used; UI slider handles it
				break;
			}
			case 'move_select_from': {
				if (s.states[gridId].owner !== s.current) { s.message = 'Choose your own territory.'; break; }
				if (s.states[gridId].armies < 2) { s.message = 'Need at least 2 armies to move (1 must stay).'; break; }
				s.selectedFrom = gridId;
				s.phase = 'move_select_to';
				s.message = 'Choose an adjacent friendly territory.';
				break;
			}
			case 'move_select_to': {
				if (s.selectedFrom == null) break;
				if (!s.map.adj[s.selectedFrom].includes(gridId)) { s.message = 'Not adjacent.'; break; }
				if (s.states[gridId].owner !== s.current) { s.message = 'Must be your territory.'; break; }
				s.selectedTo = gridId;
				s.pendingArmies = 1;
				s.phase = 'move_qty';
				s.message = 'Choose how many to move, then confirm.';
				break;
			}
			case 'bomb_select': {
				const target = s.states[gridId];
				if (!target.owner || target.owner === s.current) { s.message = 'Bomb an enemy territory.'; break; }
				resolveBomb(s, gridId);
				break;
			}
			case 'air_from': {
				if (s.states[gridId].owner !== s.current) { s.message = 'Choose your own territory.'; break; }
				if (s.states[gridId].armies < 2) { s.message = 'Need 2+ armies (1 must stay).'; break; }
				s.selectedFrom = gridId;
				s.phase = 'air_to';
				s.message = 'Choose ANY of your territories as destination.';
				break;
			}
			case 'air_to': {
				if (s.selectedFrom == null) break;
				if (s.states[gridId].owner !== s.current || gridId === s.selectedFrom) { s.message = 'Must be your territory.'; break; }
				s.selectedTo = gridId;
				s.pendingArmies = 1;
				s.phase = 'air_qty';
				s.message = 'Choose how many to airlift, then confirm.';
				break;
			}
			case 'reinforce_select': {
				if (s.states[gridId].owner !== s.current) { s.message = 'Pick one of your territories.'; break; }
				s.states[gridId].armies += 3;
				const idx = (s as any)._pendingCardIdx as number;
				s.hands[s.current] = s.hands[s.current].filter((_, i) => i !== idx);
				delete (s as any)._pendingCardIdx;
				log(s, `${PLAYER_NAMES[s.current]} reinforced ${gridLabel(s, gridId)} (+3 armies).`, 'card');
				s.phase = 'action';
				s.message = 'Attack, move, or pass.';
				break;
			}
			case 'sabotage_select': {
				if (!s.states[gridId].owner || s.states[gridId].owner === s.current) { s.message = 'Sabotage an enemy territory.'; break; }
				const g = s.states[gridId];
				const before = g.armies;
				g.armies = Math.max(1, Math.floor(g.armies / 2));
				const idx = (s as any)._pendingCardIdx as number;
				s.hands[s.current] = s.hands[s.current].filter((_, i) => i !== idx);
				delete (s as any)._pendingCardIdx;
				log(s, `${PLAYER_NAMES[s.current]} sabotaged ${gridLabel(s, gridId)}: ${before} → ${g.armies} armies.`, 'card');
				s.phase = 'action';
				s.message = 'Attack, move, or pass.';
				break;
			}
			case 'fortify_select': {
				if (s.states[gridId].owner !== s.current) { s.message = 'Fortify one of your territories.'; break; }
				if (s.states[gridId].fortified) { s.message = 'Already fortified.'; break; }
				s.states[gridId].fortified = true;
				const idx = (s as any)._pendingCardIdx as number;
				s.hands[s.current] = s.hands[s.current].filter((_, i) => i !== idx);
				delete (s as any)._pendingCardIdx;
				log(s, `${PLAYER_NAMES[s.current]} fortified ${gridLabel(s, gridId)} (+2 defense).`, 'card');
				s.phase = 'action';
				s.message = 'Attack, move, or pass.';
				break;
			}
			case 'ferry_from': {
				if (s.states[gridId].owner !== s.current) { s.message = 'Choose one of your territories.'; break; }
				s.selectedFrom = gridId;
				s.phase = 'ferry_to';
				s.message = 'Ferry: choose the second of your territories (must not be already connected).';
				break;
			}
			case 'ferry_to': {
				if (s.selectedFrom == null) break;
				if (s.states[gridId].owner !== s.current || gridId === s.selectedFrom) { s.message = 'Choose a different territory of yours.'; break; }
				if (!canFerryConnect(s, s.selectedFrom, gridId)) { s.message = 'Ferry needs a straight-line water path — no islands in between.'; break; }
				// Establish a permanent sea lane between the two hexes.
				s.map.seaLanes.push([s.selectedFrom, gridId]);
				s.map.adj[s.selectedFrom].push(gridId);
				s.map.adj[gridId].push(s.selectedFrom);
				const idx = (s as any)._pendingCardIdx as number;
				s.hands[s.current] = s.hands[s.current].filter((_, i) => i !== idx);
				delete (s as any)._pendingCardIdx;
				log(s, `${PLAYER_NAMES[s.current]} opened a ferry route: ${gridLabel(s, s.selectedFrom)} ↔ ${gridLabel(s, gridId)}.`, 'card');
				s.phase = 'action';
				s.selectedFrom = null;
				s.selectedTo = null;
				s.message = 'Attack, move, or pass.';
				break;
			}
			case 'invasion_from': {
				if (s.states[gridId].owner !== s.current) { s.message = 'Launch from one of your territories.'; break; }
				if (s.states[gridId].armies < 2) { s.message = 'Need at least 2 armies to invade.'; break; }
				s.selectedFrom = gridId;
				s.phase = 'invasion_to';
				s.message = 'Water Invasion: choose an enemy territory with a straight-line water path.';
				break;
			}
			case 'invasion_to': {
				if (s.selectedFrom == null) break;
				if (!canInvasionConnect(s, s.selectedFrom, gridId)) { s.message = 'No clear water path — invasion needs open sea.'; break; }
				// Open a TEMPORARY sea lane and immediately begin an attack.
				s.map.seaLanes.push([s.selectedFrom, gridId]);
				s.map.adj[s.selectedFrom].push(gridId);
				s.map.adj[gridId].push(s.selectedFrom);
				s.pendingInvasionLane = [s.selectedFrom, gridId];
				const idx = (s as any)._pendingCardIdx as number;
				s.hands[s.current] = s.hands[s.current].filter((_, i) => i !== idx);
				delete (s as any)._pendingCardIdx;
				log(s, `${PLAYER_NAMES[s.current]} launched a Water Invasion: ${gridLabel(s, s.selectedFrom)} → ${gridLabel(s, gridId)}.`, 'card');
				// Slip directly into the rolling phase.
				s.selectedTo = gridId;
				s.phase = 'attack_rolling';
				s.message = 'Invasion — rolling…';
				break;
			}
		}
		return s;
	});
}

// Perform an attack roll.
export function rollAttack(): void {
	game.update((s) => {
		if (s.phase !== 'attack_rolling') return s;
		if (s.selectedFrom == null || s.selectedTo == null) return s;
		const from = s.states[s.selectedFrom];
		const to = s.states[s.selectedTo];
		const atkBase = 1 + Math.floor(Math.random() * 6);
		const defBase = 1 + Math.floor(Math.random() * 6);
		const defBonus = defenseBonus(s, s.selectedTo);
		const atkBonus = attackerBonus(s, s.selectedTo);
		const eliteBonus = s.eliteAttackActive ? 2 : 0;
		const atk = atkBase + atkBonus + eliteBonus;
		const def = defBase + defBonus;
		const attacker = from.owner!;
		const defender = to.owner; // may be null (neutral)
		const defenderLabel = defender ? PLAYER_NAMES[defender].toLowerCase() : 'neutral';
		const atkMods: string[] = [];
		if (atkBonus > 0) atkMods.push(`+${atkBonus} 🌲`);
		if (eliteBonus > 0) atkMods.push(`+${eliteBonus} elite`);
		const atkTxt = atkMods.length ? `${atk} (${atkMods.join(', ')})` : `${atk}`;
		const defMods: string[] = [];
		if (s.map.grids[s.selectedTo].terrain === 'mountain') defMods.push('+1 ⛰');
		if (s.states[s.selectedTo].fortified) defMods.push('+2 fort');
		const defTxt = defMods.length ? `${def} (${defMods.join(', ')})` : `${def}`;
		if (atk > def) {
			to.armies -= 1;
			s.stats[attacker].attacksWon++;
			log(s, `${gridLabel(s, s.selectedFrom)} (${from.owner}) attacks ${gridLabel(s, s.selectedTo)} (${defenderLabel}): ${atkTxt} vs ${defTxt} — defender loses 1.`, 'attack');
		} else {
			from.armies -= 1;
			s.stats[attacker].attacksLost++;
			log(s, `${gridLabel(s, s.selectedFrom)} (${from.owner}) attacks ${gridLabel(s, s.selectedTo)} (${defenderLabel}): ${atkTxt} vs ${defTxt} — attacker loses 1.`, 'attack');
		}
		if (to.armies <= 0) {
			// Conquered! Ask how many to move in
			to.owner = from.owner;
			to.fortified = false; // fortifications are destroyed on capture
			s.stats[attacker].territoriesCaptured++;
			if (defender) s.stats[defender].territoriesLost++;
			s.defeatedThisTurn = true;
			s.lastAttackResult = 'win';
			// Elite Troops was consumed by this successful attack.
			s.eliteAttackActive = false;
			// Water Invasion succeeded — the sea lane stays permanent.
			s.pendingInvasionLane = null;
			log(s, `${PLAYER_NAMES[from.owner!]} conquered ${gridLabel(s, s.selectedTo)}!`, 'defeat');
			// move at least 1 in
			from.armies -= 1;
			to.armies = 1;
			updateAlive(s);
			if (checkWin(s)) return s;
			if (from.armies > 0) {
				s.phase = 'attack_move_in';
				s.pendingArmies = 0; // extra to move in
				s.message = `Move additional armies from ${gridLabel(s, s.selectedFrom)} to ${gridLabel(s, s.selectedTo)}? (0 to ${from.armies})`;
			} else {
				s.phase = 'action';
				s.selectedFrom = null;
				s.selectedTo = null;
				s.message = 'Attack, move, or pass.';
			}
			return s;
		}
		if (from.armies < 2) {
			// Per manual: if attacker drops to 1, forfeit the grid. But never
			// forfeit to a neutral (null-owner) defender — just end the attack.
			s.lastAttackResult = 'loss';
			s.eliteAttackActive = false; // consumed regardless of outcome
			removePendingInvasionLane(s);
			if (!to.owner) {
				log(s, `Attacker reduced to 1 — ${gridLabel(s, s.selectedFrom)} attack aborted.`, 'attack');
				s.phase = 'action';
				s.selectedFrom = null;
				s.selectedTo = null;
				s.message = 'Attack, move, or pass.';
				return s;
			}
			log(s, `Attacker reduced to 1 — ${gridLabel(s, s.selectedFrom)} forfeit to ${PLAYER_NAMES[to.owner]}!`, 'attack');
			const forfeitTo = to.owner;
			from.owner = forfeitTo;
			from.armies = 1;
			updateAlive(s);
			if (checkWin(s)) return s;
			// Turn ends per manual
			s.phase = 'action';
			s.selectedFrom = null;
			s.selectedTo = null;
			// End turn immediately
			if (s.defeatedThisTurn && !s.turnCardAwarded) {
				const card = drawCard(s);
				if (card) {
					s.hands[s.current] = [...s.hands[s.current], card];
					log(s, `${PLAYER_NAMES[s.current]} drew a ${CARD_LABELS[card]} card.`, 'card');
					enforceHandLimit(s);
					s.turnCardAwarded = true;
				}
			}
			return advanceTurn(s);
		}
		// Continue in attack_rolling phase — user can click Roll again
		s.message = `Attacker ${from.armies} vs defender ${to.armies}. Roll again or Quit-Attack.`;
		return s;
	});
}

export function quitAttack() {
	game.update((s) => {
		if (s.phase !== 'attack_rolling' && s.phase !== 'attack_select_from' && s.phase !== 'attack_select_to') return s;
		// Mid-attack quit counts as a loss (unless we already had a win result).
		if (s.phase === 'attack_rolling' && s.lastAttackResult !== 'win') {
			s.lastAttackResult = 'loss';
			removePendingInvasionLane(s);
		}
		s.phase = 'action';
		s.selectedFrom = null;
		s.selectedTo = null;
		s.message = 'Attack ended. Attack, move, or pass.';
		return s;
	});
}

export function confirmMoveInAfterConquest(extra: number) {
	game.update((s) => {
		if (s.phase !== 'attack_move_in' || s.selectedFrom == null || s.selectedTo == null) return s;
		const from = s.states[s.selectedFrom];
		const to = s.states[s.selectedTo];
		// Must leave at least 1 army behind — never drain the source to 0.
		const q = Math.max(0, Math.min(extra, from.armies - 1));
		from.armies -= q;
		to.armies += q;
		s.phase = 'action';
		s.selectedFrom = null;
		s.selectedTo = null;
		s.message = 'Attack, move, or pass.';
		return s;
	});
}

export function confirmMove(qty: number) {
	game.update((s) => {
		if (s.phase !== 'move_qty' || s.selectedFrom == null || s.selectedTo == null) return s;
		const from = s.states[s.selectedFrom];
		const to = s.states[s.selectedTo];
		const q = Math.max(1, Math.min(qty, from.armies - 1));
		from.armies -= q;
		to.armies += q;
		log(s, `${PLAYER_NAMES[s.current]} moved ${q} from ${gridLabel(s, s.selectedFrom)} to ${gridLabel(s, s.selectedTo)}.`, 'info');
		s.phase = 'action';
		s.selectedFrom = null;
		s.selectedTo = null;
		// per manual, move ends the turn
		return advanceTurn(s);
	});
}

// -- Card actions --
export function playCard(idx: number) {
	game.update((s) => {
		const hand = s.hands[s.current];
		const card = hand[idx];
		if (!card) return s;
		switch (card) {
			case 'bonus5':
			case 'bonus8':
			case 'bonus15': {
				if (s.phase !== 'placing') { s.message = 'Play bonus armies during placement.'; return s; }
				const n = card === 'bonus5' ? 5 : card === 'bonus8' ? 8 : 15;
				s.armiesToPlace += n;
				s.hands[s.current] = hand.filter((_, i) => i !== idx);
				log(s, `${PLAYER_NAMES[s.current]} played ${CARD_LABELS[card]} (+${n}).`, 'card');
				s.message = `Place ${s.armiesToPlace} armies.`;
				break;
			}
			case 'double': {
				if (s.phase !== 'placing' || s.doubleActive) { s.message = 'Play Double during placement (once).'; return s; }
				s.armiesToPlace *= 2;
				s.doubleActive = true;
				s.hands[s.current] = hand.filter((_, i) => i !== idx);
				log(s, `${PLAYER_NAMES[s.current]} played Double! Placement doubled to ${s.armiesToPlace}.`, 'card');
				s.message = `Place ${s.armiesToPlace} armies.`;
				break;
			}
			case 'bomb': {
				if (s.phase !== 'placing' && s.phase !== 'action') { s.message = 'Play Bomb during your turn.'; return s; }
				s.phase = 'bomb_select';
				s.selectedFrom = idx; // stash card index in selectedFrom for later
				s.message = 'Bomb: click any enemy territory.';
				break;
			}
			case 'air': {
				if (s.phase !== 'action') { s.message = 'Air Move during action phase.'; return s; }
				s.phase = 'air_from';
				s.selectedFrom = null;
				s.selectedTo = null;
				// stash card index by temporarily marking; we'll delete on confirm
				(s as any)._pendingCardIdx = idx;
				s.message = 'Air Move: choose source (your territory, 2+ armies).';
				break;
			}
			case 'antibomb':
				s.message = 'Anti-Bomb is passive — it protects automatically.';
				break;
			case 'wild':
				s.message = 'Wild card is used in set trades (auto).';
				break;
			case 'reinforce': {
				if (s.phase !== 'placing' && s.phase !== 'action') { s.message = 'Play Reinforce during your turn.'; return s; }
				s.phase = 'reinforce_select';
				(s as any)._pendingCardIdx = idx;
				s.message = 'Reinforce: click one of your territories to add 3 armies.';
				break;
			}
			case 'elite': {
				if (s.phase !== 'action') { s.message = 'Play Elite Troops in action phase, before attacking.'; return s; }
				s.eliteAttackActive = true;
				s.hands[s.current] = hand.filter((_, i) => i !== idx);
				log(s, `${PLAYER_NAMES[s.current]} rallied Elite Troops (+2 attack next battle).`, 'card');
				s.message = 'Elite Troops active. Attack now (+2 to each roll) — consumed by first attack.';
				break;
			}
			case 'sabotage': {
				if (s.phase !== 'placing' && s.phase !== 'action') { s.message = 'Play Sabotage during your turn.'; return s; }
				s.phase = 'sabotage_select';
				(s as any)._pendingCardIdx = idx;
				s.message = 'Sabotage: click any enemy territory to halve its armies.';
				break;
			}
			case 'fortify': {
				if (s.phase !== 'placing' && s.phase !== 'action') { s.message = 'Play Fortify during your turn.'; return s; }
				s.phase = 'fortify_select';
				(s as any)._pendingCardIdx = idx;
				s.message = 'Fortify: click one of your territories to fortify it (+2 defense).';
				break;
			}
			case 'ferry': {
				if (s.phase !== 'placing' && s.phase !== 'action') { s.message = 'Play Ferry Route during your turn.'; return s; }
				s.phase = 'ferry_from';
				s.selectedFrom = null;
				s.selectedTo = null;
				(s as any)._pendingCardIdx = idx;
				s.message = 'Ferry: choose the first of your territories to link by sea.';
				break;
			}
			case 'invasion': {
				if (s.phase !== 'action') { s.message = 'Play Water Invasion in the action phase.'; return s; }
				s.phase = 'invasion_from';
				s.selectedFrom = null;
				s.selectedTo = null;
				(s as any)._pendingCardIdx = idx;
				s.message = 'Water Invasion: choose one of your territories to launch from (2+ armies).';
				break;
			}
		}
		return s;
	});
}

function resolveBomb(s: GameState, targetId: number) {
	// The `selectedFrom` field carries the card-hand index we stashed in playCard()
	const idx = s.selectedFrom!;
	// Anti-bomb check on defender
	const defender = s.states[targetId].owner!;
	const defHand = s.hands[defender];
	const abIdx = defHand.findIndex((c) => c === 'antibomb');
	if (abIdx >= 0) {
		// Remove ALL antibombs from defender per manual
		s.hands[defender] = defHand.filter((c) => c !== 'antibomb');
		log(s, `${PLAYER_NAMES[defender]}'s Anti-Bomb absorbed a bomb from ${PLAYER_NAMES[s.current]}!`, 'card');
	} else {
		const g = s.states[targetId];
		const loss = Math.min(g.armies, 3 + Math.floor(Math.random() * 5));
		g.armies -= loss;
		log(s, `${PLAYER_NAMES[s.current]} bombed ${gridLabel(s, targetId)} (${PLAYER_NAMES[defender]}) — ${loss} armies destroyed!`, 'card');
		if (g.armies < 0) g.armies = 0;
	}
	// remove bomb card
	s.hands[s.current] = s.hands[s.current].filter((_, i) => i !== idx);
	s.phase = 'action';
	s.selectedFrom = null;
	updateAlive(s);
	checkWin(s);
}

export function confirmAir(qty: number) {
	game.update((s) => {
		if (s.phase !== 'air_qty' || s.selectedFrom == null || s.selectedTo == null) return s;
		const from = s.states[s.selectedFrom];
		const to = s.states[s.selectedTo];
		const q = Math.max(1, Math.min(qty, from.armies - 1));
		from.armies -= q;
		to.armies += q;
		const idx = (s as any)._pendingCardIdx as number;
		if (typeof idx === 'number') {
			s.hands[s.current] = s.hands[s.current].filter((_, i) => i !== idx);
			delete (s as any)._pendingCardIdx;
		}
		log(s, `${PLAYER_NAMES[s.current]} air-moved ${q} from ${gridLabel(s, s.selectedFrom)} to ${gridLabel(s, s.selectedTo)}.`, 'card');
		s.phase = 'action';
		s.selectedFrom = null;
		s.selectedTo = null;
		return s;
	});
}

// Try trading a set of 3 matching cards (with wild). Returns true if traded.
export function tradeCards(indices: number[]): boolean {
	let ok = false;
	game.update((s) => {
		if (s.phase !== 'placing') return s;
		if (indices.length !== 3) return s;
		const hand = s.hands[s.current];
		const cards = indices.map((i) => hand[i]);
		if (cards.some((c) => !c)) return s;
		// Not allowed to trade 3 wilds
		if (cards.every((c) => c === 'wild')) return s;
		// Must all match (wild matches anything)
		const nonWild = cards.filter((c) => c !== 'wild');
		if (nonWild.length > 0 && !nonWild.every((c) => c === nonWild[0])) return s;
		// bonus
		const bonus = 5;
		s.armiesToPlace += bonus;
		// remove used cards
		const set = new Set(indices);
		s.hands[s.current] = hand.filter((_, i) => !set.has(i));
		log(s, `${PLAYER_NAMES[s.current]} traded a set of ${CARD_LABELS[(nonWild[0] ?? 'wild') as CardType]} for +${bonus} armies.`, 'card');
		s.message = `Place ${s.armiesToPlace} armies.`;
		ok = true;
		return s;
	});
	return ok;
}

export function newGame(difficulty: number, startingArmies: number) {
	game.set(startGame(difficulty, startingArmies));
}

// Derived
export const currentState = derived(game, ($g) => $g);
