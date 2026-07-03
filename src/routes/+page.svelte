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
		tradeCards,
		loadSavedGame,
		clearSavedGame,
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
		type Player,
		type CardType
	} from '$lib/game';
	import { runAiTurn } from '$lib/ai';

	let showAnalytics = $state(false);

	let placeQty = $state(1);
	let moveQty = $state(1);
	let airQty = $state(1);
	let moveInQty = $state(0);
	let selectedCardIdxs = $state<number[]>([]);
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

	function toggleCard(idx: number) {
		if (selectedCardIdxs.includes(idx)) selectedCardIdxs = selectedCardIdxs.filter((i) => i !== idx);
		else selectedCardIdxs = [...selectedCardIdxs, idx];
	}

	function doTrade() {
		if (selectedCardIdxs.length !== 3) return;
		const ok = tradeCards([...selectedCardIdxs]);
		selectedCardIdxs = [];
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
		<h1>ISLE WARS</h1>
		<div class="scoreboard">
			{#each PLAYERS as p}
				<div class="score" class:current={$game.current === p} class:dead={!$game.alive[p]}>
					<span class="dot" style="background:{PLAYER_COLORS[p]}"></span>
					<strong>{PLAYER_NAMES[p]}</strong>
					<span>{countryCount($game, p)} / {$game.map.grids.length}</span>
					<span class="bonus">+{fullIslandBonus($game, p)}</span>
				</div>
			{/each}
		</div>
		<div class="actions">
			<button onclick={() => (showMenu = !showMenu)}>{showMenu ? 'Close' : 'New Game'}</button>
			<button onclick={() => (showAnalytics = !showAnalytics)}>{showAnalytics ? 'Hide' : 'Analytics'}</button>
			<button class="danger" onclick={confirmClearSave}>Clear Save</button>
			<label class="speed">AI:
				<select bind:value={aiSpeed}>
					<option value={1}>1× (normal)</option>
					<option value={2}>2× (fast)</option>
					<option value={0}>instant</option>
				</select>
			</label>
			<span class="turn">Turn {$game.turn}</span>
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

	{#if showAnalytics}
		{@const hist = $game.history}
		{@const maxTerr = Math.max(1, ...hist.flatMap((h) => PLAYERS.map((p) => h.territories[p])))}
		{@const maxArm = Math.max(1, ...hist.flatMap((h) => PLAYERS.map((p) => h.armies[p])))}
		{@const chartW = 560}
		{@const chartH = 180}
		{@const xStep = hist.length > 1 ? chartW / (hist.length - 1) : 0}
		<section class="analytics">
			<h2>Analytics</h2>
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
			</div>
			<table class="stats-table">
				<thead>
					<tr>
						<th></th>
						<th>Territories</th>
						<th>Armies</th>
						<th>Islands</th>
						<th>Atk W/L</th>
						<th>Gained</th>
						<th>Lost</th>
						<th>Cards drawn</th>
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
							<td>{last?.islands[p] ?? 0}</td>
							<td>{st.attacksWon} / {st.attacksLost}</td>
							<td>{st.territoriesCaptured}</td>
							<td>{st.territoriesLost}</td>
							<td>{st.cardsDrawn}</td>
						</tr>
					{/each}
				</tbody>
			</table>
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

	<div class="msg">{$game.message}</div>

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
						<!-- Tree 1: trunk + crown -->
						<rect x="10.5" y="20" width="3" height="16" fill="#4a2d18" opacity="0.6" />
						<circle cx="12" cy="16" r="10" fill="#000" opacity="0.28" />
						<circle cx="12" cy="14" r="3" fill="#5cb85c" opacity="0.32" />
						<!-- Tree 2: trunk + crown -->
						<rect x="32.5" y="34" width="3" height="14" fill="#4a2d18" opacity="0.6" />
						<circle cx="34" cy="30" r="11" fill="#000" opacity="0.28" />
						<circle cx="34" cy="28" r="3.2" fill="#5cb85c" opacity="0.32" />
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
					<line x1={l.x1} y1={l.y1} x2={l.x2} y2={l.y2} stroke="#4a6a7a" stroke-width="1.5" stroke-dasharray="4 3" pointer-events="none" />
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
						onpointerenter={() => (hoveredGrid = g.id)}
						onpointerleave={() => { if (hoveredGrid === g.id) hoveredGrid = null; }}
						role="button"
						tabindex="0"
					/>
				{/each}
				<!-- Terrain overlays: mountains + forests -->
				{#each $game.map.grids as g}
					{#if g.terrain === 'mountain'}
						<polygon points={polygonPoints(g.cell)} fill="url(#mountain-pattern)" pointer-events="none" />
					{:else if g.terrain === 'forest'}
						<polygon points={polygonPoints(g.cell)} fill="url(#forest-pattern)" pointer-events="none" />
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
				<h3>Your cards</h3>
				{#if $game.hands[HUMAN].length === 0}
					<p class="hint">No cards.</p>
				{:else}
					<ul class="cards">
						{#each $game.hands[HUMAN] as c, i}
							<li>
								<label>
									<input type="checkbox" checked={selectedCardIdxs.includes(i)} onchange={() => toggleCard(i)} />
									{CARD_LABELS[c]}
								</label>
								<button class="tiny" onclick={() => playCard(i)}>Play</button>
							</li>
						{/each}
					</ul>
					<div class="row">
						<button disabled={selectedCardIdxs.length !== 3} onclick={doTrade}>Trade set (+5)</button>
					</div>
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
</main>

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
		padding: 0.5rem 0.75rem;
		background: #0f2035;
		margin-bottom: 0.75rem;
	}
	h1 {
		margin: 0;
		font-size: 1.5rem;
		letter-spacing: 0.3rem;
		color: #7fcfff;
	}
	.scoreboard {
		display: flex;
		gap: 0.75rem;
		margin-top: 0.5rem;
		flex-wrap: wrap;
	}
	.score {
		display: flex;
		align-items: center;
		gap: 0.4rem;
		padding: 0.25rem 0.5rem;
		border: 1px solid #1a3040;
		background: #081826;
		font-size: 0.9rem;
	}
	.score.current { border-color: #7fcfff; box-shadow: 0 0 8px #4a9fcf; }
	.score.dead { opacity: 0.4; text-decoration: line-through; }
	.dot { width: 12px; height: 12px; border-radius: 50%; display: inline-block; }
	.bonus { color: #ffe14a; }
	.actions { margin-top: 0.5rem; display: flex; gap: 0.5rem; align-items: center; flex-wrap: wrap; }
	.speed { display: flex; align-items: center; gap: 0.35rem; color: #6a9abf; font-size: 0.85rem; }
	.speed select { width: auto; }
	.turn { color: #7fcfff; font-family: monospace; }

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

	.cards { list-style: none; padding: 0; margin: 0; }
	.cards li { display: flex; justify-content: space-between; align-items: center; padding: 0.15rem 0; }
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
		margin-bottom: 0.75rem;
	}
	.analytics h2 {
		margin: 0 0 0.5rem;
		color: #7fcfff;
		font-size: 1rem;
		letter-spacing: 0.1rem;
	}
	.charts {
		display: grid;
		grid-template-columns: 1fr 1fr;
		gap: 1rem;
	}
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
	@media (max-width: 900px) {
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
