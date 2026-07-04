<script lang="ts">
	import { onMount, tick } from 'svelte';
	import {
		game,
		newGame,
		placeArmies,
		beginAttack,
		beginMove,
		cancelAction,
		selectGrid,
		rollAttack,
		quitAttack,
		confirmMoveInAfterConquest,
		confirmMove,
		confirmAir,
		endTurn,
		playCard,
		loadSavedGame,
		clearSavedGame,
		getDebugSettings,
		updateDebugSettings,
		startGamePlaying,
		winProbability,
		defenseBonus,
		attackerBonus,
		canFerryConnect,
		canInvasionConnect,
		countryCount,
		fullIslandBonus,
		PLAYERS,
		PLAYER_COLORS,
		PLAYER_NAMES,
		CARD_LABELS,
		CARD_META,
		type Player,
		type CardType
	} from '$lib/game';
	import { runAiTurn } from '$lib/ai';

	let placeQty = $state(1);
	let moveQty = $state(1);
	let airQty = $state(1);
	let moveInQty = $state(0);
	let difficulty = $state(2);
	let startingArmies = $state(3);
	let showMenu = $state(false);

	const HUMAN: Player = 'blue';

	let aiRunning = $state(false);
	// AI speed: 1× (deliberate) | 2× (fast) | 0 (instant, no ticks)
	let aiSpeed = $state<1 | 2 | 0>(1);
	function aiTickMs() { return aiSpeed === 0 ? 0 : aiSpeed === 2 ? 20 : 60; }

	let autoRolling = $state(false);
	let hoveredGrid = $state<number | null>(null);
	let tooltipPos = $state<{ x: number; y: number } | null>(null);
	let hoveredCard = $state<CardType | null>(null);
	let cardTipPos = $state<{ x: number; y: number } | null>(null);

	function onCardHoverEnter(c: CardType, e: PointerEvent) {
		hoveredCard = c;
		cardTipPos = { x: e.clientX, y: e.clientY };
	}
	function onCardHoverMove(e: PointerEvent) {
		if (hoveredCard != null) cardTipPos = { x: e.clientX, y: e.clientY };
	}
	function onCardHoverLeave() {
		hoveredCard = null;
		cardTipPos = null;
	}

	function clampTip(x: number, y: number, w = 300, h = 160): { x: number; y: number } {
		const pad = 8;
		const offset = 14;
		if (typeof window === 'undefined') return { x: x + offset, y: y + offset };
		const winW = window.innerWidth;
		const winH = window.innerHeight;
		let tx = x + offset;
		let ty = y + offset;
		if (tx + w > winW - pad) tx = x - w - offset;
		if (ty + h > winH - pad) ty = y - h - offset;
		return {
			x: Math.max(pad, Math.min(tx, winW - w - pad)),
			y: Math.max(pad, Math.min(ty, winH - h - pad))
		};
	}

	function onHexPointerEnter(id: number, e: PointerEvent) {
		hoveredGrid = id;
		tooltipPos = { x: e.clientX, y: e.clientY };
	}
	function onHexPointerLeave(id: number) {
		if (hoveredGrid === id) hoveredGrid = null;
		tooltipPos = null;
	}

	// Drag-to-attack state
	let mapSvg: SVGSVGElement | undefined = $state();
	let dragFrom = $state<number | null>(null);
	let dragPt = $state<{ x: number; y: number } | null>(null);
	let pointerDownGrid: number | null = null;
	let pointerDownAt: { x: number; y: number } | null = null;

	function canStartAttackDrag(id: number): boolean {
		const s = $game;
		if (s.current !== HUMAN) return false;
		if (s.phase === 'action') {
			return s.states[id].owner === HUMAN && s.states[id].armies >= 2;
		}
		if (s.phase === 'ferry_from') {
			return s.states[id].owner === HUMAN;
		}
		if (s.phase === 'invasion_from') {
			return s.states[id].owner === HUMAN && s.states[id].armies >= 2;
		}
		return false;
	}

	function isValidAttackTarget(from: number, to: number): boolean {
		const s = $game;
		if (s.phase !== 'action') return false;
		if (from === to) return false;
		if (!s.map.adj[from].includes(to)) return false;
		if (s.states[to].owner === HUMAN) return false;
		return true;
	}

	function isValidMoveTarget(from: number, to: number): boolean {
		const s = $game;
		if (s.phase !== 'action') return false;
		if (from === to) return false;
		if (!s.map.adj[from].includes(to)) return false;
		if (s.states[to].owner !== HUMAN) return false;
		return true;
	}

	function isValidFerryTarget(from: number, to: number): boolean {
		const s = $game;
		if (s.phase !== 'ferry_from' && s.phase !== 'ferry_to') return false;
		if (from === to) return false;
		if (s.states[to].owner !== HUMAN) return false;
		return canFerryConnect(s, from, to);
	}

	function isValidInvasionTarget(from: number, to: number): boolean {
		const s = $game;
		if (s.phase !== 'invasion_from' && s.phase !== 'invasion_to') return false;
		return canInvasionConnect(s, from, to);
	}

	function isValidDragTarget(from: number, to: number): boolean {
		return isValidAttackTarget(from, to) || isValidMoveTarget(from, to)
			|| isValidFerryTarget(from, to) || isValidInvasionTarget(from, to);
	}

	function svgPoint(e: PointerEvent): { x: number; y: number } | null {
		if (!mapSvg) return null;
		const pt = mapSvg.createSVGPoint();
		pt.x = e.clientX;
		pt.y = e.clientY;
		const m = mapSvg.getScreenCTM();
		if (!m) return null;
		const p = pt.matrixTransform(m.inverse());
		return { x: p.x, y: p.y };
	}

	function onPolyPointerDown(id: number, e: PointerEvent) {
		if (canStartAttackDrag(id)) {
			pointerDownGrid = id;
			pointerDownAt = svgPoint(e);
		}
	}

	function onSvgPointerMove(e: PointerEvent) {
		if (hoveredGrid != null) tooltipPos = { x: e.clientX, y: e.clientY };
		if (pointerDownGrid == null || !pointerDownAt) return;
		const p = svgPoint(e);
		if (!p) return;
		if (dragFrom == null) {
			const dx = p.x - pointerDownAt.x;
			const dy = p.y - pointerDownAt.y;
			if (Math.hypot(dx, dy) > 10) {
				dragFrom = pointerDownGrid;
			}
		}
		if (dragFrom != null) dragPt = p;
	}

	function onSvgPointerUp() {
		if (dragFrom != null && hoveredGrid != null) {
			const from = dragFrom;
			const to = hoveredGrid;
			if (isValidAttackTarget(from, to)) {
				beginAttack();
				selectGrid(from);
				selectGrid(to);
			} else if (isValidMoveTarget(from, to)) {
				beginMove();
				selectGrid(from);
				selectGrid(to);
			} else if (isValidFerryTarget(from, to)) {
				selectGrid(from);
				selectGrid(to);
			} else if (isValidInvasionTarget(from, to)) {
				selectGrid(from);
				selectGrid(to);
			}
		}
		dragFrom = null;
		dragPt = null;
		pointerDownGrid = null;
		pointerDownAt = null;
	}

	onMount(() => {
		loadDebugUi();
		loadSavedGame();
		window.addEventListener('keydown', onKey);
		return () => window.removeEventListener('keydown', onKey);
	});

	function onKey(e: KeyboardEvent) {
		if ($game.current !== HUMAN || $game.phase === 'game_over') return;
		const tag = (e.target as HTMLElement | null)?.tagName;
		if (tag === 'INPUT' || tag === 'TEXTAREA') return;
		if (e.key === 'Escape') { cancelAction(); return; }
		if ($game.phase === 'action') {
			if (e.key === 'a' || e.key === 'A') { beginAttack(); e.preventDefault(); }
			else if (e.key === 'm' || e.key === 'M') { beginMove(); e.preventDefault(); }
			else if (e.key === 'p' || e.key === 'P') { endTurn(); e.preventDefault(); }
		} else if ($game.phase === 'attack_rolling') {
			if (e.key === 'Enter' || e.key === ' ') { rollAttack(); e.preventDefault(); }
		}
	}

	async function startAutoRoll() {
		autoRolling = true;
		while (autoRolling && $game.phase === 'attack_rolling') {
			rollAttack();
			await new Promise((r) => setTimeout(r, 90));
		}
		autoRolling = false;
	}
	function stopAutoRoll() { autoRolling = false; }

	// Reactively drive AI turns whenever current is not the human.
	$effect(() => {
		const s = $game;
		if (aiRunning) return;
		if (!s.gameStarted) return; // waiting for Start Game
		if (s.phase === 'game_over') return;
		if (s.current === HUMAN) return;
		aiRunning = true;
		(async () => {
			await new Promise((r) => setTimeout(r, aiSpeed === 0 ? 40 : 200));
			await runAiTurn(s.current, aiTickMs());
			aiRunning = false;
		})();
	});

	function gridFill(id: number, s: typeof $game) {
		const st = s.states[id];
		return st.owner ? PLAYER_COLORS[st.owner] : '#334';
	}

	function isSelectable(id: number, s: typeof $game): boolean {
		if (s.current !== HUMAN) return false;
		switch (s.phase) {
			case 'placing':
				return s.states[id].owner === HUMAN;
			case 'attack_select_from':
				return s.states[id].owner === HUMAN && s.states[id].armies >= 2;
			case 'attack_select_to':
				if (s.selectedFrom == null) return false;
				return s.map.adj[s.selectedFrom].includes(id) && s.states[id].owner !== HUMAN;
			case 'move_select_from':
				return s.states[id].owner === HUMAN && s.states[id].armies >= 2;
			case 'move_select_to':
				if (s.selectedFrom == null) return false;
				return s.map.adj[s.selectedFrom].includes(id) && s.states[id].owner === HUMAN;
			case 'bomb_select':
				return s.states[id].owner !== HUMAN && !!s.states[id].owner;
			case 'air_from':
				return s.states[id].owner === HUMAN && s.states[id].armies >= 2;
			case 'air_to':
				return s.states[id].owner === HUMAN && id !== s.selectedFrom;
			case 'reinforce_select':
			case 'fortify_select':
				return s.states[id].owner === HUMAN;
			case 'sabotage_select':
				return s.states[id].owner !== HUMAN && !!s.states[id].owner;
			case 'ferry_from':
				return s.states[id].owner === HUMAN;
			case 'ferry_to':
				if (s.selectedFrom == null) return false;
				return s.states[id].owner === HUMAN && canFerryConnect(s, s.selectedFrom, id);
			case 'invasion_from':
				return s.states[id].owner === HUMAN && s.states[id].armies >= 2;
			case 'invasion_to':
				if (s.selectedFrom == null) return false;
				return canInvasionConnect(s, s.selectedFrom, id);
			default:
				return false;
		}
	}

	function handleGridClick(id: number) {
		const s = $game;
		if (s.current !== HUMAN) return;
		if (s.phase === 'placing') {
			const q = Math.max(1, Math.min(placeQty, s.armiesToPlace));
			placeArmies(id, q);
			return;
		}
		if (!isSelectable(id, s)) return;
		selectGrid(id);
	}

	function startNewGame() {
		newGame(difficulty, startingArmies);
		showMenu = false;
	}

	function confirmClearSave() {
		const ok = confirm(
			'Clear the saved game and start a fresh one?\n\nThis wipes your current progress in this browser and cannot be undone.'
		);
		if (!ok) return;
		clearSavedGame();
		newGame(difficulty, startingArmies);
	}

	function polygonPoints(pts: [number, number][]): string {
		return pts.map((p) => p.join(',')).join(' ');
	}

	function seaLaneLine(a: number, b: number, s: typeof $game) {
		const g1 = s.map.grids[a];
		const g2 = s.map.grids[b];
		return { x1: g1.x, y1: g1.y, x2: g2.x, y2: g2.y };
	}

	// Debug menu
	let showDebug = $state(false);
	let debugDisableSave = $state(false);
	let debugStarterCards = $state(false);

	function loadDebugUi() {
		const d = getDebugSettings();
		debugDisableSave = d.disableSave;
		debugStarterCards = d.starterCards;
	}

	function toggleDebugDisableSave() {
		debugDisableSave = !debugDisableSave;
		updateDebugSettings({ disableSave: debugDisableSave });
	}

	function toggleDebugStarterCards() {
		debugStarterCards = !debugStarterCards;
		updateDebugSettings({ starterCards: debugStarterCards });
	}

	interface HexInfo {
		title: string;
		owner: string;
		ownerColor: string;
		armies: number;
		city?: string;
		terrainName: string;
		terrainDesc: string;
		fortified: boolean;
	}
	function hexInfo(gridId: number): HexInfo {
		const g = $game.map.grids[gridId];
		const st = $game.states[gridId];
		const title = gridLabelLocal(gridId, $game);
		const owner = st.owner ? PLAYER_NAMES[st.owner] : 'Neutral';
		const ownerColor = st.owner ? PLAYER_COLORS[st.owner] : '#556';
		const terrainMap: Record<string, [string, string]> = {
			plain: ['Plain', 'Open ground. No combat modifier.'],
			mountain: ['Mountain', 'Defender rolls +1 on every die.'],
			forest: ['Forest', 'Attacker rolls +1 (cover on approach).'],
			marsh: ['Marsh', 'After attacking from here, cannot launch another attack from this hex this turn.']
		};
		const [terrainName, terrainDesc] = terrainMap[g.terrain] ?? ['Plain', ''];
		return {
			title,
			owner,
			ownerColor,
			armies: st.armies,
			city: g.cityName,
			terrainName,
			terrainDesc,
			fortified: !!st.fortified
		};
	}

	function gridLabelLocal(id: number, s: typeof $game): string {
		const g = s.map.grids[id];
		const isl = s.map.islands.find((i) => i.id === g.island)!;
		const localIdx = s.map.grids.filter((x) => x.island === g.island).findIndex((x) => x.id === id) + 1;
		return `${isl.name}-${localIdx}`;
	}
