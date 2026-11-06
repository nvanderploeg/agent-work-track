<script lang="ts">
	import { invalidateAll } from '$app/navigation';
	import { resolve } from '$app/paths';
	import { IMPORT_CONFIRM } from './confirm.ts';

	let { data } = $props();

	let token = $state('');
	let csrf = $state('');
	let message = $state('');
	let failed = $state(false);
	let busy = $state(false);
	let file = $state<File | null>(null);
	let importPhrase = $state('');
	let pending = $state<{ id: string; label: string; phrase: string } | null>(null);
	let typed = $state('');

	$effect(() => {
		if (data.authed) csrf = data.csrf;
	});

	const size = (bytes: number) =>
		bytes < 1024
			? `${bytes} B`
			: bytes < 1048576
				? `${(bytes / 1024).toFixed(1)} KiB`
				: `${(bytes / 1048576).toFixed(1)} MiB`;
	const when = (iso: string | null) => (iso ? new Date(iso).toLocaleString() : 'never');

	async function call(url: string, init: RequestInit): Promise<Response> {
		busy = true;
		message = '';
		try {
			const response = await fetch(url, {
				...init,
				headers: { ...init.headers, 'x-csrf-token': csrf }
			});
			failed = !response.ok;
			return response;
		} finally {
			busy = false;
		}
	}

	async function say(response: Response, ok: string) {
		const body = await response.json().catch(() => ({}));
		message = response.ok ? ok : (body.error ?? `failed (${response.status})`);
	}

	async function login(event: SubmitEvent) {
		event.preventDefault();
		const response = await call('/api/admin/login', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ token })
		});
		if (response.ok) {
			token = '';
			await invalidateAll();
		} else await say(response, '');
	}

	async function logout() {
		await call('/api/admin/logout', { method: 'POST' });
		await invalidateAll();
	}

	async function remove() {
		if (!pending) return;
		const response = await call(`/api/admin/projects/${pending.id}`, {
			method: 'DELETE',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ confirm: typed })
		});
		await say(response, `Deleted ${pending.label}.`);
		if (response.ok) {
			pending = null;
			typed = '';
			await invalidateAll();
		}
	}

	async function upload() {
		if (!file) return;
		const response = await call('/api/admin/import?confirm=replace-everything', {
			method: 'POST',
			headers: { 'content-type': 'application/zip' },
			body: file
		});
		const body = await response.json().catch(() => ({}));
		message = response.ok
			? `Imported schema ${body.schema}. The previous database was saved to ${body.backup}. ${body.imagesDropped} image records were dropped.${body.warnings?.length ? ` Warnings: ${body.warnings.join('; ')}` : ''}`
			: (body.error ?? `failed (${response.status})`);
		if (response.ok) {
			file = null;
			importPhrase = '';
			await invalidateAll();
		}
	}
</script>

<svelte:head>
	<title>chronicle admin</title>
	<meta name="robots" content="noindex" />
</svelte:head>

