<script lang="ts">
	import { onMount } from 'svelte';
	import { decodeRecap, type RecapData } from '$lib/recap';
	import { headlineParts, reconstructOwnersAtTurn, reconstructEdgesAtTurn } from '$lib/summary';
	import { PLAYERS, PLAYER_COLORS, PLAYER_NAMES, newGame, clearSavedGame, type Player } from '$lib/game';
	import { generateMap, type GameMap } from '$lib/map';
	import { base } from '$app/paths';
	import { goto } from '$app/navigation';
	import TurningPointCompareModal from '$lib/components/TurningPointCompareModal.svelte';

	let data = $state<RecapData | null>(null);
	let invalid = $state(false);
	let linkCopied = $state(false);
	// Regenerated from the seed alone — see map.ts's generateMap — so the
	// recap link doesn't need to embed the (much heavier) hex geometry.
	let map = $state<GameMap | null>(null);
	let openTurningPoint = $state<number | null>(null);

	onMount(async () => {
		// Fragments never reach the server, so this only ever resolves
		// client-side — the prerendered HTML shell always shows "invalid"
		// until this runs.
		const hash = window.location.hash.replace(/^#/, '');
		const encoded = new URLSearchParams(hash).get('d');
		const decoded = encoded ? await decodeRecap(encoded) : null;
		if (!decoded) {
			invalid = true;
			return;
		}
		data = decoded;
		map = generateMap(decoded.seed);
	});

	function chartPoints(hist: RecapData['history'], p: Player, field: 'territories' | 'armies', max: number, w: number, h: number) {
		if (hist.length === 0) return '';
		const xStep = hist.length > 1 ? w / (hist.length - 1) : 0;
		return hist.map((s, i) => `${30 + i * xStep},${5 + (h - (s[field][p] / max) * h)}`).join(' ');
	}

	// reconstructOwnersAtTurn/reconstructEdgesAtTurn (see summary.ts) only
	// need these specific fields, not a full GameState — RecapData already
	// carries them as a lightweight stand-in.
	function ownersAtTurn(d: RecapData, turn: number): (Player | null)[] {
		return reconstructOwnersAtTurn({ states: d.finalOwners.map((owner) => ({ owner })), conquests: d.conquests }, turn);
	}
	function edgesAtTurn(d: RecapData, turn: number) {
		return reconstructEdgesAtTurn(
			{ map: { walls: d.finalWalls, seaLanes: d.finalSeaLanes }, edgeEvents: d.edgeEvents },
			turn
		);
	}

	function copyLink() {
		navigator.clipboard.writeText(window.location.href).then(() => {
			linkCopied = true;
			setTimeout(() => (linkCopied = false), 1500);
		});
	}

	// The `game` store is a module-level singleton shared across client-side
	// navigation, so clearing the save alone isn't enough — a finished game
	// left in the live store would just redirect straight back here (see the
	// $effect in routes/+page.svelte). newGame() resets the store itself.
	function playSameMap() {
		if (!data) return;
		clearSavedGame();
		newGame(2, 3, data.seed); // difficulty/startingArmies come from the seed itself
		goto(`${base}/`);
	}
	// "New Random Map" and "Back to Main Page" both land you on a fresh game
	// at '/' — there's no neutral "idle" state to return to otherwise, since
	// the store always holds a full GameState.
	function startFreshAndGoHome() {
		clearSavedGame();
		newGame(2, 3);
		goto(`${base}/`);
	}
</script>

<svelte:head>
	<title>Isle Wars — Recap</title>
</svelte:head>

<main>
	{#if invalid}
		<p class="msg">This recap link is invalid or incomplete.</p>
	{:else if !data}
		<p class="msg">Loading recap…</p>
	{:else}
		{@const d = data}
		{@const chartW = 560}
		{@const chartH = 180}
		{@const maxTerr = Math.max(1, ...d.history.flatMap((h) => PLAYERS.map((p) => h.territories[p])))}
		{@const maxArm = Math.max(1, ...d.history.flatMap((h) => PLAYERS.map((p) => h.armies[p])))}
		<section
			class="banner"
			style={d.winner
				? `border-color: ${PLAYER_COLORS[d.winner]}; background: color-mix(in srgb, ${PLAYER_COLORS[d.winner]} 22%, #0a1420);`
				: ''}
		>
			<h1>{d.winner ? `${PLAYER_NAMES[d.winner]} conquered the isles.` : 'Game Over'}</h1>
			<p class="sub">Final recap — {d.turn} turns played.</p>
			<div class="banner-actions">
				<button onclick={copyLink}>{linkCopied ? 'Copied!' : 'Copy Share Link'}</button>
				<button onclick={playSameMap}>Play Same Map</button>
				<button onclick={startFreshAndGoHome}>New Random Map</button>
				<button onclick={startFreshAndGoHome}>Back to Main Page</button>
			</div>
		</section>
		<div class="layout">
			{#if d.turningPoints.length > 0}
				<section class="turning-points">
					<h3>Turning points</h3>
					<ol>
						{#each d.turningPoints as tp, i}
							<li
								class:clickable={!!map}
								onclick={() => map && (openTurningPoint = i)}
							>
								<span class="tp-num" class:star={tp.isFinal}>{tp.isFinal ? '★' : i + 1}</span>
								<span class="tp-turn">Turn {tp.turn}</span>
								<span class="tp-headline">{#each headlineParts(tp.headline) as part}{#if part.color}<span style="color: {part.color}">{part.text}</span>{:else}{part.text}{/if}{/each}</span>
								{#if tp.delta !== 0}
									<span class="tp-swing" class:pos={tp.delta > 0} class:neg={tp.delta < 0}>
										{tp.delta > 0 ? '+' : ''}{tp.delta} ({tp.territoriesAfter})
									</span>
								{:else}
									<!-- Big-battle pick: no hex changed hands, so show the army
									     swing that actually earned this turn its spot instead. -->
									<span class="tp-swing" class:pos={tp.armyDelta > 0} class:neg={tp.armyDelta < 0}>
										{tp.armyDelta > 0 ? '+' : ''}{tp.armyDelta} armies
									</span>
								{/if}
							</li>
						{/each}
					</ol>
				</section>
			{/if}
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
								<polyline fill="none" stroke={PLAYER_COLORS[p]} stroke-width="2" points={chartPoints(d.history, p, 'territories', maxTerr, chartW, chartH)} />
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
								<polyline fill="none" stroke={PLAYER_COLORS[p]} stroke-width="2" points={chartPoints(d.history, p, 'armies', maxArm, chartW, chartH)} />
							{/each}
						</svg>
					</div>
					<div class="chart stat-table">
						<h3>Stats</h3>
						<table class="stats-table">
							<thead>
								<tr><th></th><th>T</th><th>A</th><th>W/L</th><th>+/−</th><th>Cards</th></tr>
							</thead>
							<tbody>
								{#each PLAYERS as p}
									{@const last = d.history[d.history.length - 1]}
									{@const st = d.stats[p]}
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
		</div>
		{#if map && openTurningPoint != null && d.turningPoints[openTurningPoint]}
			{@const tp = d.turningPoints[openTurningPoint]}
			{@const ownersBefore = ownersAtTurn(d, tp.turn - 1)}
			{@const ownersAfter = ownersAtTurn(d, tp.turn)}
			{@const edgesBefore = edgesAtTurn(d, tp.turn - 1)}
			{@const edgesAfter = edgesAtTurn(d, tp.turn)}
			<!-- Per-player territory/army totals for this turn — the one thing
			     that's ALWAYS informative even when the map itself is a no-op
			     (a pure army-count swing turning point has nothing to highlight
			     on the map, but the numbers behind it are still real data).
			     NOTE: history entries are snapshotted at the *start* of each
			     turn (see computeTurningPoints in summary.ts), so the pair
			     that brackets turn tp.turn's own actions is (tp.turn, tp.turn+1)
			     — one turn ahead of the map's own before/after convention
			     (tp.turn-1, tp.turn), which is keyed off when a conquest event
			     is tagged, not when a history snapshot was taken. -->
			{@const historyBefore = d.history.find((h) => h.turn === tp.turn)}
			{@const historyAfter = d.history.find((h) => h.turn === tp.turn + 1)}
			<!-- Ground truth for "what actually changed" is the before/after owner
			     snapshots, not the raw conquest log — a grid can have a conquest
			     event this turn and still show the same owner in both snapshots
			     (e.g. captured then recaptured back within the same turn), and
			     highlighting it then would show a capture stripe on a hex that
			     visibly didn't change. Only net ownership flips count. -->
			{@const netChangedGrids = map.grids.map((g) => g.id).filter((id) => ownersBefore[id] !== ownersAfter[id])}
			{@const changedGrids = netChangedGrids}
			{@const capturedFrom = Object.fromEntries(netChangedGrids.map((id) => [id, ownersBefore[id]])) as Record<number, Player | null>}
			{@const winnerInvolvedGrids = netChangedGrids.filter((id) => ownersAfter[id] === d.winner || ownersBefore[id] === d.winner)}
			{@const turnConquests = d.conquests.filter((c) => c.turn === tp.turn)}
			{@const paths = turnConquests
				.filter(
					(c) =>
						c.from != null &&
						netChangedGrids.includes(c.grid) &&
						(c.attacker === d.winner || c.defender === d.winner)
				)
				.map((c) => ({
					from: c.from as number,
					to: c.grid,
					armies: c.armies,
					color: c.attacker === d.winner ? '#fff' : '#ff5a5a',
					forfeited: c.forfeited
				}))}
			<!-- Committed army count per captured hex. When there's no capture
			     at all this turn (a pure army-swing turning point), fall back to
			     the top few per-hex swings recorded that turn (see game.ts's
			     recordHexArmyDeltas) — signed, since these are gains/losses on
			     hexes that never changed owner, not an attack's committed force. -->
			{@const captureArmyLabels = Object.fromEntries(
				turnConquests.filter((c) => netChangedGrids.includes(c.grid)).map((c) => [c.grid, c.armies])
			)}
			{@const hexSwingLabels = Object.fromEntries(
				d.hexArmyDeltas.filter((e) => e.turn === tp.turn).map((e) => [e.grid, e.delta])
			)}
			{@const armyLabels = Object.keys(captureArmyLabels).length > 0 ? captureArmyLabels : hexSwingLabels}
			<TurningPointCompareModal
				{map}
				turn={tp.turn}
				headline={tp.headline}
				{ownersBefore}
				{ownersAfter}
				{edgesBefore}
				{edgesAfter}
				{paths}
				{changedGrids}
				{capturedFrom}
				{armyLabels}
				{historyBefore}
				{historyAfter}
				otherPlayersCapture={netChangedGrids.length > 0 && winnerInvolvedGrids.length === 0}
				hasPrev={openTurningPoint > 0}
				hasNext={openTurningPoint < d.turningPoints.length - 1}
				onClose={() => (openTurningPoint = null)}
				onPrev={() => (openTurningPoint = (openTurningPoint ?? 0) - 1)}
				onNext={() => (openTurningPoint = (openTurningPoint ?? 0) + 1)}
			/>
		{/if}
	{/if}
</main>

<style>
	:global(body) {
		background: #0a1420;
		color: #d0e6f5;
		font-family: system-ui, sans-serif;
	}
	main {
		max-width: 1200px;
		margin: 0 auto;
		padding: 1rem;
	}
	.msg { text-align: center; padding: 3rem 1rem; color: #8ab; }
	.banner {
		padding: 1.25rem;
		margin-bottom: 1rem;
		text-align: center;
		border: 2px solid #345;
		background: #10182a;
	}
	.banner h1 { margin: 0 0 0.35rem; font-size: 1.4rem; }
	.banner .sub { margin: 0 0 0.6rem; color: #8ab; font-size: 0.9rem; }
	.banner-actions { display: flex; justify-content: center; gap: 0.5rem; flex-wrap: wrap; margin-top: 0.5rem; }
	.banner-actions button {
		background: #16243a;
		border: 1px solid #345;
		color: #d0e6f5;
		border-radius: 4px;
		padding: 0.45rem 0.9rem;
		font-size: 0.85rem;
		cursor: pointer;
	}
	.banner-actions button:hover { background: #1e2c47; }

	.layout {
		display: grid;
		grid-template-columns: 1fr 1fr;
		align-items: start;
		gap: 1rem;
	}
	@media (max-width: 1100px) {
		.layout { grid-template-columns: 1fr; }
		.charts { grid-template-columns: 1fr !important; }
	}

	.turning-points {
		padding: 0.75rem 1rem;
		border: 1px solid #345;
		background: #10182a;
	}
	.turning-points h3 { margin: 0 0 0.5rem; font-size: 0.95rem; color: #ffd54a; }
	.turning-points ol { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 0.3rem; }
	.turning-points li { display: flex; align-items: center; gap: 0.6rem; padding: 0.35rem 0.5rem; border-radius: 4px; }
	.turning-points li.clickable { cursor: pointer; }
	.turning-points li.clickable:hover { background: #1e2c47; }
	.tp-num {
		flex: none; width: 1.5rem; height: 1.5rem; border-radius: 50%;
		background: #1a1408; border: 2px solid #ffd54a; color: #ffd54a;
		font-weight: 700; font-size: 0.8rem;
		display: flex; align-items: center; justify-content: center;
	}
	.tp-num.star { background: #ffd54a; color: #1a1408; font-size: 0.9rem; }
	.tp-turn { flex: none; color: #8ab; font-size: 0.8rem; }
	.tp-headline { flex: 1; }
	.tp-swing { flex: none; font-size: 0.8rem; }
	.tp-swing.pos { color: #7fff7f; }
	.tp-swing.neg { color: #ff7f7f; }

	.analytics {
		border: 1px solid #1a3040;
		background: #0f2035;
		padding: 0.75rem 1rem;
	}
	.charts { display: grid; grid-template-columns: 1fr; gap: 1rem; }
	.chart svg { width: 100%; height: auto; }
	.chart h3 { margin: 0 0 0.4rem; font-size: 0.85rem; color: #8ab; text-transform: uppercase; letter-spacing: 0.05em; }
	.axis { font-size: 9px; fill: #6a9abf; }
	.stats-table { width: 100%; border-collapse: collapse; font-size: 0.8rem; }
	.stats-table th, .stats-table td { text-align: left; padding: 0.3rem 0.5rem; border-bottom: 1px solid #1a3040; }
	.stats-table th { color: #6a9abf; font-weight: normal; text-transform: uppercase; font-size: 0.7rem; }
	.dot { display: inline-block; width: 9px; height: 9px; border-radius: 50%; margin-right: 0.3rem; }
</style>
