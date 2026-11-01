<script lang="ts">
	import { resolve } from '$app/paths';
	import { useBoard } from '../ui/board.svelte.ts';
	import {
		formatElapsed,
		isStale,
		latestActivity,
		runtimeOf,
		stateOf,
		stepProgress
	} from '../ui/dashboard.ts';
	import { taskMarkdown } from '../ui/markdown.ts';
	import { totalTokens } from '../ui/meta.ts';
	import type { Task } from '../types.ts';
	import AgentChip from './AgentChip.svelte';
	import ImageStrip from './ImageStrip.svelte';
	import Links from './Links.svelte';
	import NodeTree from './NodeTree.svelte';
	import NoticeList from './NoticeList.svelte';
	import PrChips from './PrChips.svelte';
	import StateMark from './StateMark.svelte';

	let { task, drill = false }: { task: Task; drill?: boolean } = $props();
	const board = useBoard();

	const def = $derived(stateOf(board.config, task.state));
	const nodes = $derived(board.nodesOf(task.id));
	const stale = $derived(isStale(task, nodes, board.config, board.now));
	const flashing = $derived(board.finishing.has(task.id));
	const tokens = $derived(totalTokens(task, nodes));
	const notices = $derived(board.noticesOf(task.id));
	const pending = $derived(board.pendingNotices(task.id));
	const images = $derived(board.imagesOf(task.id, null));
	let noticesOpen = $state(false);
	const ref = $derived([task.repo, task.branch].filter(Boolean).join(' @ '));
	const runtime = $derived(runtimeOf(task, board.now));
	const progress = $derived(stepProgress(nodes, task.id, board.config));
	let copyResult = $state<'copied' | 'failed' | null>(null);
	let copyTimer: ReturnType<typeof setTimeout> | undefined;
	$effect(() => () => clearTimeout(copyTimer));

	async function copy() {
		try {
			await navigator.clipboard.writeText(
				taskMarkdown(task, nodes, board.noticesOf(task.id), board.config, board.now)
			);
			copyResult = 'copied';
		} catch {
			copyResult = 'failed';
		}
		clearTimeout(copyTimer);
		copyTimer = setTimeout(() => (copyResult = null), 1500);
	}
</script>

<article
	class="card state-{task.state} kind-{def.kind}"
	class:stale
	class:flashing
	data-testid="task-card"
	data-task-id={task.id}
	style:--sc={def.color}
