<script lang="ts">
	import type { GameMap } from '$lib/map';
	import { polygonPoints, wallSegmentsFor, seaLanePath } from '$lib/map';
	import { PLAYERS, PLAYER_COLORS, type Player } from '$lib/game';

	interface Path {
		from: number;
		to: number;
		armies?: number;
		color?: string;
		/** A failed attack (the attacker's own hex was forfeited after being
		 *  ground down) rather than a successful capture — marked with an X
		 *  instead of a normal arrowhead. */
		forfeited?: boolean;
	}

	let {
		map,
		owners,
		paths = [],
		changedGrids = [],
		edgeWalls,
		edgeSeaLanes,
		capturedFrom = {},
		armyLabels = {}
	}: {
		map: GameMap;
		owners: (Player | null)[];
		paths?: Path[];
		changedGrids?: number[];
		edgeWalls: [number, number][];
		edgeSeaLanes: [number, number][];
		capturedFrom?: Record<number, Player | null>;
		/** Committed army count per changed hex this turn (from ConquestEvent.armies)
		 *  — the only per-hex "how big was this" signal the data supports; there's
		 *  no historical per-hex army tracking outside of actual captures. The
		 *  single largest value is called out distinctly. */
		armyLabels?: Record<number, number>;
	} = $props();

	// Turning-point conquest arrows scale with the attacking force so a
	// 20-army rout reads differently from a 2-army skirmish.
	function tpArrowWidth(armies: number | undefined): number {
		return Math.max(2, Math.min(3 + (armies ?? 0) * 0.4, 12));
	}

	let biggestGrid = $derived.by(() => {
		const entries = Object.entries(armyLabels);
		if (entries.length < 2) return null; // nothing to call out among 0-1 labels
		return entries.reduce((best, cur) => (Number(cur[1]) > Number(best[1]) ? cur : best))[0];
	});
</script>

<svg
	viewBox={map.viewBox ? `${map.viewBox.x} ${map.viewBox.y} ${map.viewBox.w} ${map.viewBox.h}` : `0 0 ${map.width} ${map.height}`}
	class="tp-map"
