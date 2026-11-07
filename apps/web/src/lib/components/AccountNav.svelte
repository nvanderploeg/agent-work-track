<script lang="ts">
	import { onMount } from 'svelte';
	import { goto } from '$app/navigation';
	import { resolve } from '$app/paths';
	import { session } from '../ui/session.svelte.ts';

	onMount(() => void session.load());

	async function logout() {
		await session.signOut();
		await goto(resolve('/'), { invalidateAll: true });
	}
</script>

{#if session.user}
	<span class="account" data-testid="account-nav">
		<a href={resolve('/profile')} data-testid="profile-link">profile</a>
		<button type="button" onclick={logout} data-testid="logout">log out</button>
	</span>
{:else if session.config}
	<span class="account" data-testid="account-nav">
		<a href={resolve('/login')} data-testid="login-link">log in</a>
	</span>
{/if}

<style>
	.account {
		display: inline-flex;
		gap: 0.9rem;
		align-items: baseline;
	}

	a,
	button {
		color: inherit;
		font: inherit;
		background: none;
		border: 0;
		padding: 0;
		cursor: pointer;
		text-decoration: underline;
		text-underline-offset: 3px;
	}
</style>