>
	<header>
		<div class="heading">
			<h2>{task.title}</h2>
			{#if !drill}
				<a
					class="open"
					href={resolve('/p/[id]/t/[taskId]', { id: task.projectId, taskId: task.id })}
					data-testid="task-link">Open</a
				>
			{/if}
		</div>
		<div class="status">
			<StateMark {def} variant="pill">
				{def.label} · {formatElapsed(task.stateSince, board.now)}
			</StateMark>
			<button type="button" class="copy" data-testid="task-copy" onclick={copy}>
				{copyResult === 'copied' ? 'Copied' : copyResult === 'failed' ? 'Copy failed' : 'Copy'}
			</button>
		</div>
	</header>

	<div class="run" data-testid="task-run">
		<span title={task.finishedAt ? 'Total run time' : 'Running for'}>
			{task.finishedAt ? 'took' : 'running'}
			{runtime}
		</span>
		{#if progress.total}
			<span class="progress" data-testid="task-progress">
				<span class="bar" aria-hidden="true"
					><i style:width="{(progress.done / progress.total) * 100}%"></i></span
				>
				{progress.done}/{progress.total}
				{progress.total === 1 ? 'step' : 'steps'}
			</span>
		{/if}
	</div>

	{#if task.prs.length}
		<div class="prs" data-testid="task-prs"><PrChips prs={task.prs} /></div>
	{/if}
	{#if ref || task.agent || tokens || task.links.length}
		<div class="meta" data-testid="task-meta">
			{#if ref}<span class="ref" data-testid="task-ref">{ref}</span>{/if}
			<AgentChip agent={task.agent} {tokens} />
			<Links links={task.links} />
		</div>
	{/if}
	{#if task.summary}<p class="summary">{task.summary}</p>{/if}
	{#if task.note}<p class="note" data-testid="task-note">{task.note}</p>{/if}
	{#if stale}
		<p class="stale-note" data-testid="stale-note">
			No update for {formatElapsed(new Date(latestActivity(task, nodes)).toISOString(), board.now)}
			— agent may have stopped
		</p>
	{/if}

	<ImageStrip {images} />

	{#if notices.length}
		<div class="notice-block">
			<button
				type="button"
				class="notice-alert"
				class:reviewed={pending === 0}
				aria-expanded={noticesOpen}
				data-testid="notice-alert"
				onclick={() => (noticesOpen = !noticesOpen)}
			>
				<span aria-hidden="true">{pending ? '⚠' : '✓'}</span>
				Notices
			</button>
			{#if noticesOpen}<NoticeList {notices} />{/if}
		</div>
	{/if}

	<div class="steps">
		<NodeTree taskId={task.id} />
	</div>
</article>

<style>
	.card {
		--glow: var(--sc);
		position: relative;
		padding: 1.15rem 1.25rem 1rem 1.6rem;
		border: 1px solid var(--line);
		border-radius: 16px;
		background: var(--panel);
		overflow: hidden;
		transition:
			border-color 0.6s ease,
			filter 0.8s ease,
			opacity 0.8s ease;
	}

	.card::before {
		content: '';
		position: absolute;
		inset: 0 auto 0 0;
		width: 0.45rem;
		background: var(--sc);
		transition: background-color 0.6s ease;
	}

	.kind-blocked {
		border-color: color-mix(in srgb, var(--sc) 60%, var(--line));
	}

	.stale {
		opacity: 0.7;
	}

	.flashing {
		animation: flash 0.6s ease-in-out 3;
	}

	header {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		justify-content: space-between;
		gap: 0.6rem 1rem;
	}

	.heading {
		display: flex;
		align-items: baseline;
		gap: 0.75rem;
		min-width: 0;
	}

	h2 {
		margin: 0;
		font-size: clamp(1.25rem, 3.4vw, 1.6rem);
		font-weight: 700;
		letter-spacing: -0.015em;
		line-height: 1.2;
		overflow-wrap: anywhere;
	}

	.open {
		flex: none;
		color: var(--muted);
		font-size: 0.82rem;
		text-underline-offset: 3px;
	}

	.open:hover {
		color: var(--ink);
	}

	.status {
		display: flex;
		align-items: center;
		gap: 0.6rem;
	}

	.copy {
		padding: 0.15rem 0.6rem;
		border: 1px solid var(--line);
		border-radius: 999px;
		background: var(--panel-2);
		color: var(--muted);
		font: inherit;
		font-size: 0.78rem;
		cursor: pointer;
	}

	.copy:hover {
		color: var(--ink);
	}

	.copy:focus-visible {
		outline: 2px solid var(--ink);
		outline-offset: 2px;
	}

	.run {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 0.25rem 1rem;
		margin-top: 0.4rem;
		color: var(--muted);
		font-size: 0.82rem;
	}

	.progress {
		display: inline-flex;
		align-items: center;
		gap: 0.45rem;
		color: var(--ink);
		font-weight: 600;
	}

	.bar {
		width: 5rem;
		height: 0.4rem;
		border-radius: 999px;
		background: var(--line);
		overflow: hidden;
	}

	.bar i {
		display: block;
		height: 100%;
		background: var(--sc);
		transition: width 0.6s ease;
	}

	.prs {
		display: flex;
		flex-wrap: wrap;
		gap: 0.4rem;
		margin-top: 0.6rem;
	}

	.meta {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 0.35rem 0.75rem;
		margin-top: 0.5rem;
	}

	.ref {
		color: var(--ink);
		font-family: ui-monospace, 'SF Mono', Menlo, Consolas, monospace;
		font-size: 0.8rem;
		font-weight: 600;
		overflow-wrap: anywhere;
	}

	.summary {
		max-width: 62ch;
		margin: 0.55rem 0 0;
		color: var(--ink);
		overflow-wrap: anywhere;
	}

	.note {
		max-width: 62ch;
		margin: 0.5rem 0 0;
		padding-left: 0.75rem;
		border-left: 3px solid color-mix(in srgb, var(--sc) 70%, transparent);
		color: var(--muted);
		overflow-wrap: anywhere;
		transition: border-color 0.6s ease;
	}

	.stale-note {
		margin: 0.6rem 0 0;
		color: var(--muted);
		font-size: 0.9rem;
		font-style: italic;
	}

	.notice-block {
		display: grid;
		gap: 0.6rem;
		margin-top: 0.8rem;
	}

	.notice-alert {
		justify-self: start;
		padding: 0.25rem 0.8rem;
		border: 1.5px solid #eab308;
		border-radius: 999px;
		background: color-mix(in srgb, #eab308 18%, var(--panel));
		color: var(--ink);
		font: inherit;
		font-size: 0.88rem;
		font-weight: 600;
		cursor: pointer;
	}

	.notice-alert.reviewed {
		border-color: var(--line);
		background: var(--panel-2);
		color: var(--muted);
		font-weight: 500;
	}

	.notice-alert:focus-visible {
		outline: 2px solid var(--ink);
		outline-offset: 2px;
	}

	.steps {
		margin-top: 1.1rem;
	}

	@keyframes flash {
		0%,
		100% {
			box-shadow: 0 0 0 0 transparent;
			border-color: var(--line);
		}
		45% {
			box-shadow:
				0 0 0 3px var(--glow),
				0 0 28px color-mix(in srgb, var(--glow) 55%, transparent);
			border-color: var(--glow);
		}
	}

	@keyframes glow {
		0%,
		100% {
			box-shadow: 0 0 0 0 transparent;
		}
		15%,
		70% {
			box-shadow:
				0 0 0 3px var(--glow),
				0 0 28px color-mix(in srgb, var(--glow) 55%, transparent);
		}
	}

	@media (prefers-reduced-motion: reduce) {
		.flashing {
			animation: glow 1.5s ease-out 1;
		}
	}
</style>
