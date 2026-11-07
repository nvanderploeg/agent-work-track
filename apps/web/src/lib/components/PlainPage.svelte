<script lang="ts">
	import type { Snippet } from 'svelte';
	import { resolve } from '$app/paths';
	import AccountNav from './AccountNav.svelte';

	let { title, children }: { title: string; children: Snippet } = $props();
</script>

<svelte:head>
	<title>{title} · chronicle</title>
	<meta name="robots" content="noindex" />
</svelte:head>

<div class="shell text-(--ink)">
	<main class="mx-auto max-w-3xl space-y-6 p-6">
		<header class="flex items-center justify-between">
			<h1 class="text-2xl font-semibold">{title}</h1>
			<nav class="flex gap-4 text-sm">
				<a class="underline" href={resolve('/')}>chronicle</a>
				<AccountNav />
			</nav>
		</header>
		{@render children()}
	</main>
</div>

<style>
	.shell {
		--bg: light-dark(#f6f8fa, #0f151b);
		--ink: light-dark(#121c25, #e8eef2);
		--muted: light-dark(#5b6b78, #9aabb8);
		--line: light-dark(#d3dbe1, #27323b);
		--surface: light-dark(#ffffff, #161d24);
		--accent: #2563eb;
		--removed: #dc2626;
		--added: #16a34a;
		color-scheme: light dark;
		background: var(--bg);
		min-height: 100vh;
	}
</style>
