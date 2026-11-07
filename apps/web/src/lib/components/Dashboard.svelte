<script lang="ts">
	import { onMount } from 'svelte';
	import { resolve } from '$app/paths';
	import { cubicOut } from 'svelte/easing';
	import { flip } from 'svelte/animate';
	import { crossfade, slide } from 'svelte/transition';
	import { Board, provideBoard } from '../ui/board.svelte.ts';
	import type { Snapshot } from '../types.ts';
	import { eyeColor, eyeSvg, formatTokens, tokensByModel } from '../ui/meta.ts';
	import AccountNav from './AccountNav.svelte';
	import Lightbox from './Lightbox.svelte';
	import Links from './Links.svelte';
	import NoticesTab from './NoticesTab.svelte';
	import SiteFooter from './SiteFooter.svelte';
	import StateMark from './StateMark.svelte';
	import TaskCard from './TaskCard.svelte';

	let {
		snapshot,
		now,
		taskId = null,
		backLink = true
	}: { snapshot: Snapshot; now: number; taskId?: string | null; backLink?: boolean } = $props();

	// The board owns this page's live state for its whole lifetime; the load data seeds it once.
	// svelte-ignore state_referenced_locally
	const board = new Board({ ...snapshot }, now, taskId);
	provideBoard(board);

	onMount(() => board.start());

	const [send, receive] = crossfade({
		duration: () => board.ms(500),
		easing: cubicOut,
		fallback(node) {
			const style = getComputedStyle(node);
			const transform = style.transform === 'none' ? '' : style.transform;
			return {
				duration: board.ms(400),
				easing: cubicOut,
				css: (t) => `transform: ${transform} scale(${0.96 + 0.04 * t}); opacity: ${t}`
			};
		}
	});

	let view = $state<'tasks' | 'notices'>('tasks');
	const pendingNotices = $derived(
		board.notices.filter((n) => board.statusOf(n.id) !== 'approved').length
	);

	const project = $derived(board.state.project);
	const title = $derived(taskId ? (board.tasks[0]?.title ?? project.name) : project.name);
	const tabTitle = $derived(
		taskId && board.tasks[0] ? `${board.tasks[0].title} · ${project.name}` : project.name
	);
	const frame = $derived(eyeColor(board.tasks, board.config));
	const icon = $derived(
		frame ? `data:image/svg+xml,${encodeURIComponent(eyeSvg(frame))}` : '/favicon.svg'
	);
	const byModel = $derived(tokensByModel(board.tasks, board.state.nodes));
	const projectTokens = $derived(byModel.reduce((sum, m) => sum + m.tokens, 0));
	const connectionLabel = $derived(
		{ connecting: 'Connecting', live: 'Live', retrying: 'Reconnecting', idle: 'Idle' }[
			board.connection
		]
	);
</script>

<svelte:head>
	<title>{board.blocked ? '(!) ' : ''}{tabTitle} · chronicle</title>
	<link rel="icon" type="image/svg+xml" href={icon} />
</svelte:head>

<div
	class="board"
	data-theme={board.config.theme}
	data-testid="dashboard"
	style:--flash={board.flashColor}
