import { writable, derived, get } from 'svelte/store';
import { generateMap, crossesRiver, wallBetween, shuffle, type GameMap } from './map';

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
	| 'reinforce'
	| 'elite'
	| 'sabotage'
	| 'fortify'
	| 'ferry'
	| 'invasion'
	| 'deforest'
	| 'storm'
	| 'artillery'
	| 'bridge'
	| 'oasis'
	| 'rampart'
	| 'wall';

export interface CardMeta {
	icon: string;
	kind: 'attack' | 'defense' | 'boost' | 'movement' | 'terrain';
	when: string;
	desc: string;
}

// One selection step in a card's targeting flow. `check` returns an error
// message when `id` is not a legal pick, or null when it is — this single
// predicate drives BOTH engine validation (selectGrid) and UI highlighting
// (web isSelectable / the bridge's selectableHexes), so a card's targeting
// rules live in exactly one place.
export interface SelectStep {
	phase: Phase;
	prompt: string;
	check: (s: GameState, id: number, from: number | null) => string | null;
}

// The single source of truth for a card: display metadata, draw-pool weight,
// and behaviour. Immediate cards implement `onPlay`; targeting cards declare
// 1–2 `steps` plus `onResolve`, which applies the effect after the final pick.
// Adding a card = one entry here (+ its name in the CardType union).
export interface CardDef {
	id: CardType;
	label: string;
	icon: string;
	kind: CardMeta['kind'];
	when: string;
	desc: string;
	weight: number; // number of copies in the draw pool
	passive?: boolean; // never actively played (antibomb)
	playableIn: Phase[]; // phases the card may be started from
	onPlay?: (s: GameState, idx: number) => void; // immediate cards
	steps?: SelectStep[]; // targeting cards
	onResolve?: (s: GameState, picks: number[], idx: number) => void;
}

// Phase groups reused across cards.
const PLACE_ONLY: Phase[] = ['placing'];
const TURN: Phase[] = ['placing', 'action'];
// Action phase, or while an attack is being set up (playing auto-cancels it).
const ACTION_OR_ATTACK: Phase[] = ['action', 'attack_select_from', 'attack_select_to'];

