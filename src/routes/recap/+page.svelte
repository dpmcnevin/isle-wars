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
	// The selected "key moment": 0 = the starting map (before turn 1),
	// 1..N = the turning points in order (N being the final turn's ★ entry).
	// The mini maps below the charts always show the selected moment, and the
	// charts grey out everything that happens after it.
	let selected = $state(0);
	// Zoomed compare modal for the selected turning point (Esc closes it).
	let zoomOpen = $state(false);
	// Cross-highlighting between the moment chips and the numbered dots on the
	// charts: hovering either side lights up the other (tp index, not moment).
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
		const m = generateMap(decoded.seed);
		// The seed regenerates the ORIGINAL terrain; replay the game's terrain
		// changes (Deforestation / Oasis / Scorched Earth) forward so the map
		// matches the final board (reconstructTerrainAtTurn can then rewind it).
		for (const ev of decoded.terrainEvents ?? []) m.grids[ev.grid].terrain = ev.terrain;
		map = m;
	});

	const momentCount = $derived(data ? data.turningPoints.length + 1 : 0);

	function selectMoment(i: number) {
		if (!data) return;
		selected = Math.max(0, Math.min(momentCount - 1, i));
		if (selected === 0) zoomOpen = false; // the start map has no compare view
	}

	// Keyboard: ← / → step through the key moments (wrapping is intentional at
	// neither end), Esc closes the zoomed compare modal.
	function onKey(e: KeyboardEvent) {
		if (!data) return;
		const tag = (e.target as HTMLElement | null)?.tagName;
		if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
		if (e.key === 'Escape') {
			if (zoomOpen) {
				zoomOpen = false;
				e.preventDefault();
			}
			return;
		}
		if (e.key === 'ArrowLeft') {
			selectMoment(selected - 1);
			e.preventDefault();
		} else if (e.key === 'ArrowRight') {
			selectMoment(selected + 1);
			e.preventDefault();
		}
	}

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

	// The history index the selected moment has "reached": snapshots are taken
	// at the START of each turn, so the state after turning-point turn T is the
	// turn-T+1 snapshot. Charts grey out everything to the right of this.
	const reachedIdx = $derived.by(() => {
		if (!data) return 0;
		if (selected === 0) return 0;
		const tp = data.turningPoints[selected - 1];
		const idx = data.history.findIndex((h) => h.turn === tp.turn + 1);
		return idx >= 0 ? idx : data.history.length - 1; // final turn: nothing left to grey
	});

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

	// Everything the compare view needs for one turning point, computed from
	// the replay logs. Ground truth for "what actually changed" is the
	// before/after owner snapshots, not the raw conquest log — a grid can have
	// a conquest event this turn and still show the same owner in both
	// snapshots (captured then recaptured back within the turn), and
	// highlighting it then would stripe a hex that visibly didn't change.
	function tpView(d: RecapData, m: GameMap, tp: RecapTurningPoint) {
		const ownersBefore = ownersAtTurn(d, tp.turn - 1);
		const ownersAfter = ownersAtTurn(d, tp.turn);
		const edgesBefore = edgesAtTurn(d, tp.turn - 1);
		const edgesAfter = edgesAtTurn(d, tp.turn);
		const netChangedGrids = m.grids.map((g) => g.id).filter((id) => ownersBefore[id] !== ownersAfter[id]);
		const capturedFrom = Object.fromEntries(netChangedGrids.map((id) => [id, ownersBefore[id]])) as Record<
			number,
			Player | null
		>;
		const winnerInvolvedGrids = netChangedGrids.filter(
			(id) => ownersAfter[id] === d.winner || ownersBefore[id] === d.winner
		);
		const turnConquests = d.conquests.filter((c) => c.turn === tp.turn);
		const paths = turnConquests
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
			}));
		// Committed army count per captured hex. When there's no capture at all
		// this turn (a pure army-swing turning point), fall back to the top few
		// per-hex swings recorded that turn (see game.ts's recordHexArmyDeltas)
		// — signed, since these are gains/losses on hexes that never changed
		// owner, not an attack's committed force.
		const captureArmyLabels = Object.fromEntries(
			turnConquests.filter((c) => netChangedGrids.includes(c.grid)).map((c) => [c.grid, c.armies])
		);
		const hexSwingLabels = Object.fromEntries(
			d.hexArmyDeltas.filter((e) => e.turn === tp.turn).map((e) => [e.grid, e.delta])
		);
		const armyLabels = Object.keys(captureArmyLabels).length > 0 ? captureArmyLabels : hexSwingLabels;
		// Per-player totals bracketing this turn — history entries are
		// snapshotted at the START of each turn, so the pair that brackets turn
		// T's own actions is (T, T+1). When a snapshot is missing (the final
		// turn has no start-of-next-turn entry), synthesize one: territories
		// from the owner snapshot, armies from finalArmies (absent on old
		// shared links — the modal shows a placeholder then).
		const historyBefore =
			d.history.find((h) => h.turn === tp.turn) ?? { territories: territoriesFromOwners(ownersBefore) };
		const historyAfter =
			d.history.find((h) => h.turn === tp.turn + 1) ??
			{ territories: territoriesFromOwners(ownersAfter), armies: tp.isFinal ? d.finalArmies : undefined };
		return {
			ownersBefore,
			ownersAfter,
			edgesBefore,
			edgesAfter,
			paths,
			changedGrids: netChangedGrids,
			capturedFrom,
			armyLabels,
			historyBefore,
			historyAfter,
			otherPlayersCapture: netChangedGrids.length > 0 && winnerInvolvedGrids.length === 0
		};
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