>
	<div class="frame" class:flashing={board.frameFlashing} data-testid="page-frame"></div>

	<header class="top">
		<div class="who">
			{#if taskId && backLink}
				<a class="back" href={resolve('/p/[id]', { id: project.id })} data-testid="back-link"
					>← {project.name}</a
				>
			{/if}
			<h1>{title}</h1>
		</div>
		<div class="right">
			<AccountNav />
			{#if projectTokens}
				<span
					class="tokens"
					data-testid="project-tokens"
					title={byModel.map((m) => `${m.model}: ${m.tokens.toLocaleString()}`).join('\n')}
					>{formatTokens(projectTokens)} tokens</span
				>
			{/if}
			<span class="conn conn-{board.connection}" data-testid="connection">
				<i aria-hidden="true"></i>{connectionLabel}
			</span>
		</div>
	</header>

	{#if !taskId && (project.notes || project.links.length)}
		<section class="about" data-testid="project-about">
			{#if project.notes}<p class="notes" data-testid="project-notes">{project.notes}</p>{/if}
			{#if project.links.length}<div class="links"><Links links={project.links} /></div>{/if}
		</section>
	{/if}

	<ul class="legend" aria-label="States" data-testid="legend">
		{#each board.config.states as def (def.key)}
			<li><StateMark {def} still /><span>{def.label}</span></li>
		{/each}
	</ul>

	<nav class="tabs" aria-label="Views">
		<button
			type="button"
			aria-current={view === 'tasks' ? 'page' : undefined}
			data-testid="tab-tasks"
			onclick={() => (view = 'tasks')}>Tasks</button
		>
		<button
			type="button"
			aria-current={view === 'notices' ? 'page' : undefined}
			data-testid="tab-notices"
			onclick={() => (view = 'notices')}
		>
			Notices{#if pendingNotices}<span
					class="dot"
					data-testid="notices-dot"
					aria-label="has notices"
				></span>{/if}
		</button>
	</nav>

	<main>
		{#if view === 'notices'}
			<NoticesTab />
		{:else}
			{#if board.badges.length}
				<div class="strip" data-testid="badge-strip">
					{#each board.badges as task (task.id)}
						{@const def = board.config.states.find((s) => s.key === task.state)}
						<button
							type="button"
							class="badge state-{task.state} kind-{def?.kind ?? 'pending'}"
							style:--sc={def?.color ?? '#9ca3af'}
							aria-expanded={board.open.has(task.id)}
							data-testid="task-badge"
							data-task-id={task.id}
							animate:flip={{ duration: board.ms(350) }}
							in:receive={{ key: task.id }}
							out:send={{ key: task.id }}
							onclick={() => board.toggle(task.id)}
						>
							<span class="glyph" aria-hidden="true">{def?.icon ?? '?'}</span>
							<span class="label">{task.title}</span>
						</button>
					{/each}
				</div>
			{/if}

			{#if board.opened.length}
				<div class="opened">
					{#each board.opened as task (task.id)}
						<div class="slot" transition:slide|local={{ duration: board.ms(250) }}>
							<TaskCard {task} />
						</div>
					{/each}
				</div>
			{/if}

			<div class="cards">
				{#each board.cards as task (task.id)}
					<div
						class="slot"
						animate:flip={{ duration: board.ms(350) }}
						in:receive={{ key: task.id }}
						out:send={{ key: task.id }}
					>
						<TaskCard {task} drill={taskId !== null} />
					</div>
				{/each}
			</div>

			{#if board.tasks.length === 0}
				<p class="empty">No tasks yet. They appear here as soon as an agent starts one.</p>
			{/if}
		{/if}
	</main>

	<footer class="foot"><SiteFooter /></footer>

	<Lightbox />

	{#if board.connection === 'idle'}
		<div class="overlay" role="status" data-testid="idle-overlay">
			<div class="dialog">
				<p>Idle — no updates for a while.</p>
				<p><button type="button" onclick={() => location.reload()}>Reload to reconnect.</button></p>
			</div>
		</div>
	{/if}
</div>

<style>
	.board {
		display: flex;
		flex-direction: column;
		--bg: light-dark(#e8ecef, #0d1114);
		--panel: light-dark(#ffffff, #151b20);
		--panel-2: light-dark(#f2f5f7, #1c242b);
		--ink: light-dark(#121c25, #e8eef2);
		--muted: light-dark(#566573, #8c9aa6);
		--line: light-dark(#d3dbe1, #27323b);
		position: relative;
		min-height: 100vh;
		min-height: 100dvh;
		padding: 1.5rem 1rem 4rem;
		background: var(--bg);
		color: var(--ink);
		color-scheme: light dark;
		font-family:
			ui-sans-serif,
			system-ui,
			-apple-system,
			'Segoe UI',
			Roboto,
			sans-serif;
		line-height: 1.5;
		overflow-x: clip;
		transition:
			background-color 0.6s ease,
			color 0.6s ease;
	}

	.board[data-theme='light'] {
		color-scheme: light;
	}

	.board[data-theme='dark'] {
		color-scheme: dark;
	}

	.board > :not(.frame):not(.overlay) {
		width: 100%;
		max-width: 62rem;
		margin-inline: auto;
	}

	.frame {
		position: fixed;
		inset: 0;
		z-index: 20;
		pointer-events: none;
	}

	.frame.flashing {
		animation: frame-flash 0.6s ease-in-out 3;
	}

	.top {
		display: flex;
		align-items: flex-end;
		justify-content: space-between;
		gap: 1rem;
	}

	.who {
		min-width: 0;
	}

	h1 {
		margin: 0;
		font-size: clamp(1.7rem, 5vw, 2.6rem);
		font-weight: 750;
		letter-spacing: -0.025em;
		line-height: 1.1;
		overflow-wrap: anywhere;
	}

	.back {
		display: inline-block;
		margin-bottom: 0.4rem;
		color: var(--muted);
		font-size: 0.9rem;
		text-underline-offset: 3px;
	}

	.back:hover {
		color: var(--ink);
	}

	.right {
		display: flex;
		flex: none;
		align-items: center;
		gap: 1rem;
	}

	.tokens {
		color: var(--muted);
		font-family: ui-monospace, 'SF Mono', Menlo, Consolas, monospace;
		font-size: 0.8rem;
		cursor: help;
	}

	.conn {
		display: inline-flex;
		flex: none;
		align-items: center;
		gap: 0.45rem;
		color: var(--muted);
		font-size: 0.85rem;
	}

	.conn i {
		width: 0.55rem;
		height: 0.55rem;
		border-radius: 50%;
		background: var(--muted);
		transition: background-color 0.4s ease;
	}

	.conn-live i {
		background: #22c55e;
	}

	.conn-retrying i {
		background: #eab308;
	}

	.about {
		margin-top: 0.75rem;
	}

	.notes {
		max-width: 70ch;
		margin: 0;
		color: var(--muted);
		white-space: pre-line;
		overflow-wrap: anywhere;
	}

	.links {
		display: flex;
		flex-wrap: wrap;
		gap: 0.35rem;
		margin-top: 0.5rem;
	}

	.legend {
		display: flex;
		flex-wrap: wrap;
		gap: 0.4rem 1.1rem;
		margin-block: 1rem 1.75rem;
		padding: 0;
		list-style: none;
		color: var(--muted);
		font-size: 0.86rem;
	}

	.legend li {
		display: inline-flex;
		align-items: center;
		gap: 0.4rem;
	}

	.legend :global(.mark.dot) {
		width: 1.2rem;
		height: 1.2rem;
		font-size: 0.65rem;
	}

	.tabs {
		display: flex;
		gap: 1.25rem;
		margin-bottom: 1.25rem;
		border-bottom: 1px solid var(--line);
	}

	.tabs button {
		display: inline-flex;
		align-items: center;
		gap: 0.45rem;
		margin-bottom: -1px;
		padding: 0.4rem 0.1rem;
		border: 0;
		border-bottom: 2px solid transparent;
		background: none;
		color: var(--muted);
		font: inherit;
		font-weight: 600;
		cursor: pointer;
	}

	.tabs button[aria-current='page'] {
		border-bottom-color: var(--ink);
		color: var(--ink);
	}

	.tabs button:focus-visible {
		outline: 2px solid var(--ink);
		outline-offset: 2px;
	}

	.dot {
		width: 0.55rem;
		height: 0.55rem;
		border-radius: 50%;
		background: #eab308;
	}

	.strip {
		display: flex;
		flex-wrap: wrap;
		gap: 0.5rem;
		margin-bottom: 1.25rem;
	}

	.badge {
		display: inline-flex;
		align-items: center;
		gap: 0.45rem;
		max-width: 100%;
		padding: 0.4rem 0.85rem 0.4rem 0.65rem;
		border: 1.5px solid color-mix(in srgb, var(--sc) 55%, transparent);
		border-radius: 999px;
		background: color-mix(in srgb, var(--sc) 16%, var(--panel));
		color: color-mix(in srgb, var(--sc) 55%, var(--ink));
		font: inherit;
		font-size: 0.92rem;
		font-weight: 600;
		cursor: pointer;
		transition:
			background-color 0.6s ease,
			border-color 0.6s ease,
			color 0.6s ease;
	}

	.badge[aria-expanded='true'] {
		background: color-mix(in srgb, var(--sc) 30%, var(--panel));
	}

	.badge:focus-visible {
		outline: 2px solid var(--ink);
		outline-offset: 2px;
	}

	.glyph {
		font-family: ui-monospace, 'SF Mono', Menlo, Consolas, monospace;
		font-weight: 700;
	}

	.label {
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.opened,
	.cards {
		display: grid;
		gap: 1rem;
	}

	.opened {
		margin-bottom: 1rem;
	}

	.foot {
		margin-top: auto;
		padding-top: 3rem;
		color: var(--muted);
		text-align: center;
	}

	.empty {
		margin: 3rem 0;
		color: var(--muted);
		text-align: center;
	}

	.overlay {
		position: fixed;
		inset: 0;
		z-index: 30;
		display: grid;
		place-items: center;
		padding: 1rem;
		background: color-mix(in srgb, var(--bg) 82%, transparent);
		backdrop-filter: blur(3px);
	}

	.dialog {
		padding: 1.5rem 2rem;
		border: 1px solid var(--line);
		border-radius: 16px;
		background: var(--panel);
		text-align: center;
	}

	.dialog p {
		margin: 0.25rem 0;
	}

	.dialog button {
		padding: 0;
		border: 0;
		background: none;
		color: var(--ink);
		font: inherit;
		text-decoration: underline;
		text-underline-offset: 3px;
		cursor: pointer;
	}

	@keyframes frame-flash {
		0%,
		100% {
			box-shadow: inset 0 0 0 0 transparent;
		}
		45% {
			box-shadow:
				inset 0 0 0 7px var(--flash),
				inset 0 0 70px color-mix(in srgb, var(--flash) 45%, transparent);
		}
	}

	@keyframes frame-glow {
		0%,
		100% {
			box-shadow: inset 0 0 0 0 transparent;
		}
		15%,
		70% {
			box-shadow:
				inset 0 0 0 7px var(--flash),
				inset 0 0 70px color-mix(in srgb, var(--flash) 45%, transparent);
		}
	}

	@media (prefers-reduced-motion: reduce) {
		.frame.flashing {
			animation: frame-glow 1.5s ease-out 1;
		}
	}
</style>