export const CARD_DEFS: CardDef[] = [
	{
		id: 'air', label: 'Air Move', icon: '✈', kind: 'movement', weight: 2,
		when: 'Action phase',
		desc: 'Move armies between any two of your territories, ignoring adjacency. Ends the turn.',
		playableIn: ACTION_OR_ATTACK,
		steps: [
			{ phase: 'air_from', prompt: 'Air Move: choose source (your territory, 2+ armies).',
				check: (s, id) => s.states[id].owner !== s.current ? 'Choose your own territory.'
					: s.states[id].armies < 2 ? 'Need 2+ armies (1 must stay).' : null },
			{ phase: 'air_to', prompt: 'Choose ANY of your territories as destination.',
				check: (s, id, from) => (s.states[id].owner !== s.current || id === from) ? 'Must be your territory.' : null }
		],
		// Air ends in a quantity picker; confirmAir() consumes the card.
		onResolve: (s, [, to]) => {
			s.selectedTo = to;
			s.pendingArmies = 1;
			s.phase = 'air_qty';
			s.message = 'Choose how many to airlift, then confirm.';
		}
	},
	{
		id: 'bonus5', label: '+5 Armies', icon: '+5', kind: 'boost', weight: 3,
		when: 'Placement phase', desc: 'Add 5 armies to your placement pool this turn.',
		playableIn: PLACE_ONLY,
		onPlay: (s, idx) => {
			s.armiesToPlace += 5; consumeCard(s, idx);
			log(s, `${PLAYER_NAMES[s.current]} played +5 Armies (+5).`, 'card');
			s.message = `Place ${s.armiesToPlace} armies.`;
		}
	},
	{
		id: 'bonus8', label: '+8 Armies', icon: '+8', kind: 'boost', weight: 2,
		when: 'Placement phase', desc: 'Add 8 armies to your placement pool this turn.',
		playableIn: PLACE_ONLY,
		onPlay: (s, idx) => {
			s.armiesToPlace += 8; consumeCard(s, idx);
			log(s, `${PLAYER_NAMES[s.current]} played +8 Armies (+8).`, 'card');
			s.message = `Place ${s.armiesToPlace} armies.`;
		}
	},
	{
		id: 'bonus15', label: '+15 Armies', icon: '+15', kind: 'boost', weight: 1,
		when: 'Placement phase', desc: 'Add 15 armies to your placement pool this turn.',
		playableIn: PLACE_ONLY,
		onPlay: (s, idx) => {
			s.armiesToPlace += 15; consumeCard(s, idx);
			log(s, `${PLAYER_NAMES[s.current]} played +15 Armies (+15).`, 'card');
			s.message = `Place ${s.armiesToPlace} armies.`;
		}
	},
	{
		id: 'double', label: 'Double', icon: '×2', kind: 'boost', weight: 2,
		when: 'Placement phase', desc: 'Double the number of armies you place this turn.',
		playableIn: PLACE_ONLY,
		onPlay: (s, idx) => {
			if (s.doubleActive) { s.message = 'Play Double during placement (once).'; return; }
			s.armiesToPlace *= 2; s.doubleActive = true; consumeCard(s, idx);
			log(s, `${PLAYER_NAMES[s.current]} played Double! Placement doubled to ${s.armiesToPlace}.`, 'card');
			s.message = `Place ${s.armiesToPlace} armies.`;
		}
	},
	{
		id: 'bomb', label: 'Bomb', icon: '💣', kind: 'attack', weight: 2,
		when: 'Placement or Action phase',
		desc: 'Detonate on any enemy territory to destroy 3–7 of their armies.',
		playableIn: TURN,
		steps: [{ phase: 'bomb_select', prompt: 'Bomb: click any enemy territory.',
			check: (s, id) => (!s.states[id].owner || s.states[id].owner === s.current) ? 'Bomb an enemy territory.' : null }],
		onResolve: (s, [id], idx) => resolveBomb(s, id, idx)
	},
	{
		id: 'antibomb', label: 'Anti-Bomb', icon: '🛡', kind: 'defense', weight: 2,
		when: 'Passive', passive: true, playableIn: [],
		desc: 'Automatically absorbs the next bomb targeting one of your hexes. No action needed.'
	},
	{
		id: 'reinforce', label: 'Reinforce (+3)', icon: '➕', kind: 'boost', weight: 2,
		when: 'Placement or Action phase', desc: 'Add 3 armies to any one of your territories immediately.',
		playableIn: TURN,
		steps: [{ phase: 'reinforce_select', prompt: 'Reinforce: click one of your territories to add 3 armies.',
			check: (s, id) => s.states[id].owner !== s.current ? 'Pick one of your territories.' : null }],
		onResolve: (s, [id], idx) => {
			s.states[id].armies += 3; consumeCard(s, idx);
			log(s, `${PLAYER_NAMES[s.current]} reinforced ${gridLabel(s, id)} (+3 armies).`, 'card');
			s.phase = 'action'; s.message = 'Attack, move, or pass.';
		}
	},
	{
		id: 'elite', label: 'Elite Troops', icon: '⚔', kind: 'attack', weight: 2,
		when: 'Action phase, before attacking',
		desc: 'Your next attack sequence rolls +2 on every die. Consumed by the first attack.',
		playableIn: ACTION_OR_ATTACK,
		onPlay: (s, idx) => {
			s.phase = 'action'; s.selectedFrom = null; s.selectedTo = null;
			s.eliteAttackActive = true; consumeCard(s, idx);
			log(s, `${PLAYER_NAMES[s.current]} rallied Elite Troops (+2 attack next battle).`, 'card');
			s.message = 'Elite Troops active. Attack now (+2 to each roll) — consumed by first attack.';
		}
	},
	{
		id: 'sabotage', label: 'Sabotage', icon: '☠', kind: 'attack', weight: 1,
		when: 'Placement or Action phase', desc: 'Halve the armies of any enemy territory (rounded down, min 1).',
		playableIn: TURN,
		steps: [{ phase: 'sabotage_select', prompt: 'Sabotage: click any enemy territory to halve its armies.',
			check: (s, id) => (!s.states[id].owner || s.states[id].owner === s.current) ? 'Sabotage an enemy territory.' : null }],
		onResolve: (s, [id], idx) => {
			const g = s.states[id]; const before = g.armies;
			g.armies = Math.max(1, Math.floor(g.armies / 2)); consumeCard(s, idx);
			log(s, `${PLAYER_NAMES[s.current]} sabotaged ${gridLabel(s, id)}: ${before} → ${g.armies} armies.`, 'card');
			s.phase = 'action'; s.message = 'Attack, move, or pass.';
		}
	},
	{
		id: 'fortify', label: 'Fortify', icon: '⛩', kind: 'defense', weight: 1,
		when: 'Placement or Action phase',
		desc: 'Give one of your hexes a permanent +2 defense bonus. Lost when the hex is captured.',
		playableIn: TURN,
		steps: [{ phase: 'fortify_select', prompt: 'Fortify: click one of your territories to fortify it (+2 defense).',
			check: (s, id) => s.states[id].owner !== s.current ? 'Fortify one of your territories.'
				: s.states[id].fortified ? 'Already fortified.' : null }],
		onResolve: (s, [id], idx) => {
			s.states[id].fortified = true; consumeCard(s, idx);
			log(s, `${PLAYER_NAMES[s.current]} fortified ${gridLabel(s, id)} (+2 defense).`, 'card');
			s.phase = 'action'; s.message = 'Attack, move, or pass.';
		}
	},
	{
		id: 'ferry', label: 'Ferry Route', icon: '⚓', kind: 'movement', weight: 1,
		when: 'Placement or Action phase',
		desc: 'Open a permanent sea lane between two of your territories over clear water.',
		playableIn: TURN,
		steps: [
			{ phase: 'ferry_from', prompt: 'Ferry: choose the first of your territories to link by sea.',
				check: (s, id) => s.states[id].owner !== s.current ? 'Choose one of your territories.' : null },
			{ phase: 'ferry_to', prompt: 'Ferry: choose the second of your territories (must not be already connected).',
				check: (s, id, from) => {
					if (s.states[id].owner !== s.current || id === from) return 'Choose a different territory of yours.';
					if (!canFerryConnect(s, from as number, id)) return 'Ferry needs a straight-line water path — no islands in between.';
					const laneExists = s.map.seaLanes.some(([x, y]) => (x === from && y === id) || (x === id && y === from));
					return laneExists ? 'A ferry route already exists there.' : null;
				} }
		],
		onResolve: (s, [from, to], idx) => {
			s.map.seaLanes.push([from, to]);
			if (!s.map.adj[from].includes(to)) s.map.adj[from].push(to);
			if (!s.map.adj[to].includes(from)) s.map.adj[to].push(from);
			consumeCard(s, idx);
			log(s, `${PLAYER_NAMES[s.current]} opened a ferry route: ${gridLabel(s, from)} ↔ ${gridLabel(s, to)}.`, 'card');
			s.phase = 'action'; s.selectedFrom = null; s.selectedTo = null; s.message = 'Attack, move, or pass.';
		}
	},
	{
		id: 'invasion', label: 'Water Invasion', icon: '🚢', kind: 'attack', weight: 1,
		when: 'Action phase',
		desc: 'Open a temporary sea lane and launch an attack across it. The lane stays only if you conquer the target.',
		playableIn: ACTION_OR_ATTACK,
		steps: [
			{ phase: 'invasion_from', prompt: 'Water Invasion: choose one of your territories to launch from (2+ armies).',
				check: (s, id) => s.states[id].owner !== s.current ? 'Launch from one of your territories.'
					: s.states[id].armies < 2 ? 'Need at least 2 armies to invade.' : null },
			{ phase: 'invasion_to', prompt: 'Water Invasion: choose an enemy territory with a straight-line water path.',
				check: (s, id, from) => !canInvasionConnect(s, from as number, id) ? 'No clear water path — invasion needs open sea.' : null }
		],
		onResolve: (s, [from, to], idx) => {
			s.map.seaLanes.push([from, to]);
			s.map.adj[from].push(to); s.map.adj[to].push(from);
			s.pendingInvasionLane = [from, to];
			consumeCard(s, idx);
			log(s, `${PLAYER_NAMES[s.current]} launched a Water Invasion: ${gridLabel(s, from)} → ${gridLabel(s, to)}.`, 'card');
			s.selectedTo = to; s.phase = 'attack_rolling'; s.message = 'Invasion — rolling…';
		}
	},
	{
		id: 'deforest', label: 'Deforestation', icon: '🪓', kind: 'terrain', weight: 1,
		when: 'Placement or Action phase',
		desc: 'Clear any forest hex on the map. Removes the +1 attacker bonus that forests provide.',
		playableIn: TURN,
		steps: [{ phase: 'deforest_select', prompt: 'Deforestation: click any forest hex to clear it.',
			check: (s, id) => s.map.grids[id].terrain !== 'forest' ? 'Pick a forest hex.' : null }],
		onResolve: (s, [id], idx) => {
			s.map.grids[id].terrain = 'plain'; consumeCard(s, idx);
			log(s, `${PLAYER_NAMES[s.current]} cleared the forest at ${gridLabel(s, id)}.`, 'card');
			s.phase = 'action'; s.message = 'Attack, move, or pass.';
		}
	},
	{
		id: 'storm', label: 'Storm', icon: '🌩', kind: 'terrain', weight: 1,
		when: 'Placement or Action phase', desc: 'Destroy any existing sea lane. Pick both endpoints of the route to sever.',
		playableIn: TURN,
		steps: [
			{ phase: 'storm_from', prompt: 'Storm: click one endpoint of the sea route you want to destroy.',
				check: (s, id) => s.map.seaLanes.some(([a, b]) => a === id || b === id) ? null : 'Pick a hex that anchors a sea route.' },
			{ phase: 'storm_to', prompt: 'Storm: click the other end of the sea route to destroy.',
				check: (s, id, from) => s.map.seaLanes.some(([a, b]) => (a === from && b === id) || (a === id && b === from)) ? null : 'No sea route between those hexes.' }
		],
		onResolve: (s, [from, to], idx) => {
			const laneIdx = s.map.seaLanes.findIndex(([a, b]) => (a === from && b === to) || (a === to && b === from));
			if (laneIdx >= 0) s.map.seaLanes.splice(laneIdx, 1);
			s.map.adj[from] = s.map.adj[from].filter((n) => n !== to);
			s.map.adj[to] = s.map.adj[to].filter((n) => n !== from);
			consumeCard(s, idx);
			log(s, `${PLAYER_NAMES[s.current]} summoned a Storm — sea route ${gridLabel(s, from)} ↔ ${gridLabel(s, to)} destroyed.`, 'card');
			s.phase = 'action'; s.selectedFrom = null; s.selectedTo = null; s.message = 'Attack, move, or pass.';
		}
	},
	{
		id: 'artillery', label: 'Artillery', icon: '💥', kind: 'attack', weight: 1,
		when: 'Action phase (from a city ★)',
		desc: 'Bombard any hex up to 2 steps away, launched from one of your cities (★). Roll four times — each hit removes one defender. Attackers never lose armies. Terrain and fortification bonuses still count.',
		playableIn: ACTION_OR_ATTACK,
		steps: [
			{ phase: 'artillery_from', prompt: 'Artillery: click one of your territories to bombard from (2+ armies).',
				check: (s, id) => s.states[id].owner !== s.current ? 'Bombard from one of your territories.'
					: !s.map.grids[id].production ? 'Artillery only fires from a city ★.'
					: s.states[id].armies < 2 ? 'Need at least 2 armies to man the guns.' : null },
			{ phase: 'artillery_to', prompt: 'Artillery: click a target within 2 hexes (any owner but yours).',
				check: (s, id, from) => !canArtilleryTarget(s, from as number, id) ? 'Target must be an enemy/neutral hex within 2 steps.' : null }
		],
		onResolve: (s, [from, to], idx) => resolveArtillery(s, from, to, idx)
	},
	{
		id: 'bridge', label: 'Bridge', icon: '🌉', kind: 'attack', weight: 2,
		when: 'Action phase, before attacking',
		desc: 'Bridge a river for your next attack — the defender loses the +1 river-crossing bonus. Consumed by the first attack.',
		playableIn: ACTION_OR_ATTACK,
		onPlay: (s, idx) => {
			s.phase = 'action'; s.selectedFrom = null; s.selectedTo = null;
			s.bridgeAttackActive = true; consumeCard(s, idx);
			log(s, `${PLAYER_NAMES[s.current]} deployed a Bridge (cancels river bonus next attack).`, 'card');
			s.message = 'Bridge active. Your next attack ignores the river-crossing defender bonus.';
		}
	},
	{
		id: 'oasis', label: 'Oasis', icon: '🌴', kind: 'terrain', weight: 1,
		when: 'Placement or Action phase',
		desc: 'Irrigate a desert hex you control, turning it back into plains. Removes the heat attrition (1 army lost per move into it).',
		playableIn: TURN,
		steps: [{ phase: 'oasis_select', prompt: 'Oasis: click one of your desert hexes to convert it to plains.',
			check: (s, id) => s.map.grids[id].terrain !== 'desert' ? 'Pick a desert hex.'
				: s.states[id].owner !== s.current ? 'Oasis only works on a desert you control.' : null }],
		onResolve: (s, [id], idx) => {
			s.map.grids[id].terrain = 'plain'; consumeCard(s, idx);
			log(s, `${PLAYER_NAMES[s.current]} irrigated the desert at ${gridLabel(s, id)}.`, 'card');
			s.phase = 'action'; s.message = 'Attack, move, or pass.';
		}
	},
	{
		id: 'rampart', label: 'Rampart (+1)', icon: '🏰', kind: 'defense', weight: 2,
		when: 'Placement or Action phase',
		desc: 'Give one of your hexes a permanent +1 defense bonus. Stacks with Fortify. Lost when the hex is captured.',
		playableIn: TURN,
		steps: [{ phase: 'rampart_select', prompt: 'Rampart: click one of your territories to reinforce it (+1 defense).',
			check: (s, id) => s.states[id].owner !== s.current ? 'Raise a rampart on one of your territories.'
				: s.states[id].rampart ? 'Already has a rampart.' : null }],
		onResolve: (s, [id], idx) => {
			s.states[id].rampart = true; consumeCard(s, idx);
			log(s, `${PLAYER_NAMES[s.current]} raised a rampart on ${gridLabel(s, id)} (+1 defense).`, 'card');
			s.phase = 'action'; s.message = 'Attack, move, or pass.';
		}
	},
	{
		id: 'wall', label: 'Wall', icon: '🧱', kind: 'defense', weight: 2,
		when: 'Placement or Action phase',
		desc: 'Build a wall on one edge of a hex you own. Blocks all movement and attacks across that edge (both ways). Cannot be placed on a river edge. Permanent.',
		playableIn: TURN,
		steps: [
			{ phase: 'wall_from', prompt: 'Wall: click one of your territories to build a wall on its edge.',
				check: (s, id) => s.states[id].owner !== s.current ? 'Build the wall on a hex you own.' : null },
			{ phase: 'wall_to', prompt: 'Wall: click an adjacent hex to seal that edge.',
				check: (s, id, from) => {
					if (id === from) return 'Pick a neighbouring hex to wall off.';
					if (!s.map.adj[from as number].includes(id) || s.map.grids[id].island !== s.map.grids[from as number].island)
						return 'Must be a bordering hex on the same island.';
					if (crossesRiver(s.map, from as number, id)) return 'That edge already has a river — build the wall elsewhere.';
					if (wallBetween(s.map, from as number, id)) return 'There is already a wall on that edge.';
					return null;
				} }
		],
		onResolve: (s, [from, to], idx) => {
			const lo = Math.min(from, to), hi = Math.max(from, to);
			if (!s.map.walls) s.map.walls = [];
			s.map.walls.push([lo, hi]);
			consumeCard(s, idx);
			log(s, `${PLAYER_NAMES[s.current]} built a wall between ${gridLabel(s, from)} and ${gridLabel(s, to)}.`, 'card');
			s.phase = 'action'; s.selectedFrom = null; s.selectedTo = null; s.message = 'Attack, move, or pass.';
		}
	}
];

