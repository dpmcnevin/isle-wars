<script lang="ts">
	// Lifetime (cross-game) stats modal — shared by the main page (Career
	// header button / C key) and the recap page (banner button). The parent
	// owns the stats object so it can refresh it when a game finishes; reset
	// flows back up through onreset.
	import type { LifetimeStats } from '$lib/lifetime';

	let { stats, onclose, onreset }: {
		stats: LifetimeStats;
		onclose: () => void;
		onreset: () => void;
	} = $props();

	function confirmReset() {
		if (!confirm('Reset all lifetime stats? This cannot be undone.')) return;
		onreset();
	}

	const winRate = $derived(stats.gamesPlayed ? Math.round((stats.wins / stats.gamesPlayed) * 100) : 0);
	const atkTotal = $derived(stats.attacksWon + stats.attacksLost);
	const atkRate = $derived(atkTotal ? Math.round((stats.attacksWon / atkTotal) * 100) : 0);
	const avgTurns = $derived(stats.gamesPlayed ? Math.round(stats.totalTurns / stats.gamesPlayed) : 0);
	const hexTotal = $derived(stats.territoriesCaptured + stats.territoriesLost);
	const hexRate = $derived(hexTotal ? Math.round((stats.territoriesCaptured / hexTotal) * 100) : 0);
</script>

