<script lang="ts">
	import { flip } from 'svelte/animate';
	import { slide } from 'svelte/transition';
	import { nodeKey, useBoard } from '../ui/board.svelte.ts';
	import { childrenOf, formatElapsed, stateOf, subtreeStates } from '../ui/dashboard.ts';
	import AgentChip from './AgentChip.svelte';
	import ImageStrip from './ImageStrip.svelte';
	import Links from './Links.svelte';
	import NodeTree from './NodeTree.svelte';
	import StateMark from './StateMark.svelte';
	import Timeline from './Timeline.svelte';

	let { taskId, parentPath = null }: { taskId: string; parentPath?: string | null } = $props();
	const board = useBoard();
	const MAX_DOTS = 14;

	const nodes = $derived(childrenOf(board.state.nodes, taskId, parentPath));
</script>

{#if nodes.length}
	<ul class="tree" class:nested={parentPath !== null}>
		{#each nodes as node (node.path)}
			{@const def = stateOf(board.config, node.state)}
			{@const key = nodeKey(taskId, node.path)}
			{@const below = subtreeStates(board.state.nodes, taskId, node.path)}
			{@const expanded = board.open.has(key)}
			{@const history = board.timelineOpen.has(key)}
			<li
				animate:flip={{ duration: board.ms(300) }}
				in:slide|local={{ duration: board.ms(280) }}
				data-testid="node-row"
				data-path={node.path}
				class="node state-{node.state} kind-{def.kind}"
				style:--sc={def.color}
			>
				<span class="lead"><StateMark {def} /></span>
				<div class="body">
					<div class="line">
						<button
							type="button"
							class="title"
							aria-expanded={history}
							data-testid="node-title"
							onclick={() => board.toggleTimeline(taskId, node.path)}>{node.title}</button
						>
						{#each node.tags as tag, i (i)}
							<span class="tag" style:--tc={tag.color} data-testid="node-tag">{tag.text}</span>
						{/each}
						<span class="since" title={def.label}
							>{def.label} · {formatElapsed(node.stateSince, board.now)}</span
						>
					</div>
					{#if node.agent || node.links.length}
						<div class="meta"><AgentChip agent={node.agent} /><Links links={node.links} /></div>
					{/if}
					{#if node.note}<p class="note">{node.note}</p>{/if}
					<ImageStrip images={board.imagesOf(taskId, node.path)} />
					{#if history}
						{@const timeline = board.timelines.get(key)}
						{#if timeline}
							<div transition:slide|local={{ duration: board.ms(200) }}>
								<Timeline {timeline} />
							</div>
						{/if}
					{/if}
					{#if below.length}
						<button
							type="button"
							class="subs"
							aria-expanded={expanded}
							data-testid="subtasks-toggle"
							onclick={() => board.toggle(key)}
						>
							<span class="caret" class:turned={expanded} aria-hidden="true">▸</span>
							<span class="count">{below.length} {below.length === 1 ? 'subtask' : 'subtasks'}</span
							>
							<span class="dots" aria-hidden="true">
								{#each below.slice(0, MAX_DOTS) as state, i (i)}
									<i style:--sc={stateOf(board.config, state).color}></i>
								{/each}
								{#if below.length > MAX_DOTS}<b>+{below.length - MAX_DOTS}</b>{/if}
							</span>
						</button>
						{#if expanded}
							<div transition:slide|local={{ duration: board.ms(240) }}>
								<NodeTree {taskId} parentPath={node.path} />
							</div>
						{/if}
					{/if}
				</div>
			</li>
		{/each}
	</ul>
{/if}

<style>
	.meta {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 0.25rem 0.6rem;
		margin-top: 0.1rem;
	}

	.tree {
		display: grid;
		margin: 0;
		padding: 0;
		list-style: none;
	}

	.nested {
		margin-top: 0.35rem;
	}

	.node {
		position: relative;
		display: grid;
		grid-template-columns: 1.45rem minmax(0, 1fr);
		gap: 0.75rem;
		padding-bottom: 0.85rem;
	}

	.node::before {
		content: '';
		position: absolute;
		top: 1.6rem;
		bottom: 0.15rem;
		left: calc(0.725rem - 1px);
		width: 2px;
		background: var(--line);
	}

	.node:last-child {
		padding-bottom: 0.1rem;
	}

	.node:last-child::before {
		display: none;
	}

	.lead {
		position: relative;
		padding-top: 0.05rem;
	}

	.body {
		min-width: 0;
	}

	.line {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 0.3rem 0.55rem;
	}

	.title {
		min-width: 0;
		padding: 0;
		border: 0;
		background: none;
		color: var(--ink);
		font: inherit;
		font-weight: 600;
		text-align: left;
		overflow-wrap: anywhere;
		cursor: pointer;
		text-decoration: underline transparent;
		text-underline-offset: 3px;
		transition: text-decoration-color 0.2s;
	}

	.title:hover {
		text-decoration-color: var(--muted);
	}

	.tag {
		--tc: var(--muted);
		padding: 0.1em 0.55em;
		border: 1px solid color-mix(in srgb, var(--tc) 45%, transparent);
		border-radius: 5px;
		background: color-mix(in srgb, var(--tc) 14%, transparent);
		color: color-mix(in srgb, var(--tc) 60%, var(--ink));
		font-size: 0.74rem;
		font-weight: 600;
		line-height: 1.5;
	}

	.since {
		margin-left: auto;
		color: var(--muted);
		font-family: ui-monospace, 'SF Mono', Menlo, Consolas, monospace;
		font-size: 0.76rem;
		font-variant-numeric: tabular-nums;
		white-space: nowrap;
	}

	.note {
		margin: 0.2rem 0 0;
		color: var(--muted);
		font-size: 0.92rem;
		overflow-wrap: anywhere;
	}

	.subs {
		display: inline-flex;
		align-items: center;
		gap: 0.5rem;
		margin-top: 0.4rem;
		padding: 0.22rem 0.6rem 0.22rem 0.45rem;
		border: 1px solid var(--line);
		border-radius: 999px;
		background: var(--panel-2);
		color: var(--muted);
		font: inherit;
		font-size: 0.82rem;
		cursor: pointer;
		transition: border-color 0.2s;
	}

	.subs:hover {
		border-color: var(--muted);
	}

	.caret {
		display: inline-block;
		transition: transform 0.2s;
	}

	.caret.turned {
		transform: rotate(90deg);
	}

	.dots {
		display: inline-flex;
		align-items: center;
		gap: 3px;
	}

	.dots i {
		width: 0.55rem;
		height: 0.55rem;
		border-radius: 50%;
		background: var(--sc);
		transition: background-color 0.6s ease;
	}

	.dots b {
		margin-left: 2px;
		font-size: 0.72rem;
		font-weight: 600;
	}

	button:focus-visible {
		outline: 2px solid var(--ink);
		outline-offset: 2px;
	}

	@media (max-width: 30rem) {
		.since {
			margin-left: 0;
			flex-basis: 100%;
		}
	}
</style>