const CARD_BY_ID = Object.fromEntries(CARD_DEFS.map((c) => [c.id, c])) as Record<CardType, CardDef>;

// phase → which card + step index handles it (for the generic selectGrid dispatch).
const PHASE_TO_STEP = {} as Partial<Record<Phase, { def: CardDef; stepIdx: number }>>;
for (const def of CARD_DEFS) {
	def.steps?.forEach((st, i) => { PHASE_TO_STEP[st.phase] = { def, stepIdx: i }; });
}

// Derived from the registry so there is a single source of truth.
export const CARD_LABELS = Object.fromEntries(
	CARD_DEFS.map((c) => [c.id, c.label])
) as Record<CardType, string>;

export const CARD_META = Object.fromEntries(
	CARD_DEFS.map((c) => [c.id, { icon: c.icon, kind: c.kind, when: c.when, desc: c.desc }])
) as Record<CardType, CardMeta>;

// Weighted draw pool expanded from each card's `weight`.
const CARD_POOL: CardType[] = CARD_DEFS.flatMap((c) => Array<CardType>(c.weight).fill(c.id));

// Display metadata for every card, in a form the native (iOS) client can read
// over the bridge so it never re-declares card labels/icons in Swift.
export function cardCatalog(): { id: CardType; label: string; icon: string; kind: string; when: string; desc: string }[] {
	return CARD_DEFS.map((c) => ({ id: c.id, label: c.label, icon: c.icon, kind: c.kind, when: c.when, desc: c.desc }));
}