<div class="lt-backdrop" role="presentation" onclick={onclose}>
	<div class="lt-modal" role="dialog" aria-label="Lifetime stats" onclick={(e) => e.stopPropagation()}>
		<div class="lt-title">
			<span>Career</span>
			<button class="lt-close" onclick={onclose} aria-label="Close lifetime stats">✕</button>
		</div>
		{#if stats.gamesPlayed === 0}
			<p class="lt-empty">No finished games yet — stats are recorded when a game ends.</p>
		{:else}
			<div class="lt-kpis">
				<div class="lt-tile">
					<div class="lt-label">Games played</div>
					<div class="lt-value">{stats.gamesPlayed}</div>
					<div class="lt-sub">avg {avgTurns} turns</div>
				</div>
				<div class="lt-tile">
					<div class="lt-label">Games won</div>
					<div class="lt-value">{stats.wins}</div>
					<div class="lt-sub">{stats.fastestWinTurns != null ? `fastest: turn ${stats.fastestWinTurns}` : 'no wins yet'}</div>
				</div>
				<div class="lt-tile">
					<div class="lt-label">Win streak</div>
					<div class="lt-value">{stats.currentStreak}</div>
					<div class="lt-sub">best {stats.bestStreak}</div>
				</div>
			</div>

			<div class="lt-meters">
				<div class="lt-meter">
					<div class="lt-meter-head">
						<span class="lt-label">Win rate</span>
						<span class="lt-meter-val">{winRate}%</span>
					</div>
					<div class="lt-track"><div class="lt-fill" style="width: {winRate}%"></div></div>
					<div class="lt-meter-sub">{stats.wins} of {stats.gamesPlayed} games</div>
				</div>
				<div class="lt-meter">
					<div class="lt-meter-head">
						<span class="lt-label">Attack rolls won</span>
						<span class="lt-meter-val">{atkRate}%</span>
					</div>
					<div class="lt-track"><div class="lt-fill" style="width: {atkRate}%"></div></div>
					<div class="lt-meter-sub">{stats.attacksWon.toLocaleString()} of {atkTotal.toLocaleString()} rolls</div>
				</div>
				<div class="lt-meter">
					<div class="lt-meter-head">
						<span class="lt-label">Territory trades won</span>
						<span class="lt-meter-val">{hexRate}%</span>
					</div>
					<div class="lt-track"><div class="lt-fill" style="width: {hexRate}%"></div></div>
					<div class="lt-meter-sub">{stats.territoriesCaptured.toLocaleString()} captured · {stats.territoriesLost.toLocaleString()} lost</div>
				</div>
			</div>

			<div class="lt-grid">
				<div class="lt-row"><span class="lt-label">Cards drawn</span><span class="lt-num">{stats.cardsDrawn.toLocaleString()}</span></div>
				<div class="lt-row"><span class="lt-label">Cards played</span><span class="lt-num">{stats.cardsPlayed.toLocaleString()}</span></div>
				<div class="lt-row"><span class="lt-label">Armies lost to events</span><span class="lt-num">{stats.armiesLostToEvents.toLocaleString()}</span></div>
				<div class="lt-row"><span class="lt-label">Total turns played</span><span class="lt-num">{stats.totalTurns.toLocaleString()}</span></div>
			</div>

			<div class="lt-actions">
				<button class="lt-reset" onclick={confirmReset}>Reset stats</button>
			</div>
		{/if}
	</div>
</div>

<style>
	.lt-backdrop {
		position: fixed;
		inset: 0;
		background: rgba(4, 10, 20, 0.7);
		backdrop-filter: blur(2px);
		display: flex;
		align-items: center;
		justify-content: center;
		z-index: 1600;
		padding: 0.75rem;
		box-sizing: border-box;
	}
	.lt-modal {
		background: linear-gradient(180deg, #10304a, #0a1a2c);
		border: 2px solid #4a9fcf;
		border-radius: 12px;
		padding: 1rem 1.25rem 1.25rem;
		width: 100%;
		max-width: 480px;
		max-height: 100%;
		overflow-y: auto;
		box-sizing: border-box;
		box-shadow: 0 12px 40px rgba(0, 0, 0, 0.55), 0 0 30px rgba(74, 159, 207, 0.25);
	}
	.lt-title {
		display: flex;
		justify-content: space-between;
		align-items: center;
		color: #e0f0ff;
		font-size: 1.1rem;
		font-weight: bold;
		margin-bottom: 0.75rem;
	}
	.lt-close {
		background: transparent;
		border: none;
		color: #8ab;
		font-size: 1rem;
		cursor: pointer;
		padding: 0.15rem 0.4rem;
	}
	.lt-close:hover { color: #e0f0ff; }

	/* Shared text tokens: labels muted, values in primary ink — numbers never
	   wear the accent color; the colored meter fill carries that. */
	.lt-label {
		color: #8fa8c0;
		font-size: 0.72rem;
		letter-spacing: 0.06em;
		text-transform: uppercase;
	}

	.lt-kpis {
		display: grid;
		grid-template-columns: repeat(3, 1fr);
		gap: 0.5rem;
		margin-bottom: 0.9rem;
	}
	.lt-tile {
		background: rgba(10, 22, 36, 0.65);
		border: 1px solid #1e3a52;
		border-radius: 8px;
		padding: 0.55rem 0.7rem 0.5rem;
	}
	.lt-value {
		color: #e0f0ff;
		font-size: 1.65rem;
		font-weight: 600;
		line-height: 1.15;
		margin-top: 0.15rem;
	}
	.lt-sub {
		color: #7c94ab;
		font-size: 0.72rem;
		margin-top: 0.1rem;
	}

	.lt-meters {
		display: flex;
		flex-direction: column;
		gap: 0.65rem;
		margin-bottom: 0.9rem;
	}
	.lt-meter-head {
		display: flex;
		justify-content: space-between;
		align-items: baseline;
		margin-bottom: 0.25rem;
	}
	.lt-meter-val {
		color: #e0f0ff;
		font-size: 0.9rem;
		font-weight: 600;
	}
	/* Meter: accent fill on a lighter-step-of-the-same-ramp track, so the bar
	   reads as one object even at 0%. */
	.lt-track {
		height: 8px;
		border-radius: 4px;
		background: #16304a;
		overflow: hidden;
	}
	.lt-fill {
		height: 100%;
		border-radius: 4px;
		background: #4a9fcf;
	}
	.lt-meter-sub {
		color: #7c94ab;
		font-size: 0.72rem;
		margin-top: 0.25rem;
	}

	.lt-grid {
		display: grid;
		grid-template-columns: 1fr 1fr;
		gap: 0.3rem 1.25rem;
		border-top: 1px solid #1e3a52;
		padding-top: 0.7rem;
	}
	.lt-row {
		display: flex;
		justify-content: space-between;
		align-items: baseline;
		gap: 0.5rem;
	}
	.lt-row .lt-label { text-transform: none; letter-spacing: 0; font-size: 0.82rem; }
	.lt-num {
		color: #e0f0ff;
		font-size: 0.9rem;
		font-weight: 600;
		font-variant-numeric: tabular-nums;
	}

	.lt-empty { color: #a8bfd4; font-size: 0.9rem; margin: 0.5rem 0 0; }
	.lt-actions { margin-top: 1rem; text-align: right; }
	.lt-reset {
		background: transparent;
		border: 1px solid #345;
		color: #8ab;
		border-radius: 4px;
		padding: 0.35rem 0.8rem;
		font-size: 0.8rem;
		cursor: pointer;
	}
	.lt-reset:hover { border-color: #d66; color: #f99; }
</style>