>
	<defs>
		{#each paths as p, i}
			{@const w = tpArrowWidth(p.armies)}
			{#if p.forfeited}
				<!-- Failed attack (attacker's own hex was forfeited) — a fixed,
				     non-rotating X instead of a directional arrowhead, so it
				     doesn't look like a successful capture. -->
				<marker id="tp-path-arrowhead-{i}" markerUnits="userSpaceOnUse" markerWidth={w * 3.2} markerHeight={w * 3.2} refX={w * 1.6} refY={w * 1.6} orient="0">
					<path
						d="M{w * 0.5},{w * 0.5} L{w * 2.7},{w * 2.7} M{w * 2.7},{w * 0.5} L{w * 0.5},{w * 2.7}"
						stroke="#ff3b3b"
						stroke-width={Math.max(1.5, w * 0.55)}
						stroke-linecap="round"
					/>
				</marker>
			{:else}
				<marker id="tp-path-arrowhead-{i}" markerUnits="userSpaceOnUse" markerWidth={w * 3.2} markerHeight={w * 3.2} refX={w * 2.2} refY={w * 1.6} orient="auto">
					<path d="M0,0 L{w * 3.2},{w * 1.6} L0,{w * 3.2} Z" fill={p.color ?? '#fff'} />
				</marker>
			{/if}
		{/each}
		<!-- Diagonal two-tone stripes, one pattern per possible previous owner, so
		     a captured hex clearly shows whose solid color it was taken from —
		     opaque bands (not a translucent tint) so it reads even when the two
		     owners' colors are close in hue. -->
		{#each [...PLAYERS, null] as prevOwner}
			<pattern
				id="tp-capture-stripe-{prevOwner ?? 'neutral'}"
				width="8" height="8"
				patternUnits="userSpaceOnUse"
				patternTransform="rotate(45)"
			>
				<rect width="8" height="8" fill="transparent" />
				<!-- Dark halo behind the color band so the stripe reads even when
				     the previous owner's hue is close to the current fill. -->
				<line x1="0" y1="0" x2="0" y2="8" stroke="#0a1420" stroke-width="5.5" />
				<line x1="0" y1="0" x2="0" y2="8" stroke={prevOwner ? PLAYER_COLORS[prevOwner] : '#c9d6e2'} stroke-width="3.5" />
			</pattern>
		{/each}
	</defs>
	<rect x="0" y="0" width={map.width} height={map.height} fill="#0a2540" />
	{#each map.waterHexes ?? [] as poly}
		<polygon points={polygonPoints(poly)} fill="#0e2a48" stroke="#26527a" stroke-width="0.8" stroke-opacity="0.55" />
	{/each}
	<!-- Sea lanes as of this turn -->
	{#each edgeSeaLanes as [a, b]}
		<path d={seaLanePath(a, b, map.grids)} fill="none" stroke="#a0d8ff" stroke-width="2.5" stroke-dasharray="6 4" stroke-opacity="0.85" pointer-events="none" />
	{/each}
	{#each map.grids as g (g.id)}
		{@const owner = owners[g.id]}
		<polygon
			points={polygonPoints(g.cell)}
			fill={owner ? PLAYER_COLORS[owner] : '#334'}
			stroke="#0a1420"
			stroke-width="1.5"
		/>
	{/each}
	{#each map.grids as g (g.id)}
		{#if g.id in capturedFrom}
			<polygon
				points={polygonPoints(g.cell)}
				fill="url(#tp-capture-stripe-{capturedFrom[g.id] ?? 'neutral'})"
				stroke="none"
				pointer-events="none"
			/>
		{/if}
	{/each}
	{#each map.grids as g (g.id)}
		{#if changedGrids.includes(g.id)}
			<polygon
				points={polygonPoints(g.cell)}
				fill="none"
				stroke="#ffe980"
				stroke-width="3.5"
				pointer-events="none"
			/>
		{/if}
	{/each}
	<!-- Wall barriers as of this turn -->
	{#each wallSegmentsFor(edgeWalls, map.grids) as w}
		<g pointer-events="none">
			<line x1={w.a[0]} y1={w.a[1]} x2={w.b[0]} y2={w.b[1]} stroke="#2b2622" stroke-width="13" stroke-linecap="round" />
			<line x1={w.a[0]} y1={w.a[1]} x2={w.b[0]} y2={w.b[1]} stroke="#9a8f83" stroke-width="9" stroke-linecap="round" />
			<line x1={w.a[0]} y1={w.a[1]} x2={w.b[0]} y2={w.b[1]} stroke="#4a423b" stroke-width="9" stroke-linecap="butt" stroke-dasharray="2 9" />
		</g>
	{/each}
	<!-- Army count per changed hex — for a capture this is the committed
	     attacking force (always positive); for a pure army-swing turn (no
	     capture at all) it's a signed per-hex delta, so show the sign
	     explicitly. The single biggest one this turn is called out bigger
	     and bolder so "the biggest swing" reads at a glance, tinted by
	     whether it was a gain or a loss. -->
	{#each Object.entries(armyLabels) as [gridId, armies]}
		{@const g = map.grids[Number(gridId)]}
		{@const isBiggest = gridId === biggestGrid}
		{@const isLoss = armies < 0}
		<!-- Hexes are circumradius 70 (see map.ts) — size the badge as a
		     fraction of that, not an arbitrary pixel value, so it actually
		     fills a hex instead of looking lost inside one. -->
		{@const r = isBiggest ? 44 : 34}
		<circle cx={g.x} cy={g.y} r={r} fill="#0a1420" fill-opacity="0.88" stroke={isBiggest ? (isLoss ? '#ff5a5a' : '#ffb03b') : '#0a1420'} stroke-width={isBiggest ? 3 : 0} pointer-events="none" />
		<text
			x={g.x} y={g.y + (isBiggest ? 14 : 11)}
			text-anchor="middle"
			font-size={isBiggest ? 34 : 26}
			font-weight={isBiggest ? 800 : 700}
			fill={isBiggest ? (isLoss ? '#ff5a5a' : '#ffb03b') : (isLoss ? '#ff9a9a' : '#fff')}
			pointer-events="none"
		>{armies > 0 ? '+' : ''}{armies}</text>
	{/each}
	{#each paths as p, i}
		{@const fromG = map.grids[p.from]}
		{@const toG = map.grids[p.to]}
		<line
			x1={fromG.x} y1={fromG.y}
			x2={toG.x} y2={toG.y}
			stroke={p.forfeited ? '#ff3b3b' : (p.color ?? '#fff')}
			stroke-width={tpArrowWidth(p.armies)}
			stroke-linecap="round"
			stroke-dasharray={p.forfeited ? '5 4' : undefined}
			marker-end="url(#tp-path-arrowhead-{i})"
			opacity="0.9"
			pointer-events="none"
		/>
	{/each}
</svg>

<style>
	.tp-map { width: 100%; height: auto; max-height: 88vh; }
</style>
