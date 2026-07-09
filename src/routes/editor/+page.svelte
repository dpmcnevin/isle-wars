<script lang="ts">
	import { SvelteMap, SvelteSet } from 'svelte/reactivity';
	import { goto } from '$app/navigation';
	import {
		buildHexGrid,
		hexNeighbors,
		buildCustomMap,
		CUSTOM_MAP_CANVAS,
		type Hex,
		type Terrain,
		type CustomMapHexInput,
		type CustomMapEdgeInput
	} from '$lib/map';
	import {
		PLAYERS,
		PLAYER_COLORS,
		PLAYER_NAMES,
		newGameFromMap,
		type Player,
		type CustomMapPlacement
	} from '$lib/game';

	// Same canvas as buildCustomMap and the packed CUSTOM- seed format — the
	// seed addresses cells by index into this exact grid, so they must agree.
	const S = CUSTOM_MAP_CANVAS.s;
	const W = CUSTOM_MAP_CANVAS.width;
	const H = CUSTOM_MAP_CANVAS.height;
	const hexGrid: Hex[][] = buildHexGrid(W, H, S);

	const key = (c: number, r: number) => `${c},${r}`;
	const edgeKey = (a: string, b: string) => (a < b ? `${a}|${b}` : `${b}|${a}`);

	interface LandHex {
		terrain: Terrain;
		production: boolean;
	}
	interface Placement {
		owner: Player;
		armies: number;
	}

	const land = new SvelteMap<string, LandHex>();
	const owners = new SvelteMap<string, Placement>();
	const rivers = new SvelteSet<string>();
	const walls = new SvelteSet<string>();

	type Tool =
		| { kind: 'terrain'; terrain: Terrain }
		| { kind: 'city' }
		| { kind: 'owner'; owner: Player | null }
		| { kind: 'river' }
		| { kind: 'wall' }
		| { kind: 'erase' };

	let tool = $state<Tool>({ kind: 'terrain', terrain: 'plain' });
	let armyValue = $state(3);
	let edgeAnchor = $state<string | null>(null);
	let mapName = $state('');
	let statusMessage = $state('');
	let difficulty = $state(2);
	let startingArmies = $state(3);

	const TERRAIN_COLORS: Record<Terrain, string> = {
		plain: '#3a4a5a',
		mountain: '#6b6b6b',
		forest: '#2f5c3a',
		marsh: '#3a5a4a',
		desert: '#b89a5a'
	};
	const WATER_COLOR = '#0e2a48';

	function removeEdgesFor(k: string) {
		for (const e of [...rivers]) if (e.startsWith(k + '|') || e.endsWith('|' + k)) rivers.delete(e);
		for (const e of [...walls]) if (e.startsWith(k + '|') || e.endsWith('|' + k)) walls.delete(e);
	}

	function clickHex(c: number, r: number) {
		const k = key(c, r);
		statusMessage = '';
		if (tool.kind === 'erase') {
			land.delete(k);
			owners.delete(k);
			removeEdgesFor(k);
			if (edgeAnchor === k) edgeAnchor = null;
			return;
		}
		if (tool.kind === 'terrain') {
			const existing = land.get(k);
			land.set(k, { terrain: tool.terrain, production: existing?.production ?? false });
			return;
		}
		if (tool.kind === 'city') {
			const existing = land.get(k);
			if (!existing) return;
			land.set(k, { ...existing, production: !existing.production });
			return;
		}
		if (tool.kind === 'owner') {
			if (!land.has(k)) return;
			if (tool.owner === null) owners.delete(k);
			else owners.set(k, { owner: tool.owner, armies: Math.max(1, Math.round(armyValue)) });
			return;
		}
		if (tool.kind === 'river' || tool.kind === 'wall') {
			if (!land.has(k)) return;
			if (edgeAnchor === null) {
				edgeAnchor = k;
				return;
			}
			if (edgeAnchor === k) {
				edgeAnchor = null;
				return;
			}
			const [ac, ar] = edgeAnchor.split(',').map(Number);
			const isNeighbor = hexNeighbors(ac, ar).some(([nc, nr]) => key(nc, nr) === k);
			if (!isNeighbor || !land.has(edgeAnchor)) {
				edgeAnchor = land.has(k) ? k : null;
				return;
			}
			const set = tool.kind === 'river' ? rivers : walls;
			const ek = edgeKey(edgeAnchor, k);
			if (set.has(ek)) set.delete(ek);
			else set.add(ek);
			edgeAnchor = null;
			return;
		}
	}

	const vkey = (v: [number, number]) => `${Math.round(v[0] * 10)},${Math.round(v[1] * 10)}`;

	// River/wall edges are drawn as the short segment straddling the two
	// vertices the hexes have in common (same approach as the main board's
	// wallSegmentsFor), not a line between hex centers — a center-to-center
	// line cuts across whichever unrelated hexes happen to sit between them.
	function edgeLine(ek: string): { x1: number; y1: number; x2: number; y2: number } | null {
		const [a, b] = ek.split('|');
		const [ac, ar] = a.split(',').map(Number);
		const [bc, br] = b.split(',').map(Number);
		const ha = hexGrid[ar]?.[ac];
		const hb = hexGrid[br]?.[bc];
		if (!ha || !hb) return null;
		const bKeys = new Set(hb.poly.map(vkey));
		const shared = ha.poly.filter((v) => bKeys.has(vkey(v)));
		if (shared.length !== 2) return null;
		return { x1: shared[0][0], y1: shared[0][1], x2: shared[1][0], y2: shared[1][1] };
	}

	// Build the ordered hex-input list the same way every time: iteration order
	// of the `land` map. `buildCustomMap`'s output grid ids follow this same
	// order 1:1, so owner placements can be computed by index without a
	// separate col/row -> grid-id lookup.
	function orderedHexInputs(): { key: string; input: CustomMapHexInput }[] {
		return [...land.entries()].map(([k, h]) => {
			const [c, r] = k.split(',').map(Number);
			return { key: k, input: { col: c, row: r, terrain: h.terrain, production: h.production } };
		});
	}

	function edgeInputs(set: SvelteSet<string>): CustomMapEdgeInput[] {
		const out: CustomMapEdgeInput[] = [];
		for (const ek of set) {
			const [a, b] = ek.split('|');
			const [ac, ar] = a.split(',').map(Number);
			const [bc, br] = b.split(',').map(Number);
			out.push({ a: [ac, ar], b: [bc, br] });
		}
		return out;
	}

	function validate(): string | null {
		if (land.size === 0) return 'Paint at least a few hexes of land first.';
		for (const p of PLAYERS) {
			const has = [...owners.values()].some((v) => v.owner === p);
			if (!has) return `${PLAYER_NAMES[p]} has no starting hex — assign at least one.`;
		}
		return null;
	}

	function buildMapAndPlacements() {
		const ordered = orderedHexInputs();
		const hexes = ordered.map((o) => o.input);
		const map = buildCustomMap(hexes, edgeInputs(rivers), edgeInputs(walls));
		const placements: CustomMapPlacement[] = [];
		ordered.forEach((o, idx) => {
			const p = owners.get(o.key);
			if (p) placements.push({ grid: idx, owner: p.owner, armies: p.armies });
		});
		return { map, placements };
	}

	function play() {
		const err = validate();
		if (err) {
			statusMessage = err;
			return;
		}
		const { map, placements } = buildMapAndPlacements();
		newGameFromMap(map, placements, difficulty, startingArmies);
		goto('/');
	}

	const STORAGE_KEY = 'isle-wars-custom-maps-v1';

	interface SavedMap {
		hexes: CustomMapHexInput[];
		rivers: CustomMapEdgeInput[];
		walls: CustomMapEdgeInput[];
		placements: { index: number; owner: Player; armies: number }[];
		difficulty: number;
		startingArmies: number;
	}

	function loadSavedMaps(): Record<string, SavedMap> {
		try {
			const raw = localStorage.getItem(STORAGE_KEY);
			return raw ? JSON.parse(raw) : {};
		} catch {
			return {};
		}
	}

	let savedMaps = $state<Record<string, SavedMap>>(loadSavedMaps());
	let selectedSaved = $state('');

	function saveMap() {
		const name = mapName.trim();
		if (!name) {
			statusMessage = 'Name your map before saving.';
			return;
		}
		const ordered = orderedHexInputs();
		const placements: SavedMap['placements'] = [];
		ordered.forEach((o, idx) => {
			const p = owners.get(o.key);
			if (p) placements.push({ index: idx, owner: p.owner, armies: p.armies });
		});
		const entry: SavedMap = {
			hexes: ordered.map((o) => o.input),
			rivers: edgeInputs(rivers),
			walls: edgeInputs(walls),
			placements,
			difficulty,
			startingArmies
		};
		const all = loadSavedMaps();
		all[name] = entry;
		localStorage.setItem(STORAGE_KEY, JSON.stringify(all));
		savedMaps = all;
		selectedSaved = name;
		statusMessage = `Saved "${name}".`;
	}

	function loadMap(name: string) {
		const entry = loadSavedMaps()[name];
		if (!entry) return;
		land.clear();
		owners.clear();
		rivers.clear();
		walls.clear();
		entry.hexes.forEach((h, idx) => {
			const k = key(h.col, h.row);
			land.set(k, { terrain: h.terrain, production: h.production });
			const p = entry.placements.find((pl) => pl.index === idx);
			if (p) owners.set(k, { owner: p.owner, armies: p.armies });
		});
		for (const e of entry.rivers) rivers.add(edgeKey(key(...e.a), key(...e.b)));
		for (const e of entry.walls) walls.add(edgeKey(key(...e.a), key(...e.b)));
		difficulty = entry.difficulty;
		startingArmies = entry.startingArmies;
		mapName = name;
		selectedSaved = name;
		statusMessage = `Loaded "${name}".`;
	}

	function deleteMap(name: string) {
		const all = loadSavedMaps();
		delete all[name];
		localStorage.setItem(STORAGE_KEY, JSON.stringify(all));
		savedMaps = all;
		if (selectedSaved === name) selectedSaved = '';
		statusMessage = `Deleted "${name}".`;
	}

	function clearAll() {
		land.clear();
		owners.clear();
		rivers.clear();
		walls.clear();
		edgeAnchor = null;
		statusMessage = '';
	}

	function toolIs(t: Tool): boolean {
		if (t.kind !== tool.kind) return false;
		if (t.kind === 'terrain' && tool.kind === 'terrain') return t.terrain === tool.terrain;
		if (t.kind === 'owner' && tool.kind === 'owner') return t.owner === tool.owner;
		return true;
	}