</script>

<svelte:head><title>Isle Wars — SvelteKit clone</title></svelte:head>

<main>
	<header>
		<div class="header-row">
			<div class="scoreboard">
				{#each PLAYERS as p}
					<div class="score" class:current={$game.current === p} class:dead={!$game.alive[p]}>
						<span class="dot" style="background:{PLAYER_COLORS[p]}"></span>
						<strong>{PLAYER_NAMES[p]}</strong>
						<span class="score-nums">{countryCount($game, p)}<span class="dim">/{$game.map.grids.length}</span></span>
						<span class="bonus">+{fullIslandBonus($game, p)}</span>
					</div>
				{/each}
			</div>
			<div class="actions">
				<span class="turn">T{$game.turn}</span>
				<label class="speed">
					<select bind:value={aiSpeed}>
						<option value={1}>1×</option>
						<option value={2}>2×</option>
						<option value={0}>⚡</option>
					</select>
				</label>
				<button class="icon-btn" title="New Game" onclick={() => (showMenu = !showMenu)}>{showMenu ? '✕' : 'New'}</button>
				<button class="icon-btn" title="Debug" onclick={() => (showDebug = !showDebug)}>Debug</button>
				<button class="icon-btn danger" title="Clear Save" onclick={confirmClearSave}>Clear</button>
			</div>
		</div>
	</header>

	{#if showMenu}
		<section class="menu">
			<h2>New Game</h2>
			<label>Difficulty
				<select bind:value={difficulty}>
					<option value={1}>1 — Easy</option>
					<option value={2}>2 — Normal (default)</option>
					<option value={3}>3 — Hard</option>
					<option value={4}>4 — Hardest</option>
				</select>
			</label>
			<label>Starting armies per country
				<input type="number" min="1" max="10" bind:value={startingArmies} />
			</label>
			<button onclick={startNewGame}>Start</button>
		</section>
	{/if}

	{#if showDebug}
		<section class="debug-panel">
			<div class="debug-header">
				<span class="debug-badge">DEBUG</span>
				<h2>Developer Options</h2>
				<button class="close-x" onclick={() => (showDebug = false)} aria-label="Close debug">✕</button>
			</div>
			<div class="debug-options">
				<label class="toggle-card" class:on={debugDisableSave}>
					<input type="checkbox" checked={debugDisableSave} onchange={toggleDebugDisableSave} />
					<div class="toggle-slot"><div class="toggle-thumb"></div></div>
					<div class="toggle-text">
						<div class="toggle-title">Disable local save</div>
						<div class="toggle-desc">Wipes the current save and skips future saves so a reload always gives you a fresh map.</div>
					</div>
				</label>
				<label class="toggle-card" class:on={debugStarterCards}>
					<input type="checkbox" checked={debugStarterCards} onchange={toggleDebugStarterCards} />
					<div class="toggle-slot"><div class="toggle-thumb"></div></div>
					<div class="toggle-text">
						<div class="toggle-title">Blue starts with every card</div>
						<div class="toggle-desc">Deals one of each card type to Blue's hand at the start of every new game for testing.</div>
					</div>
				</label>
			</div>
			<div class="debug-footer">Settings apply to the next game you start.</div>
		</section>
	{/if}


	{#if $game.phase === 'game_over'}
		<section class="banner {$game.winner === HUMAN ? 'win' : 'lose'}">
			{#if $game.winner === HUMAN}
				<h2>Victory! Blue conquered the isles.</h2>
			{:else if $game.winner}
				<h2>Defeat. {PLAYER_NAMES[$game.winner]} won.</h2>
			{:else}
				<h2>Game Over</h2>
			{/if}
			<button onclick={startNewGame}>New Game</button>
		</section>
	{/if}

	{#if $game.gameStarted}
		<div class="msg">{$game.message}</div>
	{/if}

	{#if !$game.gameStarted && $game.phase !== 'game_over'}
		<div class="start-prompt">
			<div>
				<h2>Ready to play?</h2>
				<p>Take a look at the map, then hit <strong>Start Game</strong> to let the opponents make their moves.</p>
			</div>
			<button class="primary big" onclick={startGamePlaying}>Start Game →</button>
		</div>
	{/if}

	<div class="grid">
		<div class="mapwrap">
			<svg
				bind:this={mapSvg}
				viewBox={$game.map.viewBox ? `${$game.map.viewBox.x} ${$game.map.viewBox.y} ${$game.map.viewBox.w} ${$game.map.viewBox.h}` : `0 0 ${$game.map.width} ${$game.map.height}`}
				class="map"
				onpointermove={onSvgPointerMove}
				onpointerup={onSvgPointerUp}
				onpointerleave={onSvgPointerUp}
			>
				<defs>
					<!-- Subtle mountain-peak pattern overlaid on mountain hexes. -->
					<pattern id="mountain-pattern" width="42" height="36" patternUnits="userSpaceOnUse">
						<path d="M-4 36 L14 10 L32 36 Z M28 36 L46 10 L64 36 Z"
							fill="#000" opacity="0.28" stroke="none" />
						<path d="M14 10 L10 17 L18 17 Z M46 10 L42 17 L50 17 Z"
							fill="#ffffff" opacity="0.35" />
					</pattern>
					<!-- Forest pattern: sparse trees (crown + long trunk). Two trees
					     per tile at low opacity so it reads as texture, not noise. -->
					<pattern id="forest-pattern" width="48" height="48" patternUnits="userSpaceOnUse">
						<rect x="10.5" y="20" width="3" height="16" fill="#4a2d18" opacity="0.6" />
						<circle cx="12" cy="16" r="10" fill="#000" opacity="0.28" />
						<circle cx="12" cy="14" r="3" fill="#5cb85c" opacity="0.32" />
						<rect x="32.5" y="34" width="3" height="14" fill="#4a2d18" opacity="0.6" />
						<circle cx="34" cy="30" r="11" fill="#000" opacity="0.28" />
						<circle cx="34" cy="28" r="3.2" fill="#5cb85c" opacity="0.32" />
					</pattern>
					<!-- Marsh pattern: horizontal reed strokes suggesting wet ground. -->
					<pattern id="marsh-pattern" width="40" height="34" patternUnits="userSpaceOnUse">
						<path d="M4 10 Q10 5 16 10 T28 10" fill="none" stroke="#000" stroke-width="1.6" opacity="0.35" stroke-linecap="round" />
						<path d="M12 22 Q18 17 24 22 T36 22" fill="none" stroke="#000" stroke-width="1.6" opacity="0.35" stroke-linecap="round" />
						<!-- reed tufts -->
						<line x1="6" y1="16" x2="6" y2="8" stroke="#3a5a3a" stroke-width="1.4" opacity="0.55" />
						<line x1="9" y1="15" x2="9" y2="7" stroke="#3a5a3a" stroke-width="1.4" opacity="0.55" />
						<line x1="22" y1="28" x2="22" y2="20" stroke="#3a5a3a" stroke-width="1.4" opacity="0.55" />
						<line x1="25" y1="28" x2="25" y2="20" stroke="#3a5a3a" stroke-width="1.4" opacity="0.55" />
					</pattern>
				</defs>
				<!-- Water -->
				<rect x="0" y="0" width={$game.map.width} height={$game.map.height} fill="#0a2540" />
				<!-- Water hexes (the underlying grid) -->
				{#each $game.map.waterHexes ?? [] as poly}
					<polygon points={polygonPoints(poly)} fill="#0e2a48" stroke="#26527a" stroke-width="0.8" stroke-opacity="0.55" pointer-events="none" />
				{/each}
				<!-- Sea lanes -->
				{#each $game.map.seaLanes as [a, b]}
					{@const l = seaLaneLine(a, b, $game)}
					<line x1={l.x1} y1={l.y1} x2={l.x2} y2={l.y2} stroke="#a0d8ff" stroke-width="2.5" stroke-dasharray="6 4" stroke-opacity="0.85" pointer-events="none" />
				{/each}
				<!-- Territory polygons (Voronoi cells clipped to island hulls) -->
				{#each $game.map.grids as g}
					{@const st = $game.states[g.id]}
					{@const sel = isSelectable(g.id, $game)}
					<polygon
						points={polygonPoints(g.cell)}
						class="territory"
						class:selectable={sel}
						class:mountain={g.terrain === 'mountain'}
						class:selected-from={$game.selectedFrom === g.id}
						class:selected-to={$game.selectedTo === g.id}
						class:drag-source={dragFrom === g.id}
						class:drag-attack-target={dragFrom != null && isValidAttackTarget(dragFrom, g.id) && hoveredGrid === g.id}
						class:drag-attack-candidate={dragFrom != null && dragFrom !== g.id && isValidAttackTarget(dragFrom, g.id)}
						class:drag-move-target={dragFrom != null && isValidMoveTarget(dragFrom, g.id) && hoveredGrid === g.id}
						class:drag-move-candidate={dragFrom != null && dragFrom !== g.id && isValidMoveTarget(dragFrom, g.id)}
						class:drag-ferry-target={dragFrom != null && isValidFerryTarget(dragFrom, g.id) && hoveredGrid === g.id}
						class:drag-ferry-candidate={dragFrom != null && dragFrom !== g.id && isValidFerryTarget(dragFrom, g.id)}
						class:drag-invade-target={dragFrom != null && isValidInvasionTarget(dragFrom, g.id) && hoveredGrid === g.id}
						class:drag-invade-candidate={dragFrom != null && dragFrom !== g.id && isValidInvasionTarget(dragFrom, g.id)}
						fill={gridFill(g.id, $game)}
						stroke="#0a1420"
						stroke-width="2"
						onclick={() => handleGridClick(g.id)}
						onpointerdown={(e) => onPolyPointerDown(g.id, e)}
						onpointerenter={(e) => onHexPointerEnter(g.id, e)}
						onpointerleave={() => onHexPointerLeave(g.id)}
						role="button"
						tabindex="0"
					/>
				{/each}
				<!-- Terrain overlays: mountains + forests + marshes -->
				{#each $game.map.grids as g}
					{#if g.terrain === 'mountain'}
						<polygon points={polygonPoints(g.cell)} fill="url(#mountain-pattern)" pointer-events="none" />
					{:else if g.terrain === 'forest'}
						<polygon points={polygonPoints(g.cell)} fill="url(#forest-pattern)" pointer-events="none" />
					{:else if g.terrain === 'marsh'}
						<polygon points={polygonPoints(g.cell)} fill="url(#marsh-pattern)" pointer-events="none" />
					{/if}
				{/each}
				<!-- Army count badges, production stars, and city names -->
				{#each $game.map.grids as g}
					{@const st = $game.states[g.id]}
					<g pointer-events="none">
						{#if st.fortified}
							<circle cx={g.x} cy={g.y} r="24" fill="none" stroke="#7fcfff" stroke-width="2.5" stroke-dasharray="3 2" opacity="0.9" />
						{/if}
						<circle cx={g.x} cy={g.y} r="20" fill="#000" fill-opacity="0.6" stroke={g.production ? '#ffe14a' : '#fff'} stroke-width={g.production ? 2.5 : 1.5} />
						<text x={g.x} y={g.y + 7} class="node-label" text-anchor="middle">{st.armies}</text>
						{#if g.production}
							<text x={g.x + 20} y={g.y - 15} class="prod-star" text-anchor="middle">★</text>
							{#if g.cityName}
								<text x={g.x} y={g.y + 34} class="city-label city-label-outline" text-anchor="middle">{g.cityName}</text>
								<text x={g.x} y={g.y + 34} class="city-label" text-anchor="middle">{g.cityName}</text>
							{/if}
						{/if}
					</g>
				{/each}
				<!-- Island name labels centered on the island's centroid, with a
				     dark stroked outline so they read on any hex color. -->
				{#each $game.map.islands as isl}
					<text x={isl.labelPos[0]} y={isl.labelPos[1] - 2} class="isle-label isle-label-outline" text-anchor="middle" pointer-events="none">{isl.name.toUpperCase()}</text>
					<text x={isl.labelPos[0]} y={isl.labelPos[1] - 2} class="isle-label" text-anchor="middle" pointer-events="none">{isl.name.toUpperCase()}</text>
					<text x={isl.labelPos[0]} y={isl.labelPos[1] + 17} class="isle-value isle-label-outline" text-anchor="middle" pointer-events="none">+{isl.value}</text>
					<text x={isl.labelPos[0]} y={isl.labelPos[1] + 17} class="isle-value" text-anchor="middle" pointer-events="none">+{isl.value}</text>
				{/each}
				<!-- Drag arrow (attack = gold, move = cyan, no valid drop = dashed white) -->
				{#if dragFrom != null && dragPt}
					{@const src = $game.map.grids[dragFrom]}
					{@const overAttack = hoveredGrid != null && isValidAttackTarget(dragFrom, hoveredGrid)}
					{@const overMove = hoveredGrid != null && isValidMoveTarget(dragFrom, hoveredGrid)}
					{@const overFerry = hoveredGrid != null && isValidFerryTarget(dragFrom, hoveredGrid)}
					{@const overInvade = hoveredGrid != null && isValidInvasionTarget(dragFrom, hoveredGrid)}
					{@const arrowColor = overAttack ? '#ffe14a' : overMove ? '#7fcfff' : overFerry ? '#c68fff' : overInvade ? '#ff6a6a' : '#fff'}
					<defs>
						<marker id="drag-arrowhead" markerWidth="10" markerHeight="10" refX="8" refY="5" orient="auto">
							<path d="M0,0 L10,5 L0,10 Z" fill={arrowColor} />
						</marker>
					</defs>
					<line
						x1={src.x} y1={src.y}
						x2={dragPt.x} y2={dragPt.y}
						stroke={arrowColor}
						stroke-width="4"
						stroke-linecap="round"
						stroke-dasharray={(overAttack || overMove || overFerry || overInvade) ? 'none' : '8 6'}
						marker-end="url(#drag-arrowhead)"
						pointer-events="none"
					/>
				{/if}
			</svg>
		</div>

		<aside class="side">
			<section class="panel">
				<h3>{PLAYER_NAMES[$game.current]}'s turn — {$game.phase}</h3>
				{#if $game.current === HUMAN && $game.phase === 'placing'}
					<div class="row">
						<label>Place qty
							<input type="number" min="1" max={$game.armiesToPlace} bind:value={placeQty} />
						</label>
						<button onclick={() => (placeQty = $game.armiesToPlace)}>All ({$game.armiesToPlace})</button>
					</div>
					<p class="hint">Armies remaining: <strong>{$game.armiesToPlace}</strong>. Click one of your territories.</p>
				{/if}

				{#if $game.current === HUMAN && $game.phase === 'action'}
					<div class="row">
						<button onclick={beginAttack}>Attack</button>
						<button onclick={beginMove}>Move</button>
						<button onclick={endTurn}>Pass</button>
						<button onclick={cancelAction}>Cancel</button>
					</div>
				{/if}

				{#if $game.current === HUMAN && ($game.phase === 'attack_select_from' || $game.phase === 'attack_select_to')}
					<div class="row">
						<button onclick={quitAttack}>Cancel Attack</button>
					</div>
					{#if $game.phase === 'attack_select_to' && $game.selectedFrom != null}
						{@const target = hoveredGrid != null && isSelectable(hoveredGrid, $game) ? hoveredGrid : null}
						{#if target != null}
							{@const atkA = $game.states[$game.selectedFrom].armies}
							{@const defA = $game.states[target].armies}
							{@const defB = defenseBonus($game, target)}
							{@const atkB = attackerBonus($game, target)}
							{@const wp = Math.round(winProbability(atkA, defA, defB, atkB) * 100)}
							{@const modTxt = defB ? ` +${defB} ⛰` : atkB ? ` (atk +${atkB} 🌲)` : ''}
							<p class="hint">{gridLabelLocal($game.selectedFrom, $game)} ({atkA}) vs {gridLabelLocal(target, $game)} ({defA}{modTxt}) · <strong style="color:{wp >= 65 ? '#7fff7f' : wp >= 35 ? '#ffd67f' : '#ff7f7f'}">{wp}% win</strong></p>
						{:else}
							<p class="hint">Attackable neighbors are outlined in white. Hover to preview odds.</p>
						{/if}
					{/if}
				{/if}

				{#if $game.current === HUMAN && $game.phase === 'attack_rolling'}
					<div class="row">
						{#if autoRolling}
							<button onclick={stopAutoRoll}>Stop</button>
						{:else}
							<button onclick={rollAttack}>Roll!</button>
							<button onclick={startAutoRoll}>Auto-Roll</button>
						{/if}
						<button onclick={quitAttack} disabled={autoRolling}>Cancel Attack</button>
					</div>
					{#if $game.selectedFrom != null && $game.selectedTo != null}
						{@const atkA = $game.states[$game.selectedFrom].armies}
						{@const defA = $game.states[$game.selectedTo].armies}
						{@const defB = defenseBonus($game, $game.selectedTo)}
						{@const atkB = attackerBonus($game, $game.selectedTo)}
						{@const wp = Math.round(winProbability(atkA, defA, defB, atkB) * 100)}
						{@const modTxt = defB ? ` +${defB} ⛰` : atkB ? ` (atk +${atkB} 🌲)` : ''}
						<p class="hint">{gridLabelLocal($game.selectedFrom, $game)} ({atkA}) → {gridLabelLocal($game.selectedTo, $game)} ({defA}{modTxt}) · <strong style="color:{wp >= 65 ? '#7fff7f' : wp >= 35 ? '#ffd67f' : '#ff7f7f'}">{wp}% win</strong></p>
					{/if}
				{/if}

				{#if $game.current === HUMAN && $game.phase === 'attack_move_in' && $game.selectedFrom != null && $game.selectedTo != null}
					{@const max = $game.states[$game.selectedFrom].armies - 1}
					<div class="qty-panel">
						<label class="qty-input">
							<span>Extra to move in</span>
							<input type="number" min="0" max={max} bind:value={moveInQty} />
						</label>
						<div class="qty-buttons">
							<button onclick={() => (moveInQty = 0)}>None</button>
							<button onclick={() => (moveInQty = max)}>All ({max})</button>
							<button class="primary" onclick={() => confirmMoveInAfterConquest(moveInQty)}>Confirm</button>
						</div>
					</div>
				{/if}

				{#if $game.current === HUMAN && ($game.phase === 'move_select_from' || $game.phase === 'move_select_to' || $game.phase === 'bomb_select' || $game.phase === 'air_from' || $game.phase === 'air_to' || $game.phase === 'reinforce_select' || $game.phase === 'sabotage_select' || $game.phase === 'fortify_select' || $game.phase === 'ferry_from' || $game.phase === 'ferry_to' || $game.phase === 'invasion_from' || $game.phase === 'invasion_to')}
					<div class="row">
						<button onclick={cancelAction}>Cancel</button>
					</div>
				{/if}

				{#if $game.current === HUMAN && $game.phase === 'move_qty' && $game.selectedFrom != null}
					{@const maxM = $game.states[$game.selectedFrom].armies - 1}
					<div class="qty-panel">
						<label class="qty-input">
							<span>Move qty</span>
							<input type="number" min="1" max={maxM} bind:value={moveQty} />
						</label>
						<div class="qty-buttons">
							<button onclick={() => (moveQty = 1)}>1</button>
							<button onclick={() => (moveQty = maxM)}>All ({maxM})</button>
							<button class="primary" onclick={() => confirmMove(moveQty)}>Confirm</button>
							<button onclick={cancelAction}>Cancel</button>
						</div>
					</div>
				{/if}

				{#if $game.current === HUMAN && $game.phase === 'air_qty' && $game.selectedFrom != null}
					{@const maxA = $game.states[$game.selectedFrom].armies - 1}
					<div class="qty-panel">
						<label class="qty-input">
							<span>Airlift qty</span>
							<input type="number" min="1" max={maxA} bind:value={airQty} />
						</label>
						<div class="qty-buttons">
							<button onclick={() => (airQty = 1)}>1</button>
							<button onclick={() => (airQty = maxA)}>All ({maxA})</button>
							<button class="primary" onclick={() => confirmAir(airQty)}>Airlift</button>
							<button onclick={cancelAction}>Cancel</button>
						</div>
					</div>
				{/if}

				{#if $game.current !== HUMAN}
					<p class="hint">🤖 {PLAYER_NAMES[$game.current]} is thinking…</p>
				{/if}
			</section>

			<section class="panel">
				<h3>Your cards ({$game.hands[HUMAN].length})</h3>
				{#if $game.hands[HUMAN].length === 0}
					<p class="hint">No cards.</p>
				{:else}
					<div class="card-grid">
						{#each $game.hands[HUMAN] as c, i}
							{@const meta = CARD_META[c]}
							{@const disabled = $game.cardPlayedThisTurn && c !== 'antibomb'}
							<button
								class="card-tile kind-{meta.kind}"
								class:disabled
								disabled={disabled}
								onclick={() => playCard(i)}
								onpointerenter={(e) => onCardHoverEnter(c, e)}
								onpointerleave={onCardHoverLeave}
								onpointermove={(e) => onCardHoverMove(e)}
							>
								<div class="card-icon">{meta.icon}</div>
								<div class="card-name">{CARD_LABELS[c]}</div>
							</button>
						{/each}
					</div>
					{#if $game.cardPlayedThisTurn}
						<p class="hint">Only one card this turn — already played.</p>
					{/if}
				{/if}
			</section>

			<section class="panel">
				<h3>Log</h3>
				<ul class="log">
					{#each $game.log as e}
						<li class={e.kind ?? 'info'}>
							<span class="turn-tag">T{e.turn}</span>
							{#if e.player}<span class="pdot" style="background:{PLAYER_COLORS[e.player]}"></span>{/if}
							{e.text}
						</li>
					{/each}
				</ul>
			</section>
		</aside>
	</div>

	{#if $game.history}
	{@const hist = $game.history}
	{@const maxTerr = Math.max(1, ...hist.flatMap((h) => PLAYERS.map((p) => h.territories[p])))}
	{@const maxArm = Math.max(1, ...hist.flatMap((h) => PLAYERS.map((p) => h.armies[p])))}
	{@const chartW = 560}
	{@const chartH = 180}
	{@const xStep = hist.length > 1 ? chartW / (hist.length - 1) : 0}
	<section class="analytics">
		<div class="charts">
			<div class="chart">
				<h3>Territories owned</h3>
				<svg viewBox="0 0 {chartW + 40} {chartH + 30}">
					<line x1="30" y1={chartH + 5} x2={chartW + 35} y2={chartH + 5} stroke="#345" />
					<line x1="30" y1="5" x2="30" y2={chartH + 5} stroke="#345" />
					<text x="26" y="10" text-anchor="end" class="axis">{maxTerr}</text>
					<text x="26" y={chartH + 8} text-anchor="end" class="axis">0</text>
					{#each PLAYERS as p}
						{#if hist.length > 0}
							<polyline
								fill="none"
								stroke={PLAYER_COLORS[p]}
								stroke-width="2"
								points={hist.map((h, i) => `${30 + i * xStep},${5 + (chartH - (h.territories[p] / maxTerr) * chartH)}`).join(' ')}
							/>
						{/if}
					{/each}
				</svg>
			</div>
			<div class="chart">
				<h3>Total armies</h3>
				<svg viewBox="0 0 {chartW + 40} {chartH + 30}">
					<line x1="30" y1={chartH + 5} x2={chartW + 35} y2={chartH + 5} stroke="#345" />
					<line x1="30" y1="5" x2="30" y2={chartH + 5} stroke="#345" />
					<text x="26" y="10" text-anchor="end" class="axis">{maxArm}</text>
					<text x="26" y={chartH + 8} text-anchor="end" class="axis">0</text>
					{#each PLAYERS as p}
						{#if hist.length > 0}
							<polyline
								fill="none"
								stroke={PLAYER_COLORS[p]}
								stroke-width="2"
								points={hist.map((h, i) => `${30 + i * xStep},${5 + (chartH - (h.armies[p] / maxArm) * chartH)}`).join(' ')}
							/>
						{/if}
					{/each}
				</svg>
			</div>
			<div class="chart stat-table">
				<h3>Stats</h3>
				<table class="stats-table">
					<thead>
						<tr>
							<th></th><th>T</th><th>A</th><th>W/L</th><th>+/−</th><th>Cards</th>
						</tr>
					</thead>
					<tbody>
						{#each PLAYERS as p}
							{@const last = hist[hist.length - 1]}
							{@const st = $game.stats[p]}
							<tr>
								<td><span class="dot" style="background:{PLAYER_COLORS[p]}"></span> {PLAYER_NAMES[p]}</td>
								<td>{last?.territories[p] ?? 0}</td>
								<td>{last?.armies[p] ?? 0}</td>
								<td>{st.attacksWon}/{st.attacksLost}</td>
								<td>{st.territoriesCaptured}/{st.territoriesLost}</td>
								<td>{st.cardsDrawn}</td>
							</tr>
						{/each}
					</tbody>
				</table>
			</div>
		</div>
	</section>
	{/if}
</main>

{#if hoveredCard != null && cardTipPos}
	{@const cm = CARD_META[hoveredCard]}
	{@const cp = clampTip(cardTipPos.x, cardTipPos.y, 280, 140)}
	<div class="card-tooltip kind-{cm.kind}" style="left:{cp.x}px; top:{cp.y}px">
		<div class="ct-header">
			<span class="ct-icon">{cm.icon}</span>
			<strong>{CARD_LABELS[hoveredCard]}</strong>
			<span class="ct-kind">{cm.kind}</span>
		</div>
		<div class="ct-desc">{cm.desc}</div>
		<div class="ct-when">Playable: {cm.when}</div>
	</div>
{/if}

{#if hoveredGrid != null && tooltipPos}
	{@const info = hexInfo(hoveredGrid)}
	{@const hp = clampTip(tooltipPos.x, tooltipPos.y, 280, 180)}
	<div class="hex-tooltip" style="left:{hp.x}px; top:{hp.y}px">
		<div class="tt-title">
			<span class="tt-owner-dot" style="background:{info.ownerColor}"></span>
			<strong>{info.title}</strong>
			<span class="tt-armies">{info.armies}</span>
		</div>
		<div class="tt-owner">{info.owner}</div>
		{#if info.city}<div class="tt-city">★ {info.city}</div>{/if}
		<div class="tt-terrain">
			<div class="tt-terrain-name">{info.terrainName}</div>
			{#if info.terrainDesc}<div class="tt-terrain-desc">{info.terrainDesc}</div>{/if}
		</div>
		{#if info.fortified}
			<div class="tt-fort">🛡 Fortified — +2 defense (lost when hex is captured).</div>
		{/if}
	</div>
{/if}

<style>
	:global(body) {
		background: #0a1420;
		color: #d0e6f5;
		font-family: 'Segoe UI', system-ui, sans-serif;
		margin: 0;
	}
	main {
		max-width: 1400px;
		margin: 0 auto;
		padding: 0.75rem;
	}
	header {
		border: 1px solid #1a3040;
		padding: 0.35rem 0.6rem;
		background: #0f2035;
		margin-bottom: 0.5rem;
	}
	.header-row {
		display: flex;
		align-items: center;
		gap: 0.6rem;
		flex-wrap: wrap;
	}
	.scoreboard {
		display: flex;
		gap: 0.4rem;
		flex-wrap: wrap;
		flex: 1 1 auto;
	}
	.score {
		display: flex;
		align-items: center;
		gap: 0.35rem;
		padding: 0.15rem 0.45rem;
		border: 1px solid #1a3040;
		background: #081826;
		font-size: 0.82rem;
		border-radius: 4px;
	}
	.score.current { border-color: #7fcfff; box-shadow: 0 0 6px #4a9fcf; }
	.score.dead { opacity: 0.4; text-decoration: line-through; }
	.dot { width: 10px; height: 10px; border-radius: 50%; display: inline-block; flex: none; }
	.score-nums { font-family: monospace; }
	.score-nums .dim { color: #6a9abf; }
	.bonus { color: #ffe14a; font-family: monospace; font-size: 0.78rem; }
	.actions { display: flex; gap: 0.35rem; align-items: center; margin-left: auto; }
	.speed { display: flex; align-items: center; }
	.speed select { width: auto; padding: 0.1rem 0.25rem; font-size: 0.8rem; }
	.turn {
		color: #7fcfff;
		font-family: monospace;
		font-size: 0.85rem;
		padding: 0.15rem 0.4rem;
		border: 1px solid #1a3040;
		border-radius: 4px;
	}
	.icon-btn {
		padding: 0.2rem 0.55rem;
		font-size: 0.8rem;
	}

	.menu {
		padding: 1rem;
		border: 1px solid #1a3040;
		background: #0f2035;
		margin-bottom: 0.75rem;
		display: flex;
		gap: 1rem;
		align-items: end;
		flex-wrap: wrap;
	}
	.menu label { display: flex; flex-direction: column; gap: 0.25rem; }

	.msg {
		padding: 0.5rem;
		background: #0f2035;
		border-left: 3px solid #7fcfff;
		margin-bottom: 0.5rem;
		font-family: monospace;
	}

	.grid {
		display: grid;
		grid-template-columns: 1fr 320px;
		gap: 0.75rem;
	}
	@media (max-width: 1000px) {
		.grid { grid-template-columns: 1fr; }
	}
	.mapwrap { background: #0f2035; border: 1px solid #1a3040; }
	.map { width: 100%; height: auto; display: block; }
	.side { display: flex; flex-direction: column; gap: 0.5rem; }
	.panel {
		border: 1px solid #1a3040;
		background: #0f2035;
		padding: 0.5rem 0.75rem;
	}
	.panel h3 {
		margin: 0 0 0.4rem;
		color: #7fcfff;
		font-size: 0.9rem;
		text-transform: uppercase;
		letter-spacing: 0.1rem;
	}
	.row { display: flex; gap: 0.4rem; align-items: end; flex-wrap: wrap; margin-top: 0.25rem; }
	.qty-panel { display: flex; flex-direction: column; gap: 0.5rem; margin-top: 0.25rem; }
	.qty-input {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 0.5rem;
		background: #081826;
		border: 1px solid #1a3040;
		padding: 0.35rem 0.5rem;
	}
	.qty-input span { color: #6a9abf; font-size: 0.85rem; }
	.qty-input input { width: 90px; text-align: right; font-size: 1rem; }
	.qty-buttons {
		display: grid;
		grid-template-columns: repeat(2, 1fr);
		gap: 0.35rem;
	}
	.qty-buttons button { padding: 0.4rem 0.5rem; }
	.qty-buttons button.primary { background: #2a5a8a; border-color: #7fcfff; grid-column: span 2; }
	.qty-buttons button.primary:hover:not(:disabled) { background: #3a6a9a; }
	.hint { color: #6a9abf; font-size: 0.85rem; margin: 0.4rem 0 0; }

	button {
		background: #1a3a5a;
		color: #d0e6f5;
		border: 1px solid #2a5a8a;
		padding: 0.3rem 0.6rem;
		cursor: pointer;
		font-family: inherit;
	}
	button:hover:not(:disabled) { background: #2a5a8a; }
	button:disabled { opacity: 0.4; cursor: not-allowed; }
	button.danger { background: #4a1a1a; border-color: #8a3a3a; color: #ffdcdc; }
	button.danger:hover:not(:disabled) { background: #8a3a3a; }
	.tiny { font-size: 0.7rem; padding: 0.15rem 0.4rem; }
	input, select {
		background: #081826;
		color: #d0e6f5;
		border: 1px solid #1a3040;
		padding: 0.2rem 0.35rem;
		font-family: inherit;
		width: 70px;
	}

	.territory { cursor: default; transition: filter 0.15s, stroke 0.15s; }
	/* No custom stroke on mountain hexes — the tiled pattern is enough. */
	.territory.selectable {
		cursor: pointer;
		stroke: #ffffff !important;
		stroke-width: 3 !important;
		filter: drop-shadow(0 0 4px rgba(255, 255, 255, 0.65));
	}
	.territory.selectable:hover { filter: brightness(1.4) drop-shadow(0 0 6px #fff); }
	.territory.selected-from { stroke: #fff !important; stroke-width: 4 !important; filter: drop-shadow(0 0 8px #fff) !important; }
	.territory.selected-to { stroke: #ff0 !important; stroke-width: 4 !important; filter: drop-shadow(0 0 8px #ffff7f) !important; }
	.territory.drag-source { stroke: #ffffff !important; stroke-width: 4 !important; filter: drop-shadow(0 0 10px #fff) !important; }
	.territory.drag-attack-candidate { stroke: #ffe14a !important; stroke-width: 3 !important; filter: drop-shadow(0 0 6px rgba(255, 225, 74, 0.7)); }
	.territory.drag-attack-target { stroke: #ffe14a !important; stroke-width: 5 !important; filter: drop-shadow(0 0 14px #ffe14a) !important; }
	.territory.drag-move-candidate { stroke: #7fcfff !important; stroke-width: 3 !important; filter: drop-shadow(0 0 6px rgba(127, 207, 255, 0.7)); }
	.territory.drag-move-target { stroke: #7fcfff !important; stroke-width: 5 !important; filter: drop-shadow(0 0 14px #7fcfff) !important; }
	.territory.drag-ferry-candidate { stroke: #c68fff !important; stroke-width: 3 !important; filter: drop-shadow(0 0 6px rgba(198, 143, 255, 0.7)); }
	.territory.drag-ferry-target { stroke: #c68fff !important; stroke-width: 5 !important; filter: drop-shadow(0 0 14px #c68fff) !important; }
	.territory.drag-invade-candidate { stroke: #ff6a6a !important; stroke-width: 3 !important; filter: drop-shadow(0 0 6px rgba(255, 106, 106, 0.7)); }
	.territory.drag-invade-target { stroke: #ff6a6a !important; stroke-width: 5 !important; filter: drop-shadow(0 0 14px #ff6a6a) !important; }
	.map { touch-action: none; user-select: none; }
	.node-label {
		fill: #fff;
		font-size: 20px;
		font-family: monospace;
		pointer-events: none;
		font-weight: bold;
	}
	.prod-star {
		fill: #ffe14a;
		font-size: 18px;
		pointer-events: none;
	}
	.isle-label {
		fill: #e0f0ff;
		font-size: 20px;
		font-family: 'Georgia', 'Times New Roman', serif;
		font-weight: bold;
		letter-spacing: 0.1em;
		opacity: 0.98;
		pointer-events: none;
	}
	.isle-label-outline {
		fill: none;
		stroke: #0a1420;
		stroke-width: 4px;
		stroke-linejoin: round;
		paint-order: stroke;
	}
	.isle-value {
		fill: #ffe14a;
		font-size: 14px;
		font-family: 'Georgia', 'Times New Roman', serif;
		font-weight: bold;
		opacity: 0.95;
		pointer-events: none;
	}
	.city-label {
		fill: #ffe14a;
		font-size: 11px;
		font-family: 'Georgia', 'Times New Roman', serif;
		font-style: italic;
		font-weight: bold;
		pointer-events: none;
	}
	.city-label-outline {
		fill: none;
		stroke: #0a1420;
		stroke-width: 3px;
		stroke-linejoin: round;
		paint-order: stroke;
	}

	.card-grid {
		display: grid;
		grid-template-columns: repeat(3, 1fr);
		gap: 0.4rem;
	}
	.card-tile {
		display: flex;
		flex-direction: column;
		align-items: center;
		justify-content: space-between;
		padding: 0.5rem 0.25rem;
		border-radius: 6px;
		background: linear-gradient(180deg, #0e2a48, #081826);
		border: 1px solid #2a4a6a;
		box-shadow: inset 0 0 0 1px rgba(255, 255, 255, 0.03), 0 2px 4px rgba(0, 0, 0, 0.35);
		cursor: pointer;
		min-height: 74px;
		transition: transform 0.1s, box-shadow 0.1s;
		color: #d0e6f5;
		font-family: inherit;
	}
	.card-tile:hover:not(.disabled) {
		transform: translateY(-2px);
		box-shadow: 0 4px 12px rgba(74, 159, 207, 0.35);
	}
	.card-tile.disabled { opacity: 0.35; cursor: not-allowed; }
	.card-tile .card-icon {
		font-size: 1.6rem;
		line-height: 1;
		margin-bottom: 0.3rem;
	}
	.card-tile .card-name {
		font-size: 0.7rem;
		text-align: center;
		font-weight: bold;
		letter-spacing: 0.03em;
		color: #e0f0ff;
		line-height: 1.15;
	}
	/* Category tints */
	.card-tile.kind-attack { border-top: 3px solid #ff6a6a; }
	.card-tile.kind-defense { border-top: 3px solid #7fcfff; }
	.card-tile.kind-boost { border-top: 3px solid #ffe14a; }
	.card-tile.kind-movement { border-top: 3px solid #c68fff; }
	.card-tile.kind-terrain { border-top: 3px solid #7fff7f; }

	.card-tooltip {
		position: fixed;
		z-index: 1000;
		background: #0a1420;
		border: 1px solid #2a4a6a;
		border-radius: 6px;
		padding: 0.6rem 0.75rem;
		box-shadow: 0 4px 14px rgba(0, 0, 0, 0.6);
		color: #d0e6f5;
		font-size: 0.82rem;
		min-width: 220px;
		max-width: 280px;
		pointer-events: none;
	}
	.card-tooltip.kind-attack { border-top: 3px solid #ff6a6a; }
	.card-tooltip.kind-defense { border-top: 3px solid #7fcfff; }
	.card-tooltip.kind-boost { border-top: 3px solid #ffe14a; }
	.card-tooltip.kind-movement { border-top: 3px solid #c68fff; }
	.card-tooltip.kind-terrain { border-top: 3px solid #7fff7f; }
	.ct-header { display: flex; align-items: center; gap: 0.4rem; margin-bottom: 0.35rem; }
	.ct-header strong { color: #e0f0ff; font-size: 0.95rem; }
	.ct-icon { font-size: 1.3rem; line-height: 1; }
	.ct-kind {
		margin-left: auto;
		font-size: 0.65rem;
		text-transform: uppercase;
		letter-spacing: 0.1em;
		color: #7fcfff;
		background: #10304a;
		padding: 2px 6px;
		border-radius: 3px;
	}
	.ct-desc { color: #d0e6f5; line-height: 1.4; margin-bottom: 0.35rem; }
	.ct-when { color: #7fcfff; font-size: 0.72rem; }
	.log {
		list-style: none;
		padding: 0;
		margin: 0;
		max-height: 260px;
		overflow-y: auto;
		font-size: 0.8rem;
	}
	.log li {
		padding: 0.2rem 0;
		border-bottom: 1px solid #1a3040;
		display: flex;
		gap: 0.4rem;
		align-items: baseline;
	}
	.log li.attack { color: #ffbb99; }
	.log li.card { color: #ffe14a; }
	.log li.event { color: #ff99ff; }
	.log li.defeat { color: #ff9999; }
	.turn-tag { color: #4a7a9a; font-family: monospace; font-size: 0.7rem; }
	.pdot { width: 10px; height: 10px; border-radius: 50%; display: inline-block; }

	.analytics {
		border: 1px solid #1a3040;
		background: #0f2035;
		padding: 0.75rem 1rem;
		margin-top: 0.75rem;
	}
	.charts {
		display: grid;
		grid-template-columns: 1fr 1fr 1fr;
		gap: 1rem;
	}
	.chart.stat-table { min-width: 0; }
	.chart.stat-table table { font-size: 0.75rem; }
	.dbg-row { display: flex; align-items: center; gap: 0.5rem; margin: 0.35rem 0; }

	.debug-panel {
		border: 1px solid #4a3a1a;
		background: linear-gradient(180deg, #1a1a20, #12121a);
		border-radius: 8px;
		padding: 1rem 1.25rem 0.85rem;
		margin: 0 0 0.75rem;
		box-shadow: 0 4px 14px rgba(0, 0, 0, 0.4), inset 0 0 20px rgba(255, 190, 60, 0.03);
	}
	.debug-header {
		display: flex;
		align-items: center;
		gap: 0.6rem;
		margin-bottom: 0.75rem;
	}
	.debug-header h2 {
		margin: 0;
		color: #e0e0ea;
		font-size: 1.05rem;
		letter-spacing: 0.05em;
		font-weight: 500;
	}
	.debug-badge {
		background: repeating-linear-gradient(45deg, #ffbe3c, #ffbe3c 5px, #1a1a20 5px, #1a1a20 10px);
		color: #1a1a20;
		font-family: monospace;
		font-size: 0.7rem;
		font-weight: bold;
		padding: 0.2rem 0.55rem;
		border-radius: 3px;
		letter-spacing: 0.15em;
	}
	.close-x {
		margin-left: auto;
		background: transparent;
		border: none;
		color: #7a7a85;
		font-size: 1rem;
		cursor: pointer;
		padding: 0.25rem 0.5rem;
	}
	.close-x:hover { color: #e0e0ea; background: rgba(255, 255, 255, 0.05); }

	.debug-options {
		display: grid;
		grid-template-columns: 1fr 1fr;
		gap: 0.7rem;
	}
	@media (max-width: 800px) {
		.debug-options { grid-template-columns: 1fr; }
	}
	.toggle-card {
		display: flex;
		align-items: flex-start;
		gap: 0.75rem;
		padding: 0.75rem 0.85rem;
		background: #0f1218;
		border: 1px solid #2a2a35;
		border-radius: 6px;
		cursor: pointer;
		transition: border-color 0.15s, background 0.15s;
	}
	.toggle-card:hover { border-color: #4a4a5a; background: #14171f; }
	.toggle-card.on { border-color: #ffbe3c; background: #1a1712; }
	.toggle-card input[type='checkbox'] {
		position: absolute;
		opacity: 0;
		pointer-events: none;
	}
	.toggle-slot {
		width: 34px;
		height: 20px;
		border-radius: 10px;
		background: #2a2a35;
		position: relative;
		flex: none;
		margin-top: 2px;
		transition: background 0.15s;
	}
	.toggle-card.on .toggle-slot { background: #ffbe3c; }
	.toggle-thumb {
		position: absolute;
		top: 2px;
		left: 2px;
		width: 16px;
		height: 16px;
		background: #e0e0ea;
		border-radius: 50%;
		transition: left 0.15s;
	}
	.toggle-card.on .toggle-thumb { left: 16px; background: #1a1a20; }
	.toggle-text { flex: 1; }
	.toggle-title { color: #e0e0ea; font-weight: bold; font-size: 0.9rem; margin-bottom: 0.15rem; }
	.toggle-desc { color: #8a8a95; font-size: 0.78rem; line-height: 1.35; }

	.debug-footer {
		margin-top: 0.65rem;
		color: #7a7a85;
		font-size: 0.75rem;
		font-style: italic;
		text-align: right;
	}

	.hex-tooltip {
		position: fixed;
		z-index: 1000;
		background: #0a1420;
		border: 1px solid #2a4a6a;
		border-radius: 6px;
		padding: 0.5rem 0.75rem;
		box-shadow: 0 4px 14px rgba(0, 0, 0, 0.6);
		color: #d0e6f5;
		font-size: 0.85rem;
		min-width: 200px;
		max-width: 280px;
		pointer-events: none;
	}
	.tt-title { display: flex; align-items: center; gap: 0.4rem; }
	.tt-title strong { color: #e0f0ff; font-size: 0.95rem; }
	.tt-owner-dot { width: 10px; height: 10px; border-radius: 50%; display: inline-block; flex: none; }
	.tt-armies { margin-left: auto; color: #ffe14a; font-family: monospace; font-weight: bold; }
	.tt-owner { color: #7fcfff; font-size: 0.75rem; margin-top: 2px; }
	.tt-city { color: #ffe14a; font-style: italic; font-size: 0.8rem; margin-top: 3px; }
	.tt-terrain { margin-top: 6px; padding-top: 6px; border-top: 1px solid #1a3040; }
	.tt-terrain-name { color: #ffbb99; font-weight: bold; font-size: 0.85rem; }
	.tt-terrain-desc { color: #a8bfd4; font-size: 0.78rem; margin-top: 2px; line-height: 1.35; }
	.tt-fort { color: #7fcfff; font-size: 0.78rem; margin-top: 6px; }

	.start-prompt {
		display: flex;
		align-items: center;
		gap: 1rem;
		background: linear-gradient(135deg, #10304a, #0a2540);
		border: 2px solid #4a9fcf;
		border-radius: 8px;
		padding: 1rem 1.25rem;
		margin: 0.75rem 0;
		box-shadow: 0 0 20px rgba(74, 159, 207, 0.35);
	}
	.start-prompt h2 { margin: 0 0 0.15rem; color: #e0f0ff; font-size: 1.15rem; }
	.start-prompt p { margin: 0; color: #a8bfd4; font-size: 0.9rem; }
	.start-prompt > div:first-child { flex: 1 1 auto; }
	.start-prompt > button { margin-left: auto; }
	button.big { padding: 0.75rem 1.5rem; font-size: 1rem; font-weight: bold; }
	button.primary { background: #2a5a8a; border-color: #7fcfff; color: #fff; }
	button.primary:hover:not(:disabled) { background: #3a6a9a; }
	.chart {
		background: #081826;
		padding: 0.5rem;
		border: 1px solid #1a3040;
	}
	.chart h3 {
		margin: 0 0 0.25rem;
		font-size: 0.75rem;
		color: #6a9abf;
		text-transform: uppercase;
		letter-spacing: 0.1rem;
	}
	.chart svg { width: 100%; height: auto; }
	.axis { fill: #6a9abf; font-size: 10px; font-family: monospace; }
	.stats-table {
		width: 100%;
		border-collapse: collapse;
		margin-top: 0.75rem;
		font-size: 0.85rem;
	}
	.stats-table th, .stats-table td {
		text-align: left;
		padding: 0.3rem 0.5rem;
		border-bottom: 1px solid #1a3040;
	}
	.stats-table th {
		color: #6a9abf;
		font-weight: normal;
		text-transform: uppercase;
		font-size: 0.7rem;
	}
	@media (max-width: 1100px) {
		.charts { grid-template-columns: 1fr; }
	}

	.banner {
		padding: 1rem;
		margin-bottom: 0.5rem;
		text-align: center;
		border: 2px solid;
	}
	.banner.win { border-color: #7fcfff; background: #0f3a55; }
	.banner.lose { border-color: #d44; background: #3a0f0f; }
</style>
