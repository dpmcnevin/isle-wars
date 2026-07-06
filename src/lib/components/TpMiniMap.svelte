<script lang="ts">
	import type { GameMap } from '$lib/map';
	import { polygonPoints, wallSegmentsFor, seaLanePath } from '$lib/map';
	import { PLAYER_COLORS, type Player } from '$lib/game';

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
		ghostGrids = [],
		dimUnchanged = false,
		edgeWalls,
		edgeSeaLanes,
		createdLaneKeys = new Set<string>(),
		capturedFrom = {},
		armyLabels = {}
	}: {
		map: GameMap;
		owners: (Player | null)[];
		paths?: Path[];
		changedGrids?: number[];
		/** Hexes that are ABOUT to change (shown on the "before" map as a faint
		 *  dashed outline) so the eye knows where to look on both panes. */
		ghostGrids?: number[];
		/** Fade hexes that didn't change hands so the changed cluster is the
		 *  only saturated thing on the map (used on the "after" pane). */
		dimUnchanged?: boolean;
		edgeWalls: [number, number][];
		edgeSeaLanes: [number, number][];
		/** Sorted "a,b" keys of lanes opened by cards (Ferry / Water Invasion)
		 *  during play — drawn in a distinct color from map-generated lanes. */
		createdLaneKeys?: Set<string>;
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

	// The "captured from" wedge polygon for a captured hex, facing the winning
	// attack when there's an incoming arrow (top-left otherwise). cell
	// vertices come from hexPolygon in angle order — vertex k sits at
	// (60k − 30)° (SVG y-down) — and the attacker's direction snaps to
	// TWELVE sectors, not six: adjacent attacks arrive square on an edge
	// (directions 60k, covered by the sixth between vertices k and k+1),
	// but sea-lane and other long-range arrows can point straight at a
	// vertex (directions 60k + 30), where an edge wedge would sit half-off
	// to one side — those get a "kite" straddling that corner symmetrically
	// (edge midpoint → vertex → edge midpoint).
	function wedgePoints(gridId: number): string {
		const g = map.grids[gridId];
		const c = `${g.x},${g.y}`;
		const vtx = (i: number) => `${g.cell[(i + 6) % 6][0]},${g.cell[(i + 6) % 6][1]}`;
		const inc = paths.find((p) => p.to === gridId && !p.forfeited);
		if (!inc) return `${c} ${vtx(4)} ${vtx(5)}`;
		const from = map.grids[inc.from];
		const deg = (Math.atan2(from.y - g.y, from.x - g.x) * 180) / Math.PI;
		const s = ((Math.round(deg / 30) % 12) + 12) % 12;
		if (s % 2 === 0) return `${c} ${vtx(s / 2)} ${vtx(s / 2 + 1)}`;
		const mid = (a: [number, number], b: [number, number]) => `${(a[0] + b[0]) / 2},${(a[1] + b[1]) / 2}`;
		const j = ((s + 1) / 2) % 6;
		const v = g.cell[j];
		return `${c} ${mid(g.cell[(j + 5) % 6], v)} ${vtx(j)} ${mid(v, g.cell[(j + 1) % 6])}`;
	}

	// Radius of the army badge drawn at a hex (0 when it has none) — must
	// match the r values used in the badge markup below.
	function badgeRadius(gridId: number): number {
		if (!(gridId in armyLabels)) return 0;
		return String(gridId) === biggestGrid ? 44 : 34;
	}

	// Conquest arrows run hex-center to hex-center, but the army badges sit
	// exactly there — so trim each end back to the badge's rim (plus room for
	// the arrowhead at the target) instead of burying the arrowhead under the
	// badge circle.
	function trimmedPath(p: Path): { x1: number; y1: number; x2: number; y2: number } {
		const from = map.grids[p.from];
		const to = map.grids[p.to];
		const dx = to.x - from.x;
		const dy = to.y - from.y;
		const dist = Math.hypot(dx, dy);
		if (dist < 1) return { x1: from.x, y1: from.y, x2: to.x, y2: to.y };
		const w = tpArrowWidth(p.armies);
		const startTrim = badgeRadius(p.from) === 0 ? 0 : badgeRadius(p.from) + 3;
		const endTrim = badgeRadius(p.to) === 0 ? 0 : badgeRadius(p.to) + w + 3;
		// Never trim the line away entirely (adjacent hexes with big badges).
		const scale = Math.min(1, (dist - 8) / Math.max(startTrim + endTrim, 1));
		const s = (startTrim * scale) / dist;
		const e = (endTrim * scale) / dist;
		return {
			x1: from.x + dx * s,
			y1: from.y + dy * s,
			x2: to.x - dx * e,
			y2: to.y - dy * e
		};
	}
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
	</defs>
	<rect x="0" y="0" width={map.width} height={map.height} fill="#0a2540" />
	{#each map.waterHexes ?? [] as poly}
		<polygon points={polygonPoints(poly)} fill="#0e2a48" stroke="#26527a" stroke-width="0.8" stroke-opacity="0.55" />
	{/each}
	{#each map.grids as g (g.id)}
		{@const owner = owners[g.id]}
		<polygon
			points={polygonPoints(g.cell)}
			fill={owner ? PLAYER_COLORS[owner] : '#334'}
			fill-opacity={dimUnchanged && changedGrids.length > 0 && !changedGrids.includes(g.id) ? 0.4 : 1}
			stroke="#0a1420"
			stroke-width="1.5"
		/>
	{/each}
	<!-- "Captured from" wedge — one sixth of the hex filled with the previous
	     owner's color, so a captured hex shows whose solid color it was taken
	     from. It sits on the side the winning attack came in from (see
	     wedgeCorners), so wedge and arrow read as one gesture. The dark
	     stroke separates it from the fill even when the two owners' colors
	     are close in hue. -->
	{#each map.grids as g (g.id)}
		{#if g.id in capturedFrom}
			{@const prevOwner = capturedFrom[g.id]}
			<polygon
				points={wedgePoints(g.id)}
				fill={prevOwner ? PLAYER_COLORS[prevOwner] : '#c9d6e2'}
				stroke="#0a1420"
				stroke-width="1.5"
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
	<!-- Sea lanes as of this turn — drawn ABOVE the hex fills, not under them:
	     a lane between two coastal hexes of the same island (e.g. a Water
	     Invasion that hooked around a wall) runs mostly over land polygons
	     and would be painted over entirely if it sat below. -->
	{#each edgeSeaLanes as [a, b]}
		{@const created = createdLaneKeys.has(a < b ? `${a},${b}` : `${b},${a}`)}
		<path d={seaLanePath(a, b, map.grids)} fill="none" stroke={created ? '#c68fff' : '#a0d8ff'} stroke-width="2.5" stroke-dasharray="6 4" stroke-opacity="0.85" pointer-events="none" />
	{/each}
	<!-- Faint dashed echo (on the "before" pane) of the hexes that change
	     this turn, so the eye lands on the same spot in both maps. -->
	{#each map.grids as g (g.id)}
		{#if ghostGrids.includes(g.id)}
			<polygon
				points={polygonPoints(g.cell)}
				fill="none"
				stroke="#ffe980"
				stroke-width="2.5"
				stroke-dasharray="7 5"
				stroke-opacity="0.6"
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
	{#each paths as p, i}
		{@const t = trimmedPath(p)}
		<line
			x1={t.x1} y1={t.y1}
			x2={t.x2} y2={t.y2}
			stroke={p.forfeited ? '#ff3b3b' : (p.color ?? '#fff')}
			stroke-width={tpArrowWidth(p.armies)}
			stroke-linecap="round"
			stroke-dasharray={p.forfeited ? '5 4' : undefined}
			marker-end="url(#tp-path-arrowhead-{i})"
			opacity="0.9"
			pointer-events="none"
		/>
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
</svg>

<style>
	.tp-map { width: 100%; height: auto; max-height: 88vh; }
</style>
