<script lang="ts">
	import { useBoard } from '../ui/board.svelte.ts';

	const board = useBoard();
	let dialog: HTMLDialogElement;

	const image = $derived(board.viewing);
	const gone = $derived(image ? board.expired.has(image.id) : false);

	$effect(() => {
		if (image && !dialog.open) dialog.showModal();
		if (!image && dialog.open) dialog.close();
	});
</script>

<dialog
	bind:this={dialog}
	data-testid="lightbox"
	onclose={() => board.view(null)}
	onclick={(e) => {
		if (e.target === dialog) dialog.close();
	}}
>
	{#if image}
		<figure>
			{#if gone}
				<p class="expired" data-testid="lightbox-expired">Image expired</p>
			{:else}
				<img
					src="/api/images/{image.id}/{image.review ? 'full' : 'thumb'}.jpg"
					alt={image.caption}
					width={image.width}
					height={image.height}
					onerror={() => board.markExpired(image.id)}
				/>
			{/if}
			{#if image.caption}<figcaption>{image.caption}</figcaption>{/if}
		</figure>
		<button type="button" class="close" aria-label="Close" onclick={() => dialog.close()}>✕</button>
	{/if}
</dialog>

<style>
	dialog {
		max-width: min(92vw, 560px);
		margin: auto;
		padding: 1rem;
		border: 1px solid var(--line);
		border-radius: 14px;
		background: var(--panel);
		color: var(--ink);
	}

	dialog::backdrop {
		background: rgb(0 0 0 / 0.55);
	}

	figure {
		display: grid;
		gap: 0.6rem;
		margin: 0;
	}

	img {
		display: block;
		max-width: 100%;
		height: auto;
		margin: 0 auto;
		border-radius: 8px;
	}

	figcaption {
		color: var(--muted);
		font-size: 0.9rem;
		overflow-wrap: anywhere;
	}

	.expired {
		margin: 2rem 3rem;
		color: var(--muted);
		font-style: italic;
		text-align: center;
	}

	.close {
		position: absolute;
		top: 0.4rem;
		right: 0.4rem;
		width: 1.8rem;
		height: 1.8rem;
		border: 1px solid var(--line);
		border-radius: 50%;
		background: var(--panel-2);
		color: var(--muted);
		font: inherit;
		cursor: pointer;
	}

	.close:hover {
		color: var(--ink);
	}

	.close:focus-visible {
		outline: 2px solid var(--ink);
		outline-offset: 2px;
	}
</style>
