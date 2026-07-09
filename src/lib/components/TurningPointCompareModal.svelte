<script lang="ts">
	import type { GameMap } from '$lib/map';
	import { PLAYERS, PLAYER_COLORS, PLAYER_NAMES, type Player } from '$lib/game';
	import { headlineParts } from '$lib/summary';
	import TpMiniMap from './TpMiniMap.svelte';

	interface EdgeSnapshot {
		walls: [number, number][];
		seaLanes: [number, number][];
		tunnels?: [number, number][];
	}

	interface StatsSnapshot {
		territories: Record<Player, number>;
		/** Absent when the snapshot was synthesized from an owner map alone
		 *  (territories can be counted from owners; armies can't). */
		armies?: Record<Player, number>;
	}

	let {
		map,
		turn,
		headline,
		ownersBefore,
		ownersAfter,
		edgesBefore,
		edgesAfter,
		createdLaneKeys = new Set<string>(),
		paths,
		changedGrids,
		capturedFrom,
		armyLabels,
		historyBefore,
		historyAfter,
		otherPlayersCapture = false,
		hasPrev,
		hasNext,
		onClose,
		onPrev,
		onNext
	}: {
		map: GameMap;
		turn: number;
		headline: string;
		ownersBefore: (Player | null)[];
		ownersAfter: (Player | null)[];
		edgesBefore: EdgeSnapshot;
		edgesAfter: EdgeSnapshot;
		/** Sorted "a,b" keys of card-opened sea lanes (see TpMiniMap). */
		createdLaneKeys?: Set<string>;
		paths: { from: number; to: number; armies?: number; color?: string; forfeited?: boolean }[];
		changedGrids: number[];
		capturedFrom: Record<number, Player | null>;
		/** Committed army count per changed hex this turn — the biggest one
		 *  is called out distinctly on the "after" map. */
		armyLabels?: Record<number, number>;
		/** Per-player territory/army totals just before/after this turn — the
		 *  one thing that's always real data even when the map is a no-op
		 *  (a pure army-count swing has nothing to highlight on the map, but
		 *  the numbers behind it are still worth showing). The table renders
		 *  unconditionally so the modal keeps a constant height while
		 *  stepping through turning points; any value the caller can't
		 *  provide (see StatsSnapshot.armies) shows as a placeholder. */
		historyBefore?: StatsSnapshot;
		historyAfter?: StatsSnapshot;
		/** True when hexes DID change hands this turn, but only between other
		 *  players — the winner's own swing (army count, usually) is what
		 *  earned this turn its spot, not the highlighted capture below. */
		otherPlayersCapture?: boolean;
		hasPrev: boolean;
		hasNext: boolean;
		onClose: () => void;
		onPrev: () => void;
		onNext: () => void;
	} = $props();
</script>

