<script lang="ts">
	import { onMount } from 'svelte';
	import { goto } from '$app/navigation';
	import { resolve } from '$app/paths';
	import PlainPage from '#lib/components/PlainPage.svelte';
	import { session } from '#lib/ui/session.svelte.ts';

	let email = $state('');
	let message = $state('');
	let failed = $state(false);
	let busy = $state(false);
	let finishing = $state(false);

	async function attempt(work: () => Promise<string | void>) {
		busy = true;
		message = '';
		failed = false;
		try {
			message = (await work()) ?? '';
		} catch (error) {
			failed = true;
			message = error instanceof Error ? error.message : 'Sign-in failed.';
		} finally {
			busy = false;
		}
	}

	const enter = () => goto(resolve('/profile'));

	async function google() {
		await attempt(async () => {
			await session.signInWithGoogle();
			await enter();
		});
	}

	async function sendLink(event: SubmitEvent) {
		event.preventDefault();
		await attempt(async () => {
			await session.sendEmailLink(email.trim());
			return `Sign-in link sent to ${email.trim()}. Open it in this browser.`;
		});
	}

	async function finishLink(event?: SubmitEvent) {
		event?.preventDefault();
		await attempt(async () => {
			await session.completeEmailLink(email.trim());
			await enter();
		});
	}

	onMount(async () => {
		await session.load();
		if (session.user) return void enter();
		if (!session.config || !(await session.isEmailLink())) return;
		email = session.rememberedEmail();
		finishing = true;
		if (email) await finishLink();
	});
</script>

<PlainPage title="Log in">
	{#if message}
		<p
			role="status"
			data-testid="message"
			class="rounded border p-3 {failed ? 'border-(--removed)' : 'border-(--added)'}"
		>
			{message}
		</p>
	{/if}

	{#if session.ready && !session.config}
		<p class="text-(--muted)" data-testid="signin-off">Sign-in is not set up on this server.</p>
	{:else if finishing}
		<form onsubmit={finishLink} class="max-w-sm space-y-3" data-testid="finish-form">
			<label class="block">
				<span class="text-sm text-(--muted)">Confirm the email this link was sent to</span>
				<input
					type="email"
					required
					autocomplete="email"
					bind:value={email}
					data-testid="email"
					class="mt-1 w-full rounded border border-(--line) bg-(--surface) p-2"
				/>
			</label>
			<button
				disabled={busy || !email}
				class="rounded bg-(--accent) px-4 py-2 text-white disabled:opacity-50">Finish login</button
			>
		</form>
	{:else if session.config}
		<div class="max-w-sm space-y-6">
			<button
				type="button"
				onclick={google}
				disabled={busy}
				data-testid="google"
				class="w-full rounded border border-(--line) bg-(--surface) px-4 py-2 disabled:opacity-50"
			>
				Continue with Google
			</button>
			<form onsubmit={sendLink} class="space-y-3" data-testid="email-form">
				<label class="block">
					<span class="text-sm text-(--muted)">Or get a sign-in link by email</span>
					<input
						type="email"
						required
						autocomplete="email"
						bind:value={email}
						data-testid="email"
						class="mt-1 w-full rounded border border-(--line) bg-(--surface) p-2"
					/>
				</label>
				<button
					disabled={busy || !email}
					data-testid="send-link"
					class="rounded bg-(--accent) px-4 py-2 text-white disabled:opacity-50"
					>Email me a link</button
				>
			</form>
		</div>
	{/if}
</PlainPage>