// When the current phase is a card-selection step, whether `gridId` is a legal
// pick (shares the exact `check` the engine uses to validate). undefined means
// the current phase isn't a card step — callers fall back to core-phase rules.
export function cardSelectableAt(s: GameState, gridId: number): boolean | undefined {
	const step = PHASE_TO_STEP[s.phase];
	if (!step) return undefined;
	return step.def.steps![step.stepIdx].check(s, gridId, s.selectedFrom) === null;
}

// Whether the active player can currently select `gridId`, across BOTH card
// steps and the core attack/move/placement phases. This is the single authority
// the UI highlights from (web isSelectable and the bridge's selectableHexes).
export function isSelectableHex(s: GameState, gridId: number): boolean {
	const card = cardSelectableAt(s, gridId);
	if (card !== undefined) return card;
	const st = s.states[gridId];
	switch (s.phase) {
		case 'placing':
			return st.owner === s.current;
		case 'attack_select_from':
		case 'move_select_from':
			return st.owner === s.current && st.armies >= 2;
		case 'attack_select_to':
			return s.selectedFrom != null && s.map.adj[s.selectedFrom].includes(gridId)
				&& st.owner !== s.current && !wallBetween(s.map, s.selectedFrom, gridId);
		case 'move_select_to':
			return s.selectedFrom != null && s.map.adj[s.selectedFrom].includes(gridId)
				&& st.owner === s.current && !wallBetween(s.map, s.selectedFrom, gridId);
		default:
			return false;
	}
}

// All hexes the active player can select right now — the native client polls
// this to drive highlighting instead of reimplementing per-phase rules.
export function selectableHexes(s: GameState): number[] {
	const ids: number[] = [];
	for (const g of s.map.grids) if (isSelectableHex(s, g.id)) ids.push(g.id);
	return ids;
}

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
	| 'deforest_select'
	| 'oasis_select'
	| 'storm_from'
	| 'storm_to'
	| 'artillery_from'
	| 'artillery_to'
	| 'rampart_select'
	| 'wall_from'
	| 'wall_to'
	| 'discard'
	| 'game_over';

