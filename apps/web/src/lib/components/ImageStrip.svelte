<script lang="ts">
	import { useBoard } from '../ui/board.svelte.ts';
	import type { Image } from '../types.ts';

	let { images }: { images: Image[] } = $props();
	const board = useBoard();
</script>

{#if images.length}
	<ul class="strip" data-testid="image-strip">
		{#each images as image (image.id)}
			{@const gone = board.expired.has(image.id)}
			<li>
				<button
					type="button"
					class="thumb"
					class:review={image.review}
					class:gone
					title={image.caption || undefined}
					aria-label={image.caption || (image.review ? 'Image for review' : 'Image')}
					data-testid="image-thumb"
					data-image-id={image.id}
					onclick={() => board.view(image)}
				>
					{#if gone}
						<span class="expired" data-testid="image-expired">expired</span>
					{:else}
						<img
							src="/api/images/{image.id}/thumb.jpg"
							alt={image.caption}
							loading="lazy"
							decoding="async"
							onerror={() => board.markExpired(image.id)}
						/>
					{/if}
					{#if image.review}<span class="mark" data-testid="image-review">review</span>{/if}
				</button>
			</li>
		{/each}
	</ul>
{/if}

<style>
	.strip {
		display: flex;
		flex-wrap: wrap;
		gap: 0.45rem;
		margin: 0.5rem 0 0;
		padding: 0;
		list-style: none;
	}

	.thumb {
		--ring: #0ea5e9;
		position: relative;
		display: grid;
		place-items: center;
		width: 5rem;
		height: 5rem;
		padding: 0;
		border: 1px solid var(--line);
		border-radius: 8px;
		background: var(--panel-2);
		overflow: hidden;
		cursor: zoom-in;
		transition: border-color 0.2s;
	}

	.thumb:hover {
		border-color: var(--muted);
	}

	.thumb.review {
		border-color: var(--ring);
		box-shadow: 0 0 0 2px color-mix(in srgb, var(--ring) 45%, transparent);
	}

	.thumb.gone {
		cursor: default;
	}

	.thumb:focus-visible {
		outline: 2px solid var(--ink);
		outline-offset: 2px;
	}

	img {
		width: 100%;
		height: 100%;
		object-fit: cover;
	}

	.expired {
		color: var(--muted);
		font-size: 0.72rem;
		font-style: italic;
	}

	.mark {
		position: absolute;
		right: 0.2rem;
		bottom: 0.2rem;
		padding: 0 0.3rem;
		border-radius: 4px;
		background: var(--ring);
		color: #fff;
		font-size: 0.62rem;
		font-weight: 700;
		line-height: 1.5;
		letter-spacing: 0.02em;
	}
</style>