<div class="tp-modal-backdrop" role="presentation" onclick={onClose}>
	<div class="tp-modal" role="dialog" aria-label="Map at turn {turn}" tabindex="-1" onclick={(e) => e.stopPropagation()}>
		<div class="tp-modal-header">
			<h3>Turn {turn} — {#each headlineParts(headline) as part}{#if part.color}<span style="color: {part.color}">{part.text}</span>{:else}{part.text}{/if}{/each}</h3>
			<button class="close-x" onclick={onClose} aria-label="Close">✕</button>
		</div>
		{#if otherPlayersCapture}
			<p class="tp-no-capture">The highlighted hex below changed hands between other players — unrelated to this turning point.</p>
		{/if}
		{#snippet statCell(before: number | undefined, after: number | undefined)}
			{#if before != null && after != null}
				<td class:tp-stats-changed={after !== before}>
					{before} → {after}
					{#if after !== before}<span class:pos={after > before} class:neg={after < before}>({after > before ? '+' : ''}{after - before})</span>{/if}
				</td>
			{:else if before != null}
				<td>{before} → <span class="tp-stats-unknown">—</span></td>
			{:else if after != null}
				<td>{after}</td>
			{:else}
				<td class="tp-stats-unknown">—</td>
			{/if}
		{/snippet}
		<table class="tp-stats">
			<thead>
				<tr><th></th><th>Territories</th><th>Armies</th></tr>
			</thead>
			<tbody>
				{#each PLAYERS as p}
					<tr>
						<td><span class="tp-stats-dot" style="background:{PLAYER_COLORS[p]}"></span>{PLAYER_NAMES[p]}</td>
						{@render statCell(historyBefore?.territories[p], historyAfter?.territories[p])}
						{@render statCell(historyBefore?.armies?.[p], historyAfter?.armies?.[p])}
					</tr>
				{/each}
			</tbody>
		</table>
		<div class="tp-compare">
			<div class="tp-compare-pane">
				<div class="tp-compare-label">Before (turn {turn - 1})</div>
				<TpMiniMap {map} owners={ownersBefore} ghostGrids={changedGrids} edgeWalls={edgesBefore.walls} edgeSeaLanes={edgesBefore.seaLanes} edgeTunnels={edgesBefore.tunnels} {createdLaneKeys} />
			</div>
			<div class="tp-compare-arrow" aria-hidden="true">
				<svg viewBox="0 0 40 24" width="40" height="24">
					<line x1="2" y1="12" x2="32" y2="12" stroke="#ffd54a" stroke-width="3" stroke-linecap="round" />
					<path d="M24,3 L36,12 L24,21" fill="none" stroke="#ffd54a" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" />
				</svg>
			</div>
			<div class="tp-compare-pane">
				<div class="tp-compare-label">After (turn {turn})</div>
				<TpMiniMap {map} owners={ownersAfter} {paths} {changedGrids} dimUnchanged edgeWalls={edgesAfter.walls} edgeSeaLanes={edgesAfter.seaLanes} edgeTunnels={edgesAfter.tunnels} {createdLaneKeys} {capturedFrom} {armyLabels} />
			</div>
		</div>
		<div class="tp-modal-footer">
			<button class="tp-nav-btn" disabled={!hasPrev} onclick={onPrev} aria-label="Previous turning point">‹ Previous</button>
			<button class="tp-nav-btn" disabled={!hasNext} onclick={onNext} aria-label="Next turning point">Next ›</button>
		</div>
	</div>
</div>

<style>
	.tp-modal-backdrop {
		position: fixed;
		inset: 0;
		background: rgba(5, 8, 14, 0.75);
		display: flex;
		align-items: center;
		justify-content: center;
		z-index: 50;
	}
	.tp-modal {
		background: #10182a;
		border: 1px solid #345;
		border-radius: 6px;
		padding: 0.5rem 0.75rem 0.75rem;
		width: 98vw;
		max-width: 2600px;
		max-height: 96vh;
		display: flex;
		flex-direction: column;
		gap: 0.4rem;
	}
	.tp-modal-header {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 1rem;
	}
	.tp-modal-header h3 { margin: 0; font-size: 1rem; }
	.tp-no-capture { margin: 0.1rem 0.25rem 0.3rem; font-size: 0.8rem; color: #8ab; font-style: italic; }
	.tp-stats {
		width: 100%;
		border-collapse: collapse;
		font-size: 0.78rem;
		margin: 0.1rem 0.25rem 0.5rem;
	}
	.tp-stats th, .tp-stats td {
		text-align: left;
		padding: 0.2rem 0.5rem;
		border-bottom: 1px solid #1a3040;
	}
	.tp-stats th { color: #6a9abf; font-weight: normal; text-transform: uppercase; font-size: 0.68rem; }
	.tp-stats td.tp-stats-changed { color: #e6f0fa; }
	.tp-stats-dot { display: inline-block; width: 8px; height: 8px; border-radius: 50%; margin-right: 0.35rem; }
	.tp-stats span.pos { color: #7fff7f; margin-left: 0.25rem; }
	.tp-stats span.neg { color: #ff7f7f; margin-left: 0.25rem; }
	.tp-stats .tp-stats-unknown { color: #567; }
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
	.tp-modal-footer {
		display: flex;
		justify-content: center;
		gap: 0.75rem;
	}
	.tp-nav-btn {
		flex: none;
		padding: 0.4rem 1rem;
		border-radius: 4px;
		border: 1px solid #345;
		background: transparent;
		color: #cdd;
		font-size: 0.9rem;
		line-height: 1;
		cursor: pointer;
	}
	.tp-nav-btn:hover:not(:disabled) { background: rgba(255, 255, 255, 0.08); }
	.tp-nav-btn:disabled { opacity: 0.3; cursor: default; }
	.tp-compare {
		display: flex;
		align-items: center;
		gap: 0.75rem;
	}
	.tp-compare-pane {
		flex: 1 1 0;
		min-width: 0;
		display: flex;
		flex-direction: column;
		gap: 0.3rem;
	}
	.tp-compare-label {
		font-size: 0.8rem;
		color: #8ab;
		text-align: center;
	}
	.tp-compare-arrow { flex: none; align-self: center; width: 40px; }
	@media (max-width: 700px) {
		.tp-compare { flex-direction: column; }
		.tp-compare-arrow { transform: rotate(90deg); }
	}
</style>