<main class="mx-auto max-w-5xl space-y-8 p-6 text-(--ink)">
	<header class="flex items-center justify-between">
		<h1 class="text-2xl font-semibold">chronicle admin</h1>
		{#if data.authed}
			<button class="rounded border border-(--line) px-3 py-1" onclick={logout} data-testid="logout"
				>Log out</button
			>
		{/if}
	</header>

	{#if message}
		<p
			role="status"
			data-testid="message"
			class="rounded border p-3 {failed ? 'border-(--removed)' : 'border-(--added)'}"
		>
			{message}
		</p>
	{/if}

	{#if !data.authed}
		<form onsubmit={login} class="max-w-sm space-y-3" data-testid="login-form">
			<label class="block">
				<span class="text-sm text-(--muted)">Admin token</span>
				<input
					type="password"
					autocomplete="current-password"
					bind:value={token}
					data-testid="token"
					class="mt-1 w-full rounded border border-(--line) bg-(--surface) p-2"
				/>
			</label>
			<button
				disabled={busy || !token}
				data-testid="login-submit"
				class="rounded bg-(--accent) px-4 py-2 text-white disabled:opacity-50"
			>
				Log in
			</button>
		</form>
	{:else}
		<section aria-labelledby="health" class="space-y-2" data-testid="stats">
			<h2 id="health" class="text-lg font-semibold">Health</h2>
			<dl class="grid grid-cols-2 gap-x-6 gap-y-1 sm:grid-cols-4">
				<div>
					<dt class="text-sm text-(--muted)">Version</dt>
					<dd>{data.stats.appVersion} ({data.stats.build})</dd>
				</div>
				<div>
					<dt class="text-sm text-(--muted)">Database</dt>
					<dd>{data.stats.database.name}, {size(data.stats.database.bytes)}</dd>
				</div>
				<div>
					<dt class="text-sm text-(--muted)">Schema</dt>
					<dd>{data.stats.schema}</dd>
				</div>
				{#each Object.entries(data.stats.counts) as [table, count] (table)}
					<div>
						<dt class="text-sm text-(--muted)">{table}</dt>
						<dd>{count}</dd>
					</div>
				{/each}
			</dl>
			<details>
				<summary class="cursor-pointer text-sm text-(--muted)">Migrations</summary>
				<ul class="mt-1 font-mono text-sm">
					{#each data.stats.migrations as migration (migration.tag)}
						<li>{migration.applied ? 'applied' : 'PENDING'} {migration.tag}</li>
					{/each}
				</ul>
			</details>
		</section>

		<section aria-labelledby="projects" class="space-y-3">
			<h2 id="projects" class="text-lg font-semibold">Projects</h2>
			{#each data.projects as project (project.id)}
				<div
					class="flex items-baseline justify-between gap-4 rounded border border-(--line) bg-(--surface) p-3"
					data-testid="project"
					data-id={project.id}
				>
					<div>
						<a class="font-semibold underline" href={resolve('/p/[id]', { id: project.id })}
							>{project.name}</a
						>
						<span class="text-sm text-(--muted)">
							{project.tasks} tasks · {size(project.bytes)} · active {when(project.lastActivityAt)}
						</span>
					</div>
					<button
						class="text-sm text-(--removed)"
						data-testid="delete"
						onclick={() => {
							pending = {
								id: project.id,
								label: `Project ${project.name}`,
								phrase: project.confirmPhrase
							};
							typed = '';
						}}>Delete</button
					>
				</div>
			{:else}
				<p class="text-(--muted)">No Projects.</p>
			{/each}
		</section>

		{#if pending}
			<form
				onsubmit={(event) => {
					event.preventDefault();
					void remove();
				}}
				class="space-y-2 rounded border border-(--removed) p-3"
			>
				<p>
					Delete <strong>{pending.label}</strong> and everything under it? Type
					<code>{pending.phrase}</code> to confirm.
				</p>
				<input
					bind:value={typed}
					aria-label="Confirm name"
					data-testid="delete-confirm"
					class="w-full rounded border border-(--line) bg-(--surface) p-2"
				/>
				<button
					disabled={busy || !typed}
					data-testid="delete-submit"
					class="rounded bg-(--removed) px-4 py-2 text-white disabled:opacity-50"
				>
					Delete forever
				</button>
				<button type="button" class="px-3 py-2" onclick={() => (pending = null)}>Cancel</button>
			</form>
		{/if}

		<section aria-labelledby="export" class="space-y-2">
			<h2 id="export" class="text-lg font-semibold">Export</h2>
			<p class="text-sm text-(--muted)">
				A zip with a consistent snapshot of every Project, Task, Node, Notice and Event, plus a
				manifest. Write keys keep working on the new host. Chronicle Images are not carried: their
				bytes live in server memory and expire, so an import drops every image record and cached
				image on this server, and imported Tasks have none.
			</p>
			<a
				href={resolve('/api/admin/export')}
				download
				data-testid="export"
				class="inline-block rounded bg-(--accent) px-4 py-2 text-white">Download bundle</a
			>
		</section>

		<section aria-labelledby="import" class="space-y-2">
			<h2 id="import" class="text-lg font-semibold">Import</h2>
			<p class="text-sm text-(--muted)">
				Replaces everything on this server. The current database is saved as a bundle first, and
				open dashboards reload.
			</p>
			<input
				type="file"
				accept=".zip,application/zip"
				aria-label="Bundle file"
				onchange={(event) => (file = event.currentTarget.files?.[0] ?? null)}
			/>
			<label class="block">
				<span class="text-sm text-(--muted)">Type <code>{IMPORT_CONFIRM}</code> to confirm</span>
				<input
					bind:value={importPhrase}
					aria-label="Import confirmation"
					class="mt-1 w-full rounded border border-(--line) bg-(--surface) p-2"
				/>
			</label>
			<button
				disabled={busy || !file || importPhrase !== IMPORT_CONFIRM}
				onclick={upload}
				class="rounded bg-(--removed) px-4 py-2 text-white disabled:opacity-50"
			>
				Replace everything
			</button>
		</section>
	{/if}
</main>

<style>
	main {
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
