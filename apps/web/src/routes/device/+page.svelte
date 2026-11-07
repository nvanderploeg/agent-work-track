<script lang="ts">
	import { onMount } from 'svelte';
	import { resolve } from '$app/paths';
	import PlainPage from '#lib/components/PlainPage.svelte';
	import { session } from '#lib/ui/session.svelte.ts';

	let code = $state('');
	let label = $state('');
	let requesterIp = $state<string | null>(null);
	let startedSecondsAgo = $state(0);
	let message = $state('');
	let failed = $state(false);
	let answered = $state(false);
	let busy = $state(false);

	async function lookup() {
		label = '';
		const res = await fetch(`/api/me/device?code=${encodeURIComponent(code)}`);
		if (res.ok) {
			const body = await res.json();
			label = body.label;
			requesterIp = body.requesterIp ?? null;
			startedSecondsAgo = body.startedSecondsAgo ?? 0;
		} else {
			failed = true;
			message =
				res.status === 429
					? 'Too many attempts. Wait a minute and try again.'
					: 'No pending login for that code. It may have expired.';
		}
	}

	async function answer(approve: boolean) {
		busy = true;
		const res = await fetch('/api/me/device', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ userCode: code, approve })
		});
		busy = false;
		failed = !res.ok;
		answered = res.ok;
		message = res.ok
			? approve
				? 'Approved. You can close this page.'
				: 'Denied.'
			: ((await res.json().catch(() => null))?.error ?? 'Request failed.');
	}

	onMount(async () => {
		await session.load();
	});
</script>

<PlainPage title="Connect a tool">
	{#if message}
		<p
			role="status"
			data-testid="message"
			class="rounded border p-3 {failed ? 'border-(--removed)' : 'border-(--added)'}"
		>
			{message}
		</p>
	{/if}

	{#if !session.ready}
		<p class="text-(--muted)">Loading…</p>
	{:else if !session.user}
		<p data-testid="signed-out">
			<a class="underline" href={resolve('/login')}>Log in</a>, then open this page again to approve
			the code.
		</p>
	{:else if !answered}
		<form
			onsubmit={(event) => {
				event.preventDefault();
				void lookup();
			}}
			class="max-w-sm space-y-3"
		>
			<label class="block">
				<span class="text-sm text-(--muted)">Code shown by the tool</span>
				<input
					bind:value={code}
					autocomplete="off"
					data-testid="user-code"
					class="mt-1 w-full rounded border border-(--line) bg-(--surface) p-2 font-mono uppercase"
				/>
			</label>
			<button class="rounded border border-(--line) px-4 py-2" data-testid="check">Check</button>
		</form>
		{#if label}
			<section class="space-y-3 rounded border border-(--line) bg-(--surface) p-4">
				<p data-testid="asking">
					A tool calling itself <strong>{label}</strong> (the name is chosen by whoever started the login,
					so it is not verified) wants to write projects as you.
				</p>
				<p class="text-sm text-(--muted)" data-testid="origin">
					Started {startedSecondsAgo} seconds ago{requesterIp ? ` from ${requesterIp}` : ''}.
					Approve only if you started it just now.
				</p>
				<div class="flex gap-3">
					<button
						disabled={busy}
						onclick={() => answer(true)}
						data-testid="approve"
						class="rounded bg-(--accent) px-4 py-2 text-white disabled:opacity-50">Approve</button
					>
					<button
						disabled={busy}
						onclick={() => answer(false)}
						data-testid="deny"
						class="rounded border border-(--line) px-4 py-2 disabled:opacity-50">Deny</button
					>
				</div>
			</section>
		{/if}
	{/if}
</PlainPage>
