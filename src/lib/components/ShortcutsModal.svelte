<script lang="ts">
	// Keyboard-shortcuts help modal, opened with '?'. Shared by the main game
	// page and the recap page — each passes its own sections, so the help
	// always matches the keys that actually work on that page.
	export interface ShortcutRow {
		keys: string[];
		desc: string;
	}
	export interface ShortcutSection {
		title: string;
		rows: ShortcutRow[];
	}

	let { sections, onclose }: {
		sections: ShortcutSection[];
		onclose: () => void;
	} = $props();
</script>

<div class="sc-backdrop" role="presentation" onclick={onclose}>
	<div class="sc-modal" role="dialog" aria-label="Keyboard shortcuts" onclick={(e) => e.stopPropagation()}>
		<div class="sc-title">
			<span>Keyboard shortcuts</span>
			<button class="sc-close" onclick={onclose} aria-label="Close shortcuts">✕</button>
		</div>
		<table class="sc-table">
			<tbody>
				{#each sections as section (section.title)}
					<tr><th colspan="2">{section.title}</th></tr>
					{#each section.rows as row (row.desc)}
						<tr>
							<td>
								{#each row.keys as key, i (key)}
									{#if i > 0}<span class="sc-sep">/</span>{/if}<kbd>{key}</kbd>
								{/each}
							</td>
							<td>{row.desc}</td>
						</tr>
					{/each}
				{/each}
			</tbody>
		</table>
	</div>
</div>

<style>
	.sc-backdrop {
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
	.sc-modal {
		background: linear-gradient(180deg, #10304a, #0a1a2c);
		border: 2px solid #4a9fcf;
		border-radius: 12px;
		padding: 1rem 1.25rem 1.25rem;
		width: 100%;
		max-width: 460px;
		max-height: 100%;
		overflow-y: auto;
		box-sizing: border-box;
		box-shadow: 0 12px 40px rgba(0, 0, 0, 0.55), 0 0 30px rgba(74, 159, 207, 0.25);
	}
	.sc-title {
		display: flex;
		justify-content: space-between;
		align-items: center;
		color: #e0f0ff;
		font-size: 1.1rem;
		font-weight: bold;
		margin-bottom: 0.5rem;
	}
	.sc-close {
		background: transparent;
		border: none;
		color: #8ab;
		font-size: 1rem;
		cursor: pointer;
		padding: 0.15rem 0.4rem;
	}
	.sc-close:hover { color: #e0f0ff; }
	.sc-table {
		width: 100%;
		border-collapse: collapse;
		font-size: 0.9rem;
	}
	.sc-table th {
		text-align: left;
		color: #7fcfff;
		font-size: 0.75rem;
		letter-spacing: 0.08em;
		text-transform: uppercase;
		padding: 0.7rem 0 0.25rem;
	}
	.sc-table td {
		padding: 0.2rem 0;
		color: #a8bfd4;
		vertical-align: baseline;
	}
	.sc-table td:first-child {
		white-space: nowrap;
		padding-right: 1rem;
		width: 1%;
	}
	.sc-sep { color: #56718a; margin: 0 0.3rem; }
	kbd {
		display: inline-block;
		background: #0f2035;
		border: 1px solid #2a4a66;
		border-bottom-width: 2px;
		border-radius: 5px;
		padding: 0.1rem 0.45rem;
		color: #e0f0ff;
		font-family: inherit;
		font-size: 0.85rem;
	}
</style>
