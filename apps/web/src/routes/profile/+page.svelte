<script lang="ts">
	import { onMount } from 'svelte';
	import { resolve } from '$app/paths';
	import PlainPage from '#lib/components/PlainPage.svelte';
	import { session } from '#lib/ui/session.svelte.ts';
	import type { Project, Task } from '#lib/types.ts';

	interface Owned {
		project: Project;
		tasks: Task[];
	}

	let owned = $state<Owned[]>([]);
	let loaded = $state(false);
	let name = $state('');
	let message = $state('');
	let failed = $state(false);

	function report(text: string, bad: boolean) {
		message = text;
		failed = bad;
	}

	async function load() {
		const res = await fetch('/api/me/projects');
		if (res.ok) owned = (await res.json()).projects;
		loaded = true;
	}

	async function send(url: string, method: string, body: unknown): Promise<Response> {
		const res = await fetch(url, {
			method,
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify(body)
		});
		if (!res.ok) report((await res.json().catch(() => null))?.error ?? 'Request failed.', true);
		return res;
	}

	async function toggleProject(entry: Owned) {
		const res = await send(`/api/me/projects/${entry.project.id}`, 'PATCH', {
			public: !entry.project.public
		});
		if (res.ok) entry.project = (await res.json()).project;
	}

	async function toggleTask(entry: Owned, task: Task) {
		const res = await send(`/api/me/tasks/${task.id}`, 'PATCH', { public: !task.public });
		if (!res.ok) return;
		const updated: Task = (await res.json()).task;
		entry.tasks = entry.tasks.map((t) => (t.id === updated.id ? updated : t));
	}

	async function disconnectTools() {
		const res = await send('/api/me/tools', 'DELETE', undefined);
		if (res.ok) report('Every connected tool was signed out.', false);
	}

	async function create(event: SubmitEvent) {
		event.preventDefault();
		const res = await send('/api/me/projects', 'POST', name.trim() ? { name: name.trim() } : {});
		if (!res.ok) return;
		name = '';
		report('', false);
		await load();
	}

	onMount(async () => {
		await session.load();
		if (session.user) await load();
		else loaded = true;
	});
</script>

<PlainPage title="Profile">
	{#if message}
		<p
			role="status"
			data-testid="message"
			class="rounded border p-3 {failed ? 'border-(--removed)' : 'border-(--added)'}"
		>
			{message}
		</p>
	{/if}

	{#if !session.ready || !loaded}
		<p class="text-(--muted)">Loading…</p>
	{:else if !session.user}
		<p data-testid="signed-out">
			<a class="underline" href={resolve('/login')}>Log in</a> to see your projects.
		</p>
	{:else}
		<p class="text-(--muted)" data-testid="who">
			Signed in as {session.user.email ?? session.user.name ?? session.user.uid}
		</p>

		<form onsubmit={create} class="flex gap-2" data-testid="create-form">
			<input
				bind:value={name}
				placeholder="New project name (optional)"
				aria-label="New project name"
				data-testid="project-name"
				class="min-w-0 flex-1 rounded border border-(--line) bg-(--surface) p-2"
			/>
			<button class="rounded bg-(--accent) px-4 py-2 text-white" data-testid="create">Create</button
			>
		</form>

		<section aria-labelledby="mine" class="space-y-3">
			<h2 id="mine" class="text-lg font-semibold">Your projects</h2>
			{#each owned as entry (entry.project.id)}
				<div
					class="space-y-2 rounded border border-(--line) bg-(--surface) p-3"
					data-testid="owned-project"
					data-id={entry.project.id}
				>
					<div class="flex items-baseline justify-between gap-4">
						<a class="font-semibold underline" href={resolve('/p/[id]', { id: entry.project.id })}
							>{entry.project.name}</a
						>
						<label class="flex items-center gap-2 text-sm">
							<input
								type="checkbox"
								checked={entry.project.public}
								onchange={() => toggleProject(entry)}
								data-testid="project-public"
							/>
							Public
						</label>
					</div>
					<ul class="space-y-1">
						{#each entry.tasks as task (task.id)}
							<li
								class="flex items-baseline justify-between gap-4 text-sm"
								data-testid="owned-task"
							>
								<a
									class="underline"
									href={resolve('/p/[id]/t/[taskId]', { id: entry.project.id, taskId: task.id })}
									>{task.title}</a
								>
								<label class="flex items-center gap-2">
									<input
										type="checkbox"
										checked={task.public}
										disabled={entry.project.public}
										onchange={() => toggleTask(entry, task)}
										data-testid="task-public"
									/>
									{entry.project.public ? 'Public with project' : 'Public'}
								</label>
							</li>
						{:else}
							<li class="text-sm text-(--muted)">No tasks yet.</li>
						{/each}
					</ul>
				</div>
			{:else}
				<p class="text-(--muted)" data-testid="empty">You own no projects yet.</p>
			{/each}
		</section>

		<section aria-labelledby="tools" class="space-y-3">
			<h2 id="tools" class="text-lg font-semibold">Connected tools</h2>
			<p class="text-sm text-(--muted)">
				Run <code>chronicle login</code> in a terminal to connect a tool. Tools write to your projects
				as you until you disconnect them.
			</p>
			<button
				class="rounded border border-(--line) px-3 py-1 text-(--removed)"
				onclick={disconnectTools}
				data-testid="disconnect-tools">Disconnect all tools</button
			>
		</section>
	{/if}
</PlainPage>
