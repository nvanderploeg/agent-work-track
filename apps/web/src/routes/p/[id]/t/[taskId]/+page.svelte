<script lang="ts">
	import Dashboard from '#lib/components/Dashboard.svelte';

	let { data } = $props();
</script>

<Dashboard snapshot={data.snapshot} now={data.now} taskId={data.taskId} backLink={data.backLink} />