</script>

<svelte:head>
	<title>Isle Wars — Map Editor</title>
</svelte:head>

<div class="editor">
	<div class="sidebar">
		<h1>Map Editor</h1>
		<button class="back" onclick={() => goto('/')}>&larr; Back to game</button>

		<section>
			<h2>Terrain</h2>
			<div class="grid-buttons">
				{#each ['plain', 'mountain', 'forest', 'marsh', 'desert'] as t}
					<button
						class:active={toolIs({ kind: 'terrain', terrain: t as Terrain })}
						class:full={t === 'desert'}
						style="--swatch: {TERRAIN_COLORS[t as Terrain]}"
						onclick={() => (tool = { kind: 'terrain', terrain: t as Terrain })}
					>
						<span class="swatch"></span>{t}
					</button>
				{/each}
			</div>
		</section>

		<section>
			<h2>Features</h2>
			<div class="grid-buttons">
				<button class:active={toolIs({ kind: 'city' })} onclick={() => (tool = { kind: 'city' })}>
					Toggle city
				</button>
				<button class:active={toolIs({ kind: 'river' })} onclick={() => { tool = { kind: 'river' }; edgeAnchor = null; }}>
					River edge
				</button>
				<button class:active={toolIs({ kind: 'wall' })} onclick={() => { tool = { kind: 'wall' }; edgeAnchor = null; }}>
					Wall edge
				</button>
				<button class:active={toolIs({ kind: 'erase' })} onclick={() => (tool = { kind: 'erase' })}>
					Erase hex
				</button>
			</div>
			{#if tool.kind === 'river' || tool.kind === 'wall'}
				<p class="hint">Click a land hex, then an adjacent land hex to toggle the edge.</p>
			{/if}
		</section>

		<section>
			<h2>Starting owner</h2>
			<label class="armies-input">
				Armies on placement
				<input type="number" min="1" max="99" bind:value={armyValue} />
			</label>
			<div class="grid-buttons">
				{#each PLAYERS as p}
					<button
						class:active={toolIs({ kind: 'owner', owner: p })}
						style="--swatch: {PLAYER_COLORS[p]}"
						onclick={() => (tool = { kind: 'owner', owner: p })}
					>
						<span class="swatch"></span>{PLAYER_NAMES[p]}
					</button>
				{/each}
				<button class="full" class:active={toolIs({ kind: 'owner', owner: null })} onclick={() => (tool = { kind: 'owner', owner: null })}>
					Neutral
				</button>
			</div>
		</section>

		<section>
			<h2>Game settings</h2>
			<label>
				Difficulty
				<select bind:value={difficulty}>
					<option value={1}>1 — Easiest</option>
					<option value={2}>2 — Normal</option>
					<option value={3}>3 — Hard</option>
					<option value={4}>4 — Hardest</option>
				</select>
			</label>
			<label>
				Starting armies per hex
				<input type="number" min="1" max="20" bind:value={startingArmies} />
			</label>
		</section>

		<section>
			<h2>Save / load</h2>
			<label>
				Map name
				<input type="text" bind:value={mapName} placeholder="My Archipelago" />
			</label>
			<button onclick={saveMap}>Save map</button>
			{#if Object.keys(savedMaps).length > 0}
				<label>
					Saved maps
					<select bind:value={selectedSaved}>
						<option value="">— choose —</option>
						{#each Object.keys(savedMaps) as name}
							<option value={name}>{name}</option>
						{/each}
					</select>
				</label>
				<div class="row-buttons">
					<button disabled={!selectedSaved} onclick={() => loadMap(selectedSaved)}>Load</button>
					<button disabled={!selectedSaved} onclick={() => deleteMap(selectedSaved)}>Delete</button>
				</div>
			{/if}
			<button class="danger" onclick={clearAll}>Clear all</button>
		</section>

		{#if statusMessage}
			<p class="status">{statusMessage}</p>
		{/if}

		<button class="play" onclick={play}>Play this map</button>
	</div>

	<div class="canvas-wrap">
		<svg viewBox="0 0 {W} {H}" class="board">
			<defs>
				<!-- Same terrain patterns as the main board (src/routes/+page.svelte)
				     so a custom map previews with the exact in-game look. -->
				<pattern id="mountain-pattern" width="42" height="36" patternUnits="userSpaceOnUse">
					<path d="M-4 36 L14 10 L32 36 Z M28 36 L46 10 L64 36 Z" fill="#000" opacity="0.28" stroke="none" />
					<path d="M14 10 L10 17 L18 17 Z M46 10 L42 17 L50 17 Z" fill="#ffffff" opacity="0.35" />
				</pattern>
				<pattern id="forest-pattern" width="48" height="48" patternUnits="userSpaceOnUse">
					<rect x="10.5" y="20" width="3" height="16" fill="#4a2d18" opacity="0.6" />
					<circle cx="12" cy="16" r="10" fill="#000" opacity="0.28" />
					<circle cx="12" cy="14" r="3" fill="#5cb85c" opacity="0.32" />
					<rect x="32.5" y="34" width="3" height="14" fill="#4a2d18" opacity="0.6" />
					<circle cx="34" cy="30" r="11" fill="#000" opacity="0.28" />
					<circle cx="34" cy="28" r="3.2" fill="#5cb85c" opacity="0.32" />
				</pattern>
				<pattern id="desert-pattern" width="44" height="38" patternUnits="userSpaceOnUse">
					<rect x="0" y="0" width="44" height="38" fill="#e8c07a" opacity="0.32" />
					<path d="M-2 26 Q10 20 22 26 T46 26" fill="none" stroke="#8a5a20" stroke-width="1.3" opacity="0.55" stroke-linecap="round" />
					<path d="M-2 12 Q10 6 22 12 T46 12" fill="none" stroke="#8a5a20" stroke-width="1.1" opacity="0.4" stroke-linecap="round" />
					<circle cx="8" cy="32" r="1.1" fill="#5c3a12" opacity="0.6" />
					<circle cx="30" cy="18" r="1" fill="#5c3a12" opacity="0.55" />
					<circle cx="36" cy="34" r="1.1" fill="#5c3a12" opacity="0.6" />
				</pattern>
				<pattern id="marsh-pattern" width="40" height="34" patternUnits="userSpaceOnUse">
					<path d="M4 10 Q10 5 16 10 T28 10" fill="none" stroke="#000" stroke-width="1.6" opacity="0.35" stroke-linecap="round" />
					<path d="M12 22 Q18 17 24 22 T36 22" fill="none" stroke="#000" stroke-width="1.6" opacity="0.35" stroke-linecap="round" />
					<line x1="6" y1="16" x2="6" y2="8" stroke="#3a5a3a" stroke-width="1.4" opacity="0.55" />
					<line x1="9" y1="15" x2="9" y2="7" stroke="#3a5a3a" stroke-width="1.4" opacity="0.55" />
					<line x1="22" y1="28" x2="22" y2="20" stroke="#3a5a3a" stroke-width="1.4" opacity="0.55" />
					<line x1="25" y1="28" x2="25" y2="20" stroke="#3a5a3a" stroke-width="1.4" opacity="0.55" />
				</pattern>
			</defs>
			<rect x="0" y="0" width={W} height={H} fill={WATER_COLOR} />
			{#each hexGrid as row, r}
				{#each row as hex, c}
					{@const k = key(c, r)}
					{@const l = land.get(k)}
					{@const own = owners.get(k)}
					{@const ptStr = hex.poly.map((p) => p.join(',')).join(' ')}
					<polygon
						points={ptStr}
						fill={own ? PLAYER_COLORS[own.owner] : l ? TERRAIN_COLORS[l.terrain] : WATER_COLOR}
						stroke={edgeAnchor === k ? '#ffe14a' : '#0a1420'}
						stroke-width={edgeAnchor === k ? 4 : 2}
						role="button"
						tabindex="0"
						onclick={() => clickHex(c, r)}
						onkeydown={(e) => {
							if (e.key === 'Enter' || e.key === ' ') clickHex(c, r);
						}}
					/>
					{#if l && l.terrain !== 'plain'}
						<polygon points={ptStr} fill="url(#{l.terrain}-pattern)" pointer-events="none" />
					{/if}
					{#if l?.production}
						<circle cx={hex.x} cy={hex.y - 22} r="6" fill="#ffe14a" pointer-events="none" />
					{/if}
					{#if own}
						<text x={hex.x} y={hex.y + 16} text-anchor="middle" font-family="monospace" font-weight="bold" font-size="18" fill="#fff" pointer-events="none">
							{own.armies}
						</text>
					{/if}
				{/each}
			{/each}
			{#each rivers as ek}
				{@const line = edgeLine(ek)}
				{#if line}
					<line x1={line.x1} y1={line.y1} x2={line.x2} y2={line.y2} stroke="#7fcfff" stroke-width="5" stroke-linecap="round" opacity="0.85" pointer-events="none" />
				{/if}
			{/each}
			{#each walls as ek}
				{@const line = edgeLine(ek)}
				{#if line}
					<line x1={line.x1} y1={line.y1} x2={line.x2} y2={line.y2} stroke="#3a2018" stroke-width="7" stroke-linecap="round" opacity="0.9" pointer-events="none" />
				{/if}
			{/each}
		</svg>
	</div>
</div>

<style>
	.editor {
		display: flex;
		height: 100vh;
		background: #0a1420;
		color: #dfe8ef;
		font-family: 'Segoe UI', system-ui, sans-serif;
	}
	.sidebar {
		width: 300px;
		flex-shrink: 0;
		overflow-y: auto;
		padding: 16px;
		background: #0f2035;
		border-right: 1px solid #1a3040;
	}
	.sidebar h1 {
		font-size: 20px;
		margin: 0 0 12px;
	}
	.sidebar h2 {
		font-size: 12px;
		text-transform: uppercase;
		letter-spacing: 0.06em;
		color: #7fcfff;
		margin: 0 0 10px;
		padding-left: 9px;
		border-left: 3px solid #2a5a8a;
	}
	section {
		margin-bottom: 14px;
		padding: 14px;
		border: 1px solid #1a3040;
		border-radius: 10px;
		background: linear-gradient(160deg, #102338, #0b1c2e);
	}
	.back {
		width: 100%;
		margin-bottom: 16px;
		border-radius: 6px;
		background: transparent;
		border: 1px solid #4a9fcf;
		color: #7fcfff;
	}
	.back:hover {
		background: rgba(74, 159, 207, 0.15);
	}
	label {
		display: block;
		font-size: 13px;
		color: #a8bfd4;
		margin-bottom: 8px;
	}
	label input,
	label select,
	input[type='text'] {
		display: block;
		width: 100%;
		margin-top: 5px;
		box-sizing: border-box;
		background: #081826;
		color: #d0e6f5;
		border: 1px solid #2a5a8a;
		border-radius: 6px;
		padding: 7px 9px;
		font-family: inherit;
		font-size: 13px;
	}
	label input:focus,
	label select:focus {
		outline: none;
		border-color: #7fcfff;
	}
	.armies-input {
		margin-bottom: 10px;
	}
	.grid-buttons {
		display: grid;
		grid-template-columns: 1fr 1fr;
		gap: 8px;
	}
	.grid-buttons .full {
		grid-column: 1 / -1;
	}
	.row-buttons {
		display: flex;
		gap: 8px;
	}
	button {
		background: #081826;
		color: #dfe8ef;
		border: 1px solid #1a3040;
		border-radius: 6px;
		padding: 8px 10px;
		font-size: 13px;
		cursor: pointer;
		display: flex;
		align-items: center;
		gap: 8px;
		transition: border-color 0.15s, background 0.15s, box-shadow 0.15s;
	}
	button:hover {
		border-color: #4a9fcf;
		background: #0d2338;
	}
	button.active {
		border-color: #ffe14a;
		background: #1a2f14;
		box-shadow: 0 0 0 1px rgba(255, 225, 74, 0.35), 0 0 10px rgba(255, 225, 74, 0.25);
	}
	button.danger {
		width: 100%;
		border-color: #a04040;
		color: #ff9a9a;
	}
	button.danger:hover {
		background: #2a1414;
		border-color: #cc5a5a;
	}
	button.play {
		width: 100%;
		background: linear-gradient(135deg, #1f5c3a, #16432a);
		border: 2px solid #3ac055;
		font-weight: bold;
		font-size: 15px;
		padding: 12px;
		margin-top: 10px;
		border-radius: 8px;
		justify-content: center;
		box-shadow: 0 0 16px rgba(58, 192, 85, 0.25);
	}
	button.play:hover {
		background: linear-gradient(135deg, #256b44, #1d5233);
	}
	.swatch {
		display: inline-block;
		width: 13px;
		height: 13px;
		border-radius: 50%;
		background: var(--swatch, #3a4a5a);
		border: 1px solid rgba(255, 255, 255, 0.25);
		flex: none;
	}
	.hint {
		font-size: 12px;
		color: #9fb0c0;
		margin: 8px 0 0;
	}
	.status {
		font-size: 13px;
		color: #ffe14a;
		background: #14283c;
		border: 1px solid rgba(255, 225, 74, 0.3);
		border-radius: 6px;
		padding: 8px 10px;
		margin-bottom: 10px;
	}
	.canvas-wrap {
		flex: 1;
		display: flex;
		align-items: center;
		justify-content: center;
		padding: 12px;
		overflow: auto;
	}
	.board {
		width: 100%;
		height: auto;
		max-height: 100%;
	}
	polygon {
		cursor: pointer;
		outline: none;
	}
	polygon:focus-visible {
		stroke: #7fcfff;
		stroke-width: 4;
	}
</style>
