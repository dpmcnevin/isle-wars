// The card registry: the single source of truth for every card's display
// metadata, draw-pool weight, and behaviour. Adding a card is normally one
// entry in CARD_DEFS (+ its name in the CardType union, and any new phase names
// in the Phase union, both in game.ts). See docs/CARDS.md.
//
// This module and game.ts import from each other: the card closures below call
// game.ts helpers (consumeCard, log, resolveBomb, …) and game.ts's dispatch
// imports the registry. That cycle is safe because the closures only *call*
// those helpers at runtime, never at module-load, and ES modules finish
// evaluating this module before game.ts's own body runs.
import { crossesRiver, wallBetween } from './map';
import {
	PLAYER_NAMES,
	consumeCard,
	log,
	gridLabel,
	resolveBomb,
	resolveArtillery,
	canFerryConnect,
	canInvasionConnect,
	canArtilleryTarget,
	type CardType,
	type Phase,
	type GameState
} from './game';

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

export const CARD_BY_ID = Object.fromEntries(CARD_DEFS.map((c) => [c.id, c])) as Record<CardType, CardDef>;

// phase → which card + step index handles it (for the generic selectGrid dispatch).
export const PHASE_TO_STEP = {} as Partial<Record<Phase, { def: CardDef; stepIdx: number }>>;
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
export const CARD_POOL: CardType[] = CARD_DEFS.flatMap((c) => Array<CardType>(c.weight).fill(c.id));

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