<svelte:window onkeydown={onKey} />

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

		{#snippet chart(field: 'territories' | 'armies', max: number)}
			{@const len = d.history.length}
			{@const reachedX = xAt(reachedIdx, len)}
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
				<defs>
					<!-- Clips the full-color lines to everything at or before the
					     selected key moment; the plain grey underlay shows through
					     for the not-yet-reached future. -->
					<clipPath id="reached-{field}">
						<rect x="0" y="-10" width={reachedX} height={CHART_H + 40} />
					</clipPath>
				</defs>
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
				<!-- The future, greyed: full-length desaturated lines under the
				     clipped colored ones. -->
				{#each PLAYERS as p}
					<polyline fill="none" stroke="#3a4a5c" stroke-width="2" opacity="0.55" points={chartPoints(d.history, p, field, max)} />
				{/each}
				{#each PLAYERS as p}
					<polyline
						fill="none"
						stroke={PLAYER_COLORS[p]}
						stroke-width="2"
						points={chartPoints(d.history, p, field, max)}
						clip-path="url(#reached-{field})"
					/>
				{/each}
				<!-- "You are here" marker for the selected key moment. -->
				<line x1={reachedX} y1="0" x2={reachedX} y2={CHART_H + 5} stroke="#ffd54a" stroke-width="1.5" stroke-dasharray="5 4" opacity="0.8" />
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
				     the chips below — hover either side to highlight the other,
				     click to jump the moment viewer there. -->
				{#each d.turningPoints as tp, i}
					{@const m = tpMarker(d, tp, field, max)}
					{#if m}
						<g
							class="tp-dot"
							class:reached={i + 1 <= selected}
							role="button"
							tabindex="0"
							aria-label="Show turning point at turn {tp.turn}"
							onclick={() => selectMoment(i + 1)}
							onkeydown={(e) => e.key === 'Enter' && selectMoment(i + 1)}
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

		<div class="top-row">
			<section class="chart stat-table">
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
			</section>
			<section class="chart">
				<h3>Territories owned</h3>
				{@render chart('territories', maxTerr)}
			</section>
			<section class="chart">
				<h3>Total armies</h3>
				{@render chart('armies', maxArm)}
			</section>
		</div>

		{#if map}
			{@const m = map}
			<section class="moments">
				<div class="moment-nav">
					<button class="tp-nav-btn" disabled={selected <= 0} onclick={() => selectMoment(selected - 1)} aria-label="Previous key moment">‹</button>
					<div class="moment-chips">
						<button
							class="chip chip-start"
							class:active={selected === 0}
							onclick={() => selectMoment(0)}
							title="Starting positions, before turn 1"
						>⚑ Start</button>
						{#each d.turningPoints as tp, i}
							<button
								class="chip"
								class:active={selected === i + 1}
								class:hl={hoverTp === i}
								class:star={tp.isFinal}
								onclick={() => selectMoment(i + 1)}
								onmouseenter={() => (hoverTp = i)}
								onmouseleave={() => (hoverTp = null)}
								title="Turn {tp.turn} — {tp.headline}"
							>{tp.isFinal ? '★' : i + 1}</button>
						{/each}
					</div>
					<button class="tp-nav-btn" disabled={selected >= momentCount - 1} onclick={() => selectMoment(selected + 1)} aria-label="Next key moment">›</button>
				</div>
				<p class="kbd-hint">← → step through moments · click a map to zoom · Esc closes the zoom</p>

				{#if selected === 0}
					{@const ownersStart = ownersAtTurn(d, 0)}
					{@const edgesStart = edgesAtTurn(d, 0)}
					<h3 class="moment-headline">Starting positions — before turn 1</h3>
					<div class="moment-single">
						<TpMiniMap map={m} owners={ownersStart} edgeWalls={edgesStart.walls} edgeSeaLanes={edgesStart.seaLanes} {createdLaneKeys} />
					</div>
				{:else}
					{@const tp = d.turningPoints[selected - 1]}
					{@const v = tpView(d, m, tp)}
					<h3 class="moment-headline">
						<span class="tp-turn">Turn {tp.turn}</span>
						{#each headlineParts(tp.headline) as part}{#if part.color}<span style="color: {part.color}">{part.text}</span>{:else}{part.text}{/if}{/each}
						{#if tp.delta !== 0}
							<span class="tp-swing" class:pos={tp.delta > 0} class:neg={tp.delta < 0} title="Change in territories, and the winner's total after this turn">
								{tp.delta > 0 ? '+' : ''}{tp.delta} <span class="tp-total">→ {tp.territoriesAfter}</span>
							</span>
						{:else}
							<span class="tp-swing" class:pos={tp.armyDelta > 0} class:neg={tp.armyDelta < 0}>
								{tp.armyDelta > 0 ? '+' : ''}{tp.armyDelta} armies
							</span>
						{/if}
					</h3>
					{#if v.otherPlayersCapture}
						<p class="tp-no-capture">The highlighted hexes below changed hands between other players — unrelated to this turning point.</p>
					{/if}
					<!-- svelte-ignore a11y_click_events_have_key_events a11y_no_static_element_interactions -->
					<div class="moment-compare" onclick={() => (zoomOpen = true)} title="Click to zoom">
						<div class="moment-pane">
							<div class="moment-label">Before (turn {tp.turn - 1})</div>
							<TpMiniMap map={m} owners={v.ownersBefore} ghostGrids={v.changedGrids} edgeWalls={v.edgesBefore.walls} edgeSeaLanes={v.edgesBefore.seaLanes} {createdLaneKeys} />
						</div>
						<div class="moment-arrow" aria-hidden="true">
							<svg viewBox="0 0 40 24" width="40" height="24">
								<line x1="2" y1="12" x2="32" y2="12" stroke="#ffd54a" stroke-width="3" stroke-linecap="round" />
								<path d="M24,3 L36,12 L24,21" fill="none" stroke="#ffd54a" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" />
							</svg>
						</div>
						<div class="moment-pane">
							<div class="moment-label">After (turn {tp.turn})</div>
							<TpMiniMap map={m} owners={v.ownersAfter} paths={v.paths} changedGrids={v.changedGrids} dimUnchanged edgeWalls={v.edgesAfter.walls} edgeSeaLanes={v.edgesAfter.seaLanes} {createdLaneKeys} capturedFrom={v.capturedFrom} armyLabels={v.armyLabels} />
						</div>
					</div>
				{/if}
			</section>

			{#if zoomOpen && selected > 0 && d.turningPoints[selected - 1]}
				{@const tp = d.turningPoints[selected - 1]}
				{@const v = tpView(d, m, tp)}
				<TurningPointCompareModal
					map={m}
					turn={tp.turn}
					headline={tp.headline}
					ownersBefore={v.ownersBefore}
					ownersAfter={v.ownersAfter}
					edgesBefore={v.edgesBefore}
					edgesAfter={v.edgesAfter}
					{createdLaneKeys}
					paths={v.paths}
					changedGrids={v.changedGrids}
					capturedFrom={v.capturedFrom}
					armyLabels={v.armyLabels}
					historyBefore={v.historyBefore}
					historyAfter={v.historyAfter}
					otherPlayersCapture={v.otherPlayersCapture}
					hasPrev={selected > 1}
					hasNext={selected < momentCount - 1}
					onClose={() => (zoomOpen = false)}
					onPrev={() => selectMoment(selected - 1)}
					onNext={() => selectMoment(selected + 1)}
				/>
			{/if}
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
		max-width: 1500px;
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

	/* Top row: overall stats table + the two shared-axis charts, side by side
	   above the moment viewer. Charts grey out everything after the selected
	   moment (see the clipPath in the chart snippet). */
	.top-row {
		display: grid;
		grid-template-columns: minmax(320px, 1fr) 1fr 1fr;
		align-items: start;
		gap: 1rem;
		margin-bottom: 1rem;
	}
	@media (max-width: 1100px) {
		.top-row { grid-template-columns: 1fr; }
	}
	.chart {
		border: 1px solid #1a3040;
		background: #0f2035;
		padding: 0.6rem 0.8rem;
	}
	.chart svg { width: 100%; height: auto; }
	.chart h3 { margin: 0 0 0.4rem; font-size: 0.85rem; color: #8ab; text-transform: uppercase; letter-spacing: 0.05em; }
	.axis { font-size: 9px; fill: #6a9abf; }
	.line-label { font-size: 9px; font-weight: 600; }
	.elim-mark { font-size: 10px; cursor: default; }
	.hover-readout { font-size: 10px; fill: #8ab; }
	.tp-dot { cursor: pointer; }
	.tp-dot:focus { outline: none; }
	.tp-dot:focus circle { stroke-width: 2.5; }
	.tp-dot:not(.reached) circle { stroke: #6a5c2a; }
	.tp-dot:not(.reached) .tp-dot-num { fill: #8a7c4a; }
	.tp-dot-num { font-size: 8px; font-weight: 700; fill: #ffd54a; pointer-events: none; }
	.elim { color: #c66; font-size: 0.7rem; margin-left: 0.35rem; white-space: nowrap; }
	.stats-table { width: 100%; border-collapse: collapse; font-size: 0.8rem; }
	.stats-table th, .stats-table td { text-align: left; padding: 0.3rem 0.5rem; border-bottom: 1px solid #1a3040; }
	.stats-table th { color: #6a9abf; font-weight: normal; text-transform: uppercase; font-size: 0.7rem; }
	.dot { display: inline-block; width: 9px; height: 9px; border-radius: 50%; margin-right: 0.3rem; }

	/* Key-moment viewer: always-visible mini maps, stepped by the chips /
	   arrow buttons / ← → keys. */
	.moments {
		border: 1px solid #345;
		background: #10182a;
		padding: 0.75rem 1rem 1rem;
	}
	.moment-nav {
		display: flex;
		align-items: center;
		justify-content: center;
		gap: 0.6rem;
	}
	.moment-chips { display: flex; flex-wrap: wrap; justify-content: center; gap: 0.35rem; }
	.chip {
		width: 2rem; height: 2rem; border-radius: 50%;
		background: #1a1408; border: 2px solid #6a5c2a; color: #b8a45c;
		font-weight: 700; font-size: 0.85rem;
		display: flex; align-items: center; justify-content: center;
		cursor: pointer; padding: 0;
	}
	.chip.chip-start { width: auto; border-radius: 1rem; padding: 0 0.7rem; font-size: 0.8rem; }
	.chip:hover, .chip.hl { border-color: #ffd54a; color: #ffd54a; }
	.chip.active { background: #ffd54a; border-color: #ffd54a; color: #1a1408; }
	.chip.star:not(.active) { color: #ffd54a; border-color: #ffd54a; }
	.tp-nav-btn {
		flex: none;
		width: 2.2rem; height: 2.2rem;
		border-radius: 4px;
		border: 1px solid #345;
		background: transparent;
		color: #cdd;
		font-size: 1.2rem;
		line-height: 1;
		cursor: pointer;
	}
	.tp-nav-btn:hover:not(:disabled) { background: rgba(255, 255, 255, 0.08); }
	.tp-nav-btn:disabled { opacity: 0.3; cursor: default; }
	.kbd-hint { text-align: center; margin: 0.3rem 0 0.5rem; font-size: 0.72rem; color: #567; }
	.moment-headline { margin: 0.2rem 0 0.5rem; font-size: 1rem; text-align: center; }
	.moment-headline .tp-turn { color: #8ab; font-size: 0.85rem; margin-right: 0.5rem; }
	.tp-swing { font-size: 0.85rem; margin-left: 0.5rem; }
	.tp-swing.pos { color: #7fff7f; }
	.tp-swing.neg { color: #ff7f7f; }
	.tp-total { color: #8ab; }
	.tp-no-capture { margin: 0 0 0.4rem; font-size: 0.8rem; color: #8ab; font-style: italic; text-align: center; }
	.moment-single { max-width: 55%; margin: 0 auto; }
	@media (max-width: 900px) { .moment-single { max-width: 100%; } }
	.moment-compare {
		display: flex;
		align-items: center;
		gap: 0.75rem;
		cursor: zoom-in;
	}
	.moment-pane {
		flex: 1 1 0;
		min-width: 0;
		display: flex;
		flex-direction: column;
		gap: 0.3rem;
	}
	.moment-label {
		font-size: 0.8rem;
		color: #8ab;
		text-align: center;
	}
	.moment-arrow { flex: none; align-self: center; width: 40px; }
	@media (max-width: 700px) {
		.moment-compare { flex-direction: column; }
		.moment-arrow { transform: rotate(90deg); }
	}
</style>
