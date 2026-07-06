<script lang="ts">
	import { onMount } from 'svelte';
	import { decodeRecap, type RecapData, type RecapTurningPoint } from '$lib/recap';
	import { headlineParts, reconstructOwnersAtTurn, reconstructEdgesAtTurn } from '$lib/summary';
	import { PLAYERS, PLAYER_COLORS, PLAYER_NAMES, newGame, clearSavedGame, type Player } from '$lib/game';
	import { generateMap, type GameMap } from '$lib/map';
	import { base } from '$app/paths';
	import { goto } from '$app/navigation';
	import TurningPointCompareModal from '$lib/components/TurningPointCompareModal.svelte';
	import TpMiniMap from '$lib/components/TpMiniMap.svelte';

	let data = $state<RecapData | null>(null);
	let invalid = $state(false);
	let linkCopied = $state(false);
	// Regenerated from the seed alone — see map.ts's generateMap — so the
	// recap link doesn't need to embed the (much heavier) hex geometry.
	let map = $state<GameMap | null>(null);
	let openTurningPoint = $state<number | null>(null);
	// Cross-highlighting between the turning-point list and the numbered dots
	// on the charts: hovering either side lights up the other.
	let hoverTp = $state<number | null>(null);
	// Shared hover crosshair across both charts (they share an x axis, so one
	// index drives the vertical line + readout in both).
	let hoverIdx = $state<number | null>(null);

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

	// Chart plot area. The viewBox is CHART_W + 85 wide: 30px left gutter for
	// the y axis labels, ~55px right gutter for the direct line-end labels.
	const CHART_W = 560;
	const CHART_H = 180;
	type ChartField = 'territories' | 'armies';

	function xAt(i: number, len: number): number {
		return 30 + (len > 1 ? (i * CHART_W) / (len - 1) : 0);
	}
	function yAt(v: number, max: number): number {
		return 5 + (CHART_H - (v / max) * CHART_H);
	}

	function chartPoints(hist: RecapData['history'], p: Player, field: ChartField, max: number) {
		return hist.map((s, i) => `${xAt(i, hist.length)},${yAt(s[field][p], max)}`).join(' ');
	}

	// ~5 evenly spaced turn labels along the x axis (deduped for short games).
	function xTicks(hist: RecapData['history']): { x: number; turn: number }[] {
		const len = hist.length;
		if (len < 2) return [];
		const idxs = [...new Set([0, 1, 2, 3, 4].map((k) => Math.round((k * (len - 1)) / 4)))];
		return idxs.map((i) => ({ x: xAt(i, len), turn: hist[i].turn }));
	}

	// Direct labels at each line's right end (clearer than a legend), nudged
	// apart vertically so players who finish at similar values stay readable
	// (eliminated players all end at 0, so collisions are the common case).
	function endLabels(hist: RecapData['history'], field: ChartField, max: number): { p: Player; y: number }[] {
		const last = hist[hist.length - 1];
		if (!last) return [];
		const labels = PLAYERS.map((p) => ({ p, y: yAt(last[field][p], max) })).sort((a, b) => a.y - b.y);
		for (let i = 1; i < labels.length; i++) {
			if (labels[i].y - labels[i - 1].y < 10) labels[i].y = labels[i - 1].y + 10;
		}
		return labels;
	}

	// First snapshot where a player's territory count hit zero (they never
	// come back from that — there's no un-elimination).
	function elimination(hist: RecapData['history'], p: Player): { idx: number; turn: number } | null {
		for (let i = 1; i < hist.length; i++) {
			if (hist[i].territories[p] === 0 && hist[i - 1].territories[p] > 0) return { idx: i, turn: hist[i].turn };
		}
		return null;
	}

	// Where a turning point's numbered dot sits on a chart: on the winner's
	// line, at the snapshot AFTER the turn (history is start-of-turn, so
	// turn+1 is where the swing has landed). The final turn has no such
	// snapshot — fall back to the end-of-game values at the last x position.
	function tpMarker(d: RecapData, tp: RecapTurningPoint, field: ChartField, max: number): { x: number; y: number } | null {
		if (!d.winner) return null;
		const len = d.history.length;
		if (len === 0) return null;
		const idx = d.history.findIndex((h) => h.turn === tp.turn + 1);
		if (idx >= 0) return { x: xAt(idx, len), y: yAt(d.history[idx][field][d.winner], max) };
		const finalValue =
			field === 'territories'
				? territoriesFromOwners(d.finalOwners)[d.winner]
				: (d.finalArmies?.[d.winner] ?? d.history[len - 1][field][d.winner]);
		return { x: xAt(len - 1, len), y: yAt(finalValue, max) };
	}

	function chartHover(e: MouseEvent, len: number) {
		const rect = (e.currentTarget as SVGSVGElement).getBoundingClientRect();
		const vx = ((e.clientX - rect.left) / rect.width) * (CHART_W + 85);
		const xStep = len > 1 ? CHART_W / (len - 1) : 1;
		const i = Math.round((vx - 30) / xStep);
		hoverIdx = i >= 0 && i < len ? i : null;
	}

	// Fallback for turns with no history snapshot (history is captured at the
	// start of each turn, so the final turn has no "after" entry): territory
	// counts can always be recovered from an owner snapshot. Armies can't —
	// the caller supplies those separately when it has them.
	function territoriesFromOwners(owners: (Player | null)[]): Record<Player, number> {
		const counts = Object.fromEntries(PLAYERS.map((p) => [p, 0])) as Record<Player, number>;
		for (const o of owners) if (o) counts[o]++;
		return counts;
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
		{@const maxTerr = Math.max(1, ...d.history.flatMap((h) => PLAYERS.map((p) => h.territories[p])))}
		{@const maxArm = Math.max(1, ...d.history.flatMap((h) => PLAYERS.map((p) => h.armies[p])))}
		{@const finalTerr = territoriesFromOwners(d.finalOwners)}
		{@const last = d.history[d.history.length - 1]}
		<!-- Lanes opened by cards during play (Ferry / Water Invasion) — every
		     card lane pushes a seaLane edge event; map-generated lanes don't.
		     Rendered in a distinct color on every mini map. -->
		{@const createdLaneKeys = new Set(
			d.edgeEvents.filter((e) => e.kind === 'seaLane' && e.added).map((e) => `${e.edge[0]},${e.edge[1]}`)
		)}
		<section
			class="banner"
			style={d.winner
				? `border-color: ${PLAYER_COLORS[d.winner]}; background: color-mix(in srgb, ${PLAYER_COLORS[d.winner]} 22%, #0a1420);`
				: ''}
		>
			<h1>{d.winner ? `${PLAYER_NAMES[d.winner]} conquered the isles.` : 'Game Over'}</h1>
			<p class="sub">Final recap — {d.turn} turns played.</p>
			<div class="banner-actions">
				<button class="primary" onclick={playSameMap}>Play Same Map</button>
				<button class="secondary" onclick={startFreshAndGoHome}>New Random Map</button>
				<button onclick={copyLink}>{linkCopied ? '✓ Copied!' : '🔗 Copy Share Link'}</button>
				<button class="ghost" onclick={startFreshAndGoHome}>Back to Main Page</button>
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
								class:hl={hoverTp === i}
								onclick={() => map && (openTurningPoint = i)}
								onmouseenter={() => (hoverTp = i)}
								onmouseleave={() => (hoverTp = null)}
							>
								<span class="tp-num" class:star={tp.isFinal}>{tp.isFinal ? '★' : i + 1}</span>
								<span class="tp-turn">Turn {tp.turn}</span>
								<span class="tp-headline">{#each headlineParts(tp.headline) as part}{#if part.color}<span style="color: {part.color}">{part.text}</span>{:else}{part.text}{/if}{/each}</span>
								{#if tp.delta !== 0}
									<span class="tp-swing" class:pos={tp.delta > 0} class:neg={tp.delta < 0} title="Change in territories, and the winner's total after this turn">
										{tp.delta > 0 ? '+' : ''}{tp.delta} <span class="tp-total">→ {tp.territoriesAfter}</span>
									</span>
								{:else}
									<!-- Big-battle pick: no hex changed hands, so show the army
									     swing that actually earned this turn its spot instead. -->
									<span class="tp-swing" class:pos={tp.armyDelta > 0} class:neg={tp.armyDelta < 0}>
										{tp.armyDelta > 0 ? '+' : ''}{tp.armyDelta} armies
									</span>
								{/if}
								{#if map}<span class="tp-chevron" aria-hidden="true">›</span>{/if}
							</li>
						{/each}
					</ol>
				</section>
			{/if}
			<section class="analytics">
				{#snippet chart(field: 'territories' | 'armies', max: number)}
					{@const len = d.history.length}
					<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
					<!-- viewBox starts above y=0: turning-point dots (r up to 9) are
					     centered on line values as high as y=5, so without the
					     headroom they clip at the top edge. -->
					<svg
						viewBox="0 -10 {CHART_W + 85} {CHART_H + 40}"
						role="img"
						onmousemove={(e) => chartHover(e, len)}
						onmouseleave={() => (hoverIdx = null)}
					>
						<line x1="30" y1={CHART_H + 5} x2={CHART_W + 35} y2={CHART_H + 5} stroke="#345" />
						<line x1="30" y1="5" x2="30" y2={CHART_H + 5} stroke="#345" />
						<line x1="30" y1={yAt(max / 2, max)} x2={CHART_W + 35} y2={yAt(max / 2, max)} stroke="#1f3a52" stroke-dasharray="4 4" />
						<text x="26" y="10" text-anchor="end" class="axis">{max}</text>
						<text x="26" y={yAt(max / 2, max) + 3} text-anchor="end" class="axis">{Math.round(max / 2)}</text>
						<text x="26" y={CHART_H + 8} text-anchor="end" class="axis">0</text>
						{#each xTicks(d.history) as t}
							<line x1={t.x} y1={CHART_H + 5} x2={t.x} y2={CHART_H + 9} stroke="#345" />
							<text x={t.x} y={CHART_H + 19} text-anchor="middle" class="axis">{t.turn}</text>
						{/each}
						{#each PLAYERS as p}
							<polyline fill="none" stroke={PLAYER_COLORS[p]} stroke-width="2" points={chartPoints(d.history, p, field, max)} />
						{/each}
						{#each endLabels(d.history, field, max) as l}
							<!-- +13 keeps the labels clear of a turning-point dot sitting
							     on the line's final point (dots reach r=9 on hover). -->
							<text x={xAt(len - 1, len) + 13} y={l.y + 3} class="line-label" fill={PLAYER_COLORS[l.p]}>{PLAYER_NAMES[l.p]}</text>
						{/each}
						{#each PLAYERS as p}
							{@const elim = elimination(d.history, p)}
							{#if elim}
								<text x={xAt(elim.idx, len)} y={CHART_H + 1} text-anchor="middle" class="elim-mark" fill={PLAYER_COLORS[p]}>✕<title>{PLAYER_NAMES[p]} eliminated on turn {elim.turn}</title></text>
							{/if}
						{/each}
						{#if hoverIdx != null && d.history[hoverIdx]}
							{@const hs = d.history[hoverIdx]}
							<line x1={xAt(hoverIdx, len)} y1="5" x2={xAt(hoverIdx, len)} y2={CHART_H + 5} stroke="#6a9abf" stroke-dasharray="3 3" opacity="0.6" pointer-events="none" />
							{#each PLAYERS as p}
								<circle cx={xAt(hoverIdx, len)} cy={yAt(hs[field][p], max)} r="3" fill={PLAYER_COLORS[p]} pointer-events="none" />
							{/each}
							<text x="36" y="16" class="hover-readout" pointer-events="none">Turn {hs.turn}:{#each PLAYERS as p}<tspan dx="8" fill={PLAYER_COLORS[p]}>{hs[field][p]}</tspan>{/each}</text>
						{/if}
						<!-- Numbered turning-point dots on the winner's line, matching
						     the chips in the list — hover either side to highlight the
						     other, click to open the compare modal. -->
						{#each d.turningPoints as tp, i}
							{@const m = tpMarker(d, tp, field, max)}
							{#if m}
								<g
									class="tp-dot"
									role="button"
									tabindex="0"
									aria-label="Open turning point at turn {tp.turn}"
									onclick={() => map && (openTurningPoint = i)}
									onkeydown={(e) => e.key === 'Enter' && map && (openTurningPoint = i)}
									onmouseenter={() => (hoverTp = i)}
									onmouseleave={() => (hoverTp = null)}
								>
									<circle cx={m.x} cy={m.y} r={hoverTp === i ? 9 : 7} fill="#1a1408" stroke="#ffd54a" stroke-width={hoverTp === i ? 2.5 : 1.5} />
									<text x={m.x} y={m.y + 2.8} text-anchor="middle" class="tp-dot-num">{tp.isFinal ? '★' : i + 1}</text>
								</g>
							{/if}
						{/each}
					</svg>
				{/snippet}
				<div class="charts">
					{#if map}
						<div class="chart">
							<h3>Final board</h3>
							<TpMiniMap {map} owners={d.finalOwners} edgeWalls={d.finalWalls} edgeSeaLanes={d.finalSeaLanes} {createdLaneKeys} />
						</div>
					{/if}
					<div class="chart">
						<h3>Territories owned</h3>
						{@render chart('territories', maxTerr)}
					</div>
					<div class="chart">
						<h3>Total armies</h3>
						{@render chart('armies', maxArm)}
					</div>
					<div class="chart stat-table">
						<h3>Stats</h3>
						<table class="stats-table">
							<thead>
								<tr>
									<th></th>
									<th>Territories</th>
									<th>Armies</th>
									<th title="Attacks won / lost">Battles W–L</th>
									<th title="Hexes captured / lost">Hexes +/−</th>
									<th title="Cards drawn">Cards</th>
								</tr>
							</thead>
							<tbody>
								{#each PLAYERS as p}
									{@const st = d.stats[p]}
									{@const elim = elimination(d.history, p)}
									<tr style={p === d.winner ? `background: color-mix(in srgb, ${PLAYER_COLORS[p]} 16%, transparent)` : ''}>
										<td>
											<span class="dot" style="background:{PLAYER_COLORS[p]}"></span> {PLAYER_NAMES[p]}
											{#if elim}<span class="elim" title="{PLAYER_NAMES[p]} eliminated on turn {elim.turn}">✕ turn {elim.turn}</span>{/if}
										</td>
										<td>{finalTerr[p]}</td>
										<td>{d.finalArmies?.[p] ?? last?.armies[p] ?? 0}</td>
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
			     is tagged, not when a history snapshot was taken. When a
			     snapshot is missing (the final turn has no start-of-next-turn
			     entry), synthesize one: territories from the owner snapshot,
			     armies from finalArmies (absent on old shared links — the
			     modal shows a placeholder then). -->
			{@const historyBefore =
				d.history.find((h) => h.turn === tp.turn) ?? { territories: territoriesFromOwners(ownersBefore) }}
			{@const historyAfter =
				d.history.find((h) => h.turn === tp.turn + 1) ??
				{ territories: territoriesFromOwners(ownersAfter), armies: tp.isFinal ? d.finalArmies : undefined }}
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
				{createdLaneKeys}
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
	.banner-actions button.primary {
		background: #ffd54a;
		border-color: #ffd54a;
		color: #1a1408;
		font-weight: 600;
	}
	.banner-actions button.primary:hover { background: #ffe27a; }
	.banner-actions button.secondary {
		background: #143524;
		border-color: #3f9d5c;
		color: #8fe3a8;
	}
	.banner-actions button.secondary:hover { background: #1a4530; }
	.banner-actions button.ghost {
		background: transparent;
		border-color: transparent;
		color: #8ab;
	}
	.banner-actions button.ghost:hover { background: rgba(255, 255, 255, 0.06); color: #d0e6f5; }

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
	.turning-points li.clickable:hover, .turning-points li.hl { background: #1e2c47; }
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
	.tp-total { color: #8ab; }
	.tp-chevron { flex: none; color: #567; font-size: 1rem; line-height: 1; }

	.analytics {
		border: 1px solid #1a3040;
		background: #0f2035;
		padding: 0.75rem 1rem;
	}
	.charts { display: grid; grid-template-columns: 1fr; gap: 1rem; }
	.chart svg { width: 100%; height: auto; }
	.chart h3 { margin: 0 0 0.4rem; font-size: 0.85rem; color: #8ab; text-transform: uppercase; letter-spacing: 0.05em; }
	.axis { font-size: 9px; fill: #6a9abf; }
	.line-label { font-size: 9px; font-weight: 600; }
	.elim-mark { font-size: 10px; cursor: default; }
	.hover-readout { font-size: 10px; fill: #8ab; }
	.tp-dot { cursor: pointer; }
	.tp-dot:focus { outline: none; }
	.tp-dot:focus circle { stroke-width: 2.5; }
	.tp-dot-num { font-size: 8px; font-weight: 700; fill: #ffd54a; pointer-events: none; }
	.elim { color: #c66; font-size: 0.7rem; margin-left: 0.35rem; white-space: nowrap; }
	.stats-table { width: 100%; border-collapse: collapse; font-size: 0.8rem; }
	.stats-table th, .stats-table td { text-align: left; padding: 0.3rem 0.5rem; border-bottom: 1px solid #1a3040; }
	.stats-table th { color: #6a9abf; font-weight: normal; text-transform: uppercase; font-size: 0.7rem; }
	.dot { display: inline-block; width: 9px; height: 9px; border-radius: 50%; margin-right: 0.3rem; }
</style>