export interface GridState {
	owner: Player | null;
	armies: number;
	fortified?: boolean; // +2 defense from a Fortify card (persists until conquered)
	rampart?: boolean; // +1 defense from a Rampart card (persists until conquered)
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
	// Bridge card active — cancels the +1 river-crossing defender bonus for the
	// next attack. Consumed by the first attack roll.
	bridgeAttackActive: boolean;
	// Water Invasion card added a temporary sea lane for this attack. If the
	// attack succeeds it stays; if it fails, it's removed.
	pendingInvasionLane: [number, number] | null;
	// Whether the current player has already played a non-passive card this turn.
	cardPlayedThisTurn: boolean;
	// Grid IDs of marsh hexes that were used as an attack source this turn.
	// These can't be used as attack sources again until next turn.
	usedMarshHexes: number[];
	// True once the player has pressed "Start Game" — AI won't act until then.
	gameStarted: boolean;
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

export const SAVE_KEY = 'isle-wars-save-v12';
export const DEBUG_KEY = 'isle-wars-debug';

export interface DebugSettings {
	disableSave: boolean;
	starterCards: boolean; // give blue every card type on new games
	autoPlay: boolean; // AI takes over all four players
	dieSides: number; // base die max value; 10 by default
}

const DEFAULT_DIE_SIDES = 10;

function loadDebugSettings(): DebugSettings {
	const dflt: DebugSettings = {
		disableSave: false, starterCards: false, autoPlay: false, dieSides: DEFAULT_DIE_SIDES
	};
	if (typeof window === 'undefined') return dflt;
	try {
		const raw = localStorage.getItem(DEBUG_KEY);
		if (raw) {
			const parsed = JSON.parse(raw) as DebugSettings;
			const sides = Math.round(Number(parsed.dieSides));
			return {
				disableSave: !!parsed.disableSave,
				starterCards: !!parsed.starterCards,
				autoPlay: !!parsed.autoPlay,
				dieSides: sides >= 2 && sides <= 100 ? sides : DEFAULT_DIE_SIDES
			};
		}
	} catch { /* ignore */ }
	return dflt;
}

export function rollDie(): number {
	return 1 + Math.floor(Math.random() * debugSettings.dieSides);
}
export function dieSides(): number {
	return debugSettings.dieSides;
}

let debugSettings: DebugSettings = loadDebugSettings();

// Hoisted here (before startGame runs at module load) so the dev logger's
// module-init call to devLogGameStart doesn't hit a TDZ error.
let devLogGameId: string | null = null;
const TERRAIN_IDX: Record<string, number> = { plain: 0, mountain: 1, forest: 2, marsh: 3 };
const PLAYER_IDX: Record<Player, number> = { blue: 0, green: 1, red: 2, brown: 3 };

export function getDebugSettings(): DebugSettings {
	return { ...debugSettings };
}

export function updateDebugSettings(patch: Partial<DebugSettings>) {
	const prevSides = debugSettings.dieSides;
	debugSettings = { ...debugSettings, ...patch };
	if (typeof window !== 'undefined') {
		try { localStorage.setItem(DEBUG_KEY, JSON.stringify(debugSettings)); } catch { /* ignore */ }
	}
	if (debugSettings.dieSides !== prevSides) {
		WIN_PROB_CACHE.clear();
	}
	// If save was just disabled, wipe any existing save so a reload gets a
	// fresh map immediately.
	if (patch.disableSave === true) {
		if (typeof window !== 'undefined') {
			try { localStorage.removeItem(SAVE_KEY); } catch { /* ignore */ }
		}
	}
}

export const game = writable<GameState>(startGame(2, 3));

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
	if (!debugSettings.disableSave) {
		try {
			const raw = localStorage.getItem(SAVE_KEY);
			if (raw) {
				const parsed = JSON.parse(raw) as GameState;
				// A save from before "Start Game" was pressed is just the initial
				// map preview — reloading at that point should regenerate a fresh
				// map instead of restoring the same one.
				if (parsed && parsed.map && Array.isArray(parsed.map.grids) && parsed.gameStarted) {
					game.set(parsed);
					loaded = true;
				}
			}
		} catch { /* corrupt / privacy mode */ }
	}
	persistenceInitialized = true;
	// Auto-save subscription is always registered but only writes if enabled.
	game.subscribe((s) => {
		if (debugSettings.disableSave) return;
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
	const sides = debugSettings.dieSides;
	let wins = 0;
	for (let atk = 1; atk <= sides; atk++) {
		for (let def = 1; def <= sides; def++) {
			if (atk + netModifier > def) wins++;
		}
	}
	return wins / (sides * sides);
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

/** Extra defender bonus from what the attacker had to cross: +2 for a sea
 *  lane, +1 for a river, 0 otherwise. Ignored for ranged/artillery attacks. */
export function crossingDefenseBonus(s: GameState, fromId: number, toId: number): number {
	// A Water Invasion crosses open sea over a temporary lane, storming the
	// beach before the defenders dig in — only +1, not the +2 an established
	// sea lane grants. Checked first because the invasion also pushes its lane
	// into `seaLanes` for the duration of the attack.
	const inv = s.pendingInvasionLane;
	if (inv && ((inv[0] === fromId && inv[1] === toId) || (inv[0] === toId && inv[1] === fromId))) {
		return 1;
	}
	for (const [a, b] of s.map.seaLanes) {
		if ((a === fromId && b === toId) || (a === toId && b === fromId)) return 2;
	}
	if (crossesRiver(s.map, fromId, toId)) return s.bridgeAttackActive ? 0 : 1;
	return 0;
}

/** Defense bonus for a hex: mountain terrain (+1) + fortification (+2) +
 *  crossing bonus (sea lane +2 / river +1) when a from hex is supplied. */
export function defenseBonus(s: GameState, gridId: number, fromId?: number): number {
	let b = 0;
	if (s.map.grids[gridId].terrain === 'mountain') b += 1;
	if (s.states[gridId].fortified) b += 2;
	if (s.states[gridId].rampart) b += 1;
	if (fromId != null) b += crossingDefenseBonus(s, fromId, gridId);
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
	const blueStart: CardType[] = debugSettings.starterCards
		? (Object.keys(CARD_LABELS) as CardType[])
		: [];
	return { blue: blueStart, green: [], red: [], brown: [] };
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

	// Distribute grids evenly — every player gets exactly floor(n/4)
	// territories with the same starting armies. Any leftover hexes stay
	// neutral so no player has a size advantage on turn 1. Difficulty no
	// longer skews the initial map; it just changes how aggressively the
	// AI plays (see ai.ts).
	const rand = mulberry32(s ^ 0xa5a5a5);
	const ids = shuffle(map.grids.map((g) => g.id), rand);
	const perPlayer = Math.floor(ids.length / PLAYERS.length);
	const claimed = perPlayer * PLAYERS.length;
	for (let i = 0; i < claimed; i++) {
		const owner = PLAYERS[i % PLAYERS.length];
		states[ids[i]] = { owner, armies: startingArmies };
	}
	for (let i = claimed; i < ids.length; i++) {
		states[ids[i]] = { owner: null, armies: 0 };
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
		bridgeAttackActive: false,
		pendingInvasionLane: null,
		cardPlayedThisTurn: false,
		usedMarshHexes: [],
		gameStarted: false,
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
	const ready = beginTurn(state);
	devLogGameStart(ready);
	return ready;
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
	const entry: LogEntry = { turn: s.turn, player, text, kind };
	s.log = [entry, ...s.log].slice(0, 100);
}

// ---------------------------------------------------------------------------
// Dev-only ML training logger. Emits JSONL events to /tmp/isle-wars-events.jsonl
// via Vite's dev middleware. Structured for easy ingestion into training
// pipelines (one JSON object per line).
//
// Event types:
//   { type: 'game_start', game_id, seed, difficulty, players, map }
//   { type: 'action',     game_id, turn, actor, phase, action, state_before }
//   { type: 'attack_result', game_id, turn, actor, from, to, dice, conquered, ...}
//   { type: 'event',      game_id, turn, event_type, details }
//   { type: 'game_end',   game_id, turn, winner, final_stats, per_player_summary }
//
// `state_before` snapshots the fields most useful for RL/supervised learning:
//   grid_owners: number[]  // player index 0..3 or -1 for neutral
//   grid_armies: number[]
//   grid_terrain: number[] // 0 plain, 1 mountain, 2 forest, 3 marsh
//   grid_fortified: number[] // 0/1
//   grid_production: number[] // 0/1
//   sea_lanes: [number, number][]
//   hands: Record<Player, string[]> // card types in each hand
//   scores: Record<Player, {territories, armies, alive}>
//   current: Player
//   phase: Phase
//   armies_to_place: number
// ---------------------------------------------------------------------------

function devLog(payload: object) {
	if (typeof window === 'undefined') return;
	if (!import.meta.env.DEV) return;
	try {
		void fetch('/api/log', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify(payload)
		}).catch(() => { /* network errors ignored */ });
	} catch { /* ignore */ }
}

function snapshotState(s: GameState) {
	const grid_owners: number[] = [];
	const grid_armies: number[] = [];
	const grid_terrain: number[] = [];
	const grid_fortified: number[] = [];
	const grid_production: number[] = [];
	for (const g of s.map.grids) {
		const st = s.states[g.id];
		grid_owners.push(st.owner ? PLAYER_IDX[st.owner] : -1);
		grid_armies.push(st.armies);
		grid_terrain.push(TERRAIN_IDX[g.terrain] ?? 0);
		grid_fortified.push(st.fortified ? 1 : 0);
		grid_production.push(g.production ? 1 : 0);
	}
	const scores: Record<Player, { territories: number; armies: number; alive: boolean }> =
		{ blue: { territories: 0, armies: 0, alive: s.alive.blue },
		  green: { territories: 0, armies: 0, alive: s.alive.green },
		  red: { territories: 0, armies: 0, alive: s.alive.red },
		  brown: { territories: 0, armies: 0, alive: s.alive.brown } };
	for (const st of s.states) {
		if (!st.owner) continue;
		scores[st.owner].territories++;
		scores[st.owner].armies += st.armies;
	}
	return {
		grid_owners,
		grid_armies,
		grid_terrain,
		grid_fortified,
		grid_production,
		sea_lanes: s.map.seaLanes,
		hands: s.hands,
		scores,
		current: s.current,
		phase: s.phase,
		armies_to_place: s.armiesToPlace,
		card_played_this_turn: s.cardPlayedThisTurn,
		last_attack_result: s.lastAttackResult
	};
}

/** Emit a game-lifecycle event to the dev log. Meant to be called from
 * game-state actions (place/attack/move/card/turn-boundary). */
export function devLogAction(actor: Player, action: object, s: GameState) {
	if (!devLogGameId) return;
	devLog({
		type: 'action',
		game_id: devLogGameId,
		turn: s.turn,
		actor,
		phase: s.phase,
		action,
		state_before: snapshotState(s)
	});
}

function devLogGameStart(s: GameState) {
	devLogGameId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
	if (!import.meta.env.DEV) return;
	devLog({
		type: 'game_start',
		game_id: devLogGameId,
		seed: s.seed,
		difficulty: s.difficulty,
		players: PLAYERS,
		map: {
			width: s.map.width,
			height: s.map.height,
			islands: s.map.islands.map((i) => ({ id: i.id, name: i.name, value: i.value })),
			grids: s.map.grids.map((g) => ({
				id: g.id,
				island: g.island,
				terrain: g.terrain,
				production: g.production,
				city: g.cityName ?? null
			})),
			adj: s.map.adj,
			sea_lanes_initial: s.map.seaLanes
		},
		initial_state: snapshotState(s)
	});
}

function devLogGameEnd(s: GameState) {
	if (!devLogGameId) return;
	devLog({
		type: 'game_end',
		game_id: devLogGameId,
		turn: s.turn,
		winner: s.winner,
		final_state: snapshotState(s),
		stats: s.stats
	});
	devLogGameId = null;
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
	s.bridgeAttackActive = false;
	s.pendingInvasionLane = null;
	s.cardPlayedThisTurn = false;
	s.usedMarshHexes = [];
	s.doubleActive = false;
	s.selectedFrom = null;
	s.selectedTo = null;
	s.pendingArmies = 0;

	// Random world event 25% chance (skip on turn 1)
	if (s.turn > 1 && Math.random() < 0.25) {
		applyRandomEvent(s);
		if (s.winner) return s;
	}

	// Production centers grow at ~10% chance per turn. To prevent exponential
	// runaway on long games, the doubling is capped: a hex only doubles up to
	// the PROD_CAP threshold, beyond which it grows by a fixed additive bonus.
	if (Math.random() < 0.1) {
		const PROD_CAP = 40;
		const PROD_ADD = 8;
		let touched = 0;
		for (const g of s.map.grids) {
			if (!g.production || !s.states[g.id].owner) continue;
			const cur = s.states[g.id].armies;
			if (cur < PROD_CAP) {
				s.states[g.id].armies = Math.min(PROD_CAP, cur * 2);
			} else {
				s.states[g.id].armies = cur + PROD_ADD;
			}
			touched++;
		}
		if (touched > 0) log(s, `Production centers active! ${touched} grids boosted.`, 'event', null);
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
	for (const p of PLAYERS) {
		if (countryCount(s, p) === s.map.grids.length) {
			s.winner = p;
			s.phase = 'game_over';
			log(s, `${PLAYER_NAMES[p]} has conquered the world!`, 'defeat', null);
			devLogGameEnd(s);
			return true;
		}
	}
	if (alivePlayers.length === 1) {
		s.winner = alivePlayers[0];
		s.phase = 'game_over';
		log(s, `${PLAYER_NAMES[alivePlayers[0]]} is the last army standing!`, 'defeat', null);
		devLogGameEnd(s);
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
	const r = Math.random();
	const eventType =
		r < 0.32 ? 'earthquake' :
		r < 0.64 ? 'flood' :
		r < 0.95 ? 'rebellion' :
		'rebels_flip';
	devLog({ type: 'random_event', game_id: devLogGameId, turn: s.turn, event_type: eventType });
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
	const shuffled = shuffle(s.map.grids.map((g) => g.id), Math.random);
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
		devLogAction(s.current, { kind: 'place', grid: gridId, qty: q }, s);
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
		devLogAction(s.current, { kind: 'end_turn' }, s);
		// Card rule (per user spec): card at end of every round, UNLESS your
		// turn ends on a battle loss. i.e. it's the OUTCOME of your final
		// attack that matters — earlier wins don't rescue a losing finish.
		const endedOnLoss = s.lastAttackResult === 'loss';
		const shouldAward = !endedOnLoss && !s.turnCardAwarded;
		if (shouldAward) {
			const card = drawCard(s);
			if (card) {
				s.hands[s.current] = [...s.hands[s.current], card];
				log(s, `${PLAYER_NAMES[s.current]} drew a ${CARD_LABELS[card]} card.`, 'card');
				s.turnCardAwarded = true;
				// If the human is over the hand limit, pause for them to pick a
				// discard. In auto-play mode, blue is AI-controlled — skip the pause
				// and auto-discard the oldest card(s).
				if (s.current === 'blue' && s.hands.blue.length > HAND_MAX && !debugSettings.autoPlay) {
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
		// Registry-driven card-target selection: when the current phase is one of
		// a card's SelectSteps, validate the pick with that step's `check`, then
		// advance to the next step or resolve the card. Core attack/move selection
		// stays in the switch below.
		const step = PHASE_TO_STEP[s.phase];
		if (step) {
			const { def, stepIdx } = step;
			const err = def.steps![stepIdx].check(s, gridId, s.selectedFrom);
			if (err) { s.message = err; return s; }
			if (stepIdx < def.steps!.length - 1) {
				s.selectedFrom = gridId;
				const next = def.steps![stepIdx + 1];
				s.phase = next.phase;
				s.message = next.prompt;
				return s;
			}
			const picks = def.steps!.length === 1 ? [gridId] : [s.selectedFrom as number, gridId];
			def.onResolve!(s, picks, (s as any)._pendingCardIdx as number);
			return s;
		}
		switch (s.phase) {
			case 'attack_select_from': {
				if (s.states[gridId].owner !== s.current) { s.message = 'Choose your own territory.'; break; }
				if (s.states[gridId].armies < 2) { s.message = 'Need at least 2 armies to attack.'; break; }
				if (s.usedMarshHexes.includes(gridId)) {
					s.message = 'Marsh already used this turn — troops are still mired.';
					break;
				}
				s.selectedFrom = gridId;
				s.phase = 'attack_select_to';
				s.message = 'Select an ADJACENT enemy territory.';
				break;
			}
			case 'attack_select_to': {
				if (s.selectedFrom == null) break;
				if (!s.map.adj[s.selectedFrom].includes(gridId)) { s.message = 'Not adjacent.'; break; }
				if (wallBetween(s.map, s.selectedFrom, gridId)) { s.message = 'A wall blocks that edge.'; break; }
				if (s.states[gridId].owner === s.current) { s.message = 'Choose an enemy or neutral territory.'; break; }
				devLogAction(s.current, { kind: 'attack_begin', from: s.selectedFrom, to: gridId }, s);
				s.selectedTo = gridId;
				// Empty target (typically neutral, 0 armies): walk right in, no
				// dice roll. Jumps straight to the move-in modal.
				if (s.states[gridId].armies <= 0) {
					autoConquer(s, s.selectedFrom, gridId);
					break;
				}
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
				s.message = 'Choose an adjacent friendly territory. Moving ends your turn.';
				break;
			}
			case 'move_select_to': {
				if (s.selectedFrom == null) break;
				if (!s.map.adj[s.selectedFrom].includes(gridId)) { s.message = 'Not adjacent.'; break; }
				if (wallBetween(s.map, s.selectedFrom, gridId)) { s.message = 'A wall blocks that edge.'; break; }
				if (s.states[gridId].owner !== s.current) { s.message = 'Must be your territory.'; break; }
				s.selectedTo = gridId;
				s.pendingArmies = 1;
				s.phase = 'move_qty';
				s.message = 'Choose how many to move, then confirm. Moving ends your turn.';
				break;
			}
		}
		return s;
	});
}

// Walk into an undefended target with no dice roll. Handles the same book-
// keeping the rollAttack conquest branch does (ownership, stats, elite/bridge
// consumption, desert attrition, move-in phase).
function autoConquer(s: GameState, fromId: number, toId: number): void {
	const from = s.states[fromId];
	const to = s.states[toId];
	const attacker = from.owner!;
	const defender = to.owner; // typically null
	to.owner = attacker;
	to.fortified = false;
	to.rampart = false;
	s.stats[attacker].territoriesCaptured++;
	if (defender) s.stats[defender].territoriesLost++;
	s.defeatedThisTurn = true;
	s.lastAttackResult = 'win';
	s.eliteAttackActive = false;
	s.bridgeAttackActive = false;
	s.pendingInvasionLane = null;
	log(s, `${PLAYER_NAMES[attacker]} walked into ${gridLabel(s, toId)} unopposed.`, 'defeat');
	// Walking in unopposed still counts as launching an attack from a marsh.
	if (s.map.grids[fromId].terrain === 'marsh' && !s.usedMarshHexes.includes(fromId)) {
		s.usedMarshHexes.push(fromId);
	}
	from.armies -= 1;
	to.armies = 1;
	if (s.map.grids[toId].terrain === 'desert' && from.armies > 1) {
		from.armies -= 1;
		log(s, `Desert heat cost ${PLAYER_NAMES[attacker]} 1 army entering ${gridLabel(s, toId)}.`, 'attack');
	}
	updateAlive(s);
	if (checkWin(s)) return;
	if (from.armies > 0) {
		s.phase = 'attack_move_in';
		s.pendingArmies = 0;
		s.message = `Move additional armies from ${gridLabel(s, fromId)} to ${gridLabel(s, toId)}? (0 to ${from.armies})`;
	} else {
		s.phase = 'action';
		s.selectedFrom = null;
		s.selectedTo = null;
		s.message = 'Attack, move, or pass.';
	}
}

// Perform an attack roll.
export function rollAttack(): void {
	game.update((s) => {
		if (s.phase !== 'attack_rolling') return s;
		if (s.selectedFrom == null || s.selectedTo == null) return s;
		const from = s.states[s.selectedFrom];
		const to = s.states[s.selectedTo];
		// Mark marsh source as used for this turn — can't launch a second attack from it.
		if (s.map.grids[s.selectedFrom].terrain === 'marsh' && !s.usedMarshHexes.includes(s.selectedFrom)) {
			s.usedMarshHexes.push(s.selectedFrom);
		}
		const atkBase = rollDie();
		const defBase = rollDie();
		const defBonus = defenseBonus(s, s.selectedTo, s.selectedFrom);
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
		if (s.states[s.selectedTo].rampart) defMods.push('+1 rampart');
		const defTxt = defMods.length ? `${def} (${defMods.join(', ')})` : `${def}`;
		devLog({
			type: 'attack_roll',
			game_id: devLogGameId,
			turn: s.turn,
			actor: attacker,
			from: s.selectedFrom,
			to: s.selectedTo,
			attacker_armies_before: from.armies,
			defender_armies_before: to.armies,
			dice_atk: atk,
			dice_def: def,
			atk_bonus: atkBonus,
			def_bonus: defBonus,
			elite_bonus: eliteBonus,
			defender: defender
		});
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
			to.rampart = false;
			s.stats[attacker].territoriesCaptured++;
			if (defender) s.stats[defender].territoriesLost++;
			s.defeatedThisTurn = true;
			s.lastAttackResult = 'win';
			// Elite Troops was consumed by this successful attack.
			s.eliteAttackActive = false;
			s.bridgeAttackActive = false;
			// Water Invasion succeeded — the sea lane stays permanent.
			s.pendingInvasionLane = null;
			log(s, `${PLAYER_NAMES[from.owner!]} conquered ${gridLabel(s, s.selectedTo)}!`, 'defeat');
			// move at least 1 in
			from.armies -= 1;
			to.armies = 1;
			// Desert attrition: attackers moving into a desert lose 1 more army
			// to the heat. Applied against the source (follow-on force), but
			// never below 1 — a hex must always keep a garrison.
			if (s.map.grids[s.selectedTo].terrain === 'desert' && from.armies > 1) {
				from.armies -= 1;
				log(s, `Desert heat cost ${PLAYER_NAMES[from.owner!]} 1 army entering ${gridLabel(s, s.selectedTo)}.`, 'attack');
			}
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
			s.eliteAttackActive = false;
			s.bridgeAttackActive = false; // consumed regardless of outcome
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
		devLogAction(s.current, { kind: 'move', from: s.selectedFrom, to: s.selectedTo, qty: q }, s);
		from.armies -= q;
		to.armies += q;
		log(s, `${PLAYER_NAMES[s.current]} moved ${q} from ${gridLabel(s, s.selectedFrom)} to ${gridLabel(s, s.selectedTo)}.`, 'info');
		// Desert heat attrition: moving armies into a desert costs 1 army.
		if (s.map.grids[s.selectedTo].terrain === 'desert' && to.armies > 0) {
			to.armies -= 1;
			log(s, `Desert heat cost ${PLAYER_NAMES[s.current]} 1 army at ${gridLabel(s, s.selectedTo)}.`, 'info');
		}
		s.phase = 'action';
		s.selectedFrom = null;
		s.selectedTo = null;
		// per manual, move ends the turn
		return advanceTurn(s);
	});
}

// -- Card actions --
function consumeCard(s: GameState, idx: number) {
	s.hands[s.current] = s.hands[s.current].filter((_, i) => i !== idx);
	s.cardPlayedThisTurn = true;
	s.stats[s.current].cardsPlayed++;
	// Any pending selection is finished once the card is consumed.
	delete (s as any)._pendingCardIdx;
}

export function playCard(idx: number) {
	game.update((s) => {
		const hand = s.hands[s.current];
		const card = hand[idx];
		if (!card) return s;
		// One-card-per-turn rule (excluding passives).
		if (s.cardPlayedThisTurn && card !== 'antibomb') {
			s.message = 'Only one card per turn.';
			return s;
		}
		devLogAction(s.current, { kind: 'play_card', card, index: idx }, s);
		const def = CARD_BY_ID[card];
		if (def.passive) {
			// Antibomb and friends work automatically; there's nothing to activate.
			s.message = 'Anti-Bomb is passive — it protects automatically.';
			return s;
		}
		if (!def.playableIn.includes(s.phase)) {
			s.message = `You can't play ${def.label} right now.`;
			return s;
		}
		if (def.onPlay) {
			// Immediate card (boosters, flag-setters) — applies now.
			def.onPlay(s, idx);
			return s;
		}
		// Targeting card: stash the hand index and enter its first selection step.
		// selectGrid() drives the rest via the registry (see PHASE_TO_STEP).
		(s as any)._pendingCardIdx = idx;
		s.selectedFrom = null;
		s.selectedTo = null;
		const first = def.steps![0];
		s.phase = first.phase;
		s.message = first.prompt;
		return s;
	});
}

// BFS distance in the current adjacency graph up to `maxSteps`. Returns
// Infinity if unreachable within the cap.
function graphDist(s: GameState, from: number, to: number, maxSteps: number): number {
	if (from === to) return 0;
	const dist = new Map<number, number>();
	dist.set(from, 0);
	const queue: number[] = [from];
	while (queue.length) {
		const cur = queue.shift()!;
		const d = dist.get(cur)!;
		if (d >= maxSteps) continue;
		for (const n of s.map.adj[cur]) {
			if (dist.has(n)) continue;
			dist.set(n, d + 1);
			if (n === to) return d + 1;
			queue.push(n);
		}
	}
	return Infinity;
}

/** Returns true if `to` is within 2 hops of `from` and eligible as an
 * artillery target (enemy or neutral, not the source hex). */
export function canArtilleryTarget(s: GameState, from: number, to: number): boolean {
	if (from === to) return false;
	if (s.states[to].owner === s.current) return false;
	return graphDist(s, from, to, 2) <= 2;
}

function resolveBomb(s: GameState, targetId: number, idx: number) {
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
	consumeCard(s, idx);
	s.phase = 'action';
	s.selectedFrom = null;
	updateAlive(s);
	checkWin(s);
}

function resolveArtillery(s: GameState, fromId: number, toId: number, idx: number) {
	const target = s.states[toId];
	const defenderBefore = target.armies;
	const defBonus = defenseBonus(s, toId);
	const forestBonus = attackerBonus(s, toId); // forest cover helps attacker even here
	let hits = 0;
	const ARTILLERY_SHOTS = 4;
	for (let shot = 1; shot <= ARTILLERY_SHOTS && target.armies > 0; shot++) {
		const atk = rollDie() + forestBonus;
		const def = rollDie() + defBonus;
		devLog({
			type: 'artillery_shot',
			game_id: devLogGameId,
			turn: s.turn,
			actor: s.current,
			from: fromId,
			to: toId,
			shot,
			dice_atk: atk,
			dice_def: def,
			atk_bonus: forestBonus,
			def_bonus: defBonus,
			hit: atk > def
		});
		if (atk > def) {
			target.armies -= 1;
			hits++;
		}
	}
	let ownershipMsg = '';
	if (target.armies <= 0) {
		// Target reduced to zero — becomes neutral (artillery doesn't itself
		// take the hex, only damages it).
		target.owner = null;
		target.armies = 0;
		target.fortified = false;
		target.rampart = false;
		ownershipMsg = ' Territory abandoned.';
	}
	consumeCard(s, idx);
	const modTxt: string[] = [];
	if (defBonus > 0) modTxt.push(`+${defBonus} def`);
	if (forestBonus > 0) modTxt.push(`+${forestBonus} atk`);
	const modStr = modTxt.length ? ` (${modTxt.join(', ')})` : '';
	log(s, `${PLAYER_NAMES[s.current]} shelled ${gridLabel(s, toId)}: ${hits}/${ARTILLERY_SHOTS} hits${modStr}, ${defenderBefore} → ${target.armies} armies.${ownershipMsg}`, 'card');
	updateAlive(s);
	const gameOver = checkWin(s);
	if (!gameOver) {
		s.phase = 'action';
		s.selectedFrom = null;
		s.selectedTo = null;
		s.message = 'Attack, move, or pass.';
	}
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
			consumeCard(s, idx);
			delete (s as any)._pendingCardIdx;
		}
		log(s, `${PLAYER_NAMES[s.current]} air-moved ${q} from ${gridLabel(s, s.selectedFrom)} to ${gridLabel(s, s.selectedTo)}.`, 'card');
		if (s.map.grids[s.selectedTo].terrain === 'desert' && to.armies > 0) {
			to.armies -= 1;
			log(s, `Desert heat cost ${PLAYER_NAMES[s.current]} 1 army at ${gridLabel(s, s.selectedTo)}.`, 'card');
		}
		s.phase = 'action';
		s.selectedFrom = null;
		s.selectedTo = null;
		return s;
	});
}

export function startGamePlaying() {
	game.update((s) => { s.gameStarted = true; return s; });
}

/** Force the current player's turn to end even if they have no territories left
 * or are stuck in a phase they can't act on. Used by the AI to keep an
 * auto-play game moving after a player is eliminated. */
export function forceEndTurn() {
	game.update((s) => {
		if (s.phase === 'game_over') return s;
		s.phase = 'action';
		s.selectedFrom = null;
		s.selectedTo = null;
		return advanceTurn(s);
	});
}

export function newGame(difficulty: number, startingArmies: number, seed?: number) {
	game.set(startGame(difficulty, startingArmies, seed));
}

// Derived
export const currentState = derived(game, ($g) => $g);
