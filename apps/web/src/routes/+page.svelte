<script lang="ts">
	import SiteFooter from '#lib/components/SiteFooter.svelte';

	const states = [
		{
			key: 'queued',
			label: 'Not started',
			color: '#9ca3af',
			kind: 'pending',
			icon: '○',
			anim: 'none'
		},
		{
			key: 'planning',
			label: 'Planning',
			color: '#f97316',
			kind: 'active',
			icon: '◔',
			anim: 'shimmer'
		},
		{
			key: 'in_work',
			label: 'In work',
			color: '#eab308',
			kind: 'active',
			icon: '◑',
			anim: 'pulse'
		},
		{
			key: 'testing',
			label: 'Testing',
			color: '#a855f7',
			kind: 'active',
			icon: '◕',
			anim: 'pulse'
		},
		{
			key: 'needs_input',
			label: 'Needs input',
			color: '#ef4444',
			kind: 'blocked',
			icon: '!',
			anim: 'blink'
		},
		{ key: 'failed', label: 'Failed', color: '#ef4444', kind: 'failed', icon: '✕', anim: 'none' },
		{ key: 'done', label: 'Completed', color: '#22c55e', kind: 'done', icon: '✓', anim: 'none' }
	];

	const tools = [
		[
			'start_task',
			'Open a task on this repo’s project, with optional steps. Returns the task and dashboard URL.'
		],
		[
			'update_step',
			'Upsert a step or subtask by path (chunk-2, chunk-2/tests): state, note, tags, position.'
		],
		['update_task', 'Change the task’s title, summary, state or note.'],
		['get_task', 'Read a task and its nodes back.'],
		['configure', 'Read, replace or patch the project’s states, colors and theme.']
	];

	const routes = [
		['GET', '/api/health', 'Service status and version.'],
		['GET', '/api/presets', 'Available state presets.'],
		['POST', '/api/projects', 'Create a project. Returns id, write key (once), url.'],
		['GET', '/api/projects/:id', 'Snapshot: project, tasks, nodes, lastSeq.'],
		['PUT', '/api/projects/:id/config', 'Replace the project config.'],
		['PATCH', '/api/projects/:id/config', 'Merge states by key; replace other fields.'],
		['POST', '/api/projects/:id/tasks', 'Create a task, optionally with steps.'],
		['GET', '/api/tasks/:taskId', 'A task and its nodes.'],
		['GET', '/api/tasks/:taskId/events', 'Event history, optionally for one node path.'],
		['PATCH', '/api/tasks/:taskId', 'Update title, summary, state, note.'],
		['PUT', '/api/tasks/:taskId/nodes/<path>', 'Upsert a step or subtask.'],
		['GET', '/api/projects/:id/stream', 'Server-sent events; resume with Last-Event-ID or ?since.']
	];

	const needsKey = (method: string, path: string) => method !== 'GET' && path !== '/api/projects';

	const installFlags = [
		['--with-server', 'Start a local tracker with docker compose on :3280.'],
		['--replace', 'Back up and replace existing skills and MCP entries.'],
		['--allow-tools', 'Allowlist the chronicle MCP tools in Claude Code.']
	];

	const mockSteps = [
		{ title: 'schema', state: states[6] },
		{ title: 'api', state: states[6] },
		{ title: 'dashboard', state: states[2] },
		{ title: 'dashboard/legend', state: states[1] },
		{ title: 'e2e', state: states[0] }
	];
</script>

<svelte:head>
	<title>chronicle</title>
	<meta
		name="description"
		content="A live, view-only dashboard of what your agents are doing: projects, tasks, steps and subtasks, colored by state and pushed over SSE."
	/>
</svelte:head>

<div class="ws">
	<header class="top">
		<span class="mark"><span class="dot"></span>chronicle</span>
		<nav>
			<a href="#install">install</a>
			<a href="#connect">connect</a>
			<a href="#api">api</a>
		</nav>
	</header>

	<main>
		<section class="hero">
			<p class="eyebrow">view-only · live · local-first</p>
			<h1>See what your agents are doing, as it happens.</h1>
			<p class="lede">
				chronicle is a live dashboard for agent work. Projects hold tasks, tasks hold steps, steps
				hold subtasks. Every node carries a state and a color, and every change is pushed to the
				page over server-sent events. Agents write; people watch. There is nothing to click.
			</p>

			<figure class="card" aria-label="Example dashboard card">
				<div class="card-head">
					<div>
						<div class="card-title">Ship the legend editor</div>
						<div class="card-sub">/p/3f0c…a91e</div>
					</div>
					<span class="chip" style:--c={states[2].color}>
						<span class="sw"></span>{states[2].label}
					</span>
				</div>
				<ul class="steps">
					{#each mockSteps as step (step.title)}
						<li class:sub={step.title.includes('/')}>
							<span class="icon" style:--c={step.state.color}>{step.state.icon}</span>
							<span class="step-title">{step.title}</span>
							<span class="chip small" style:--c={step.state.color}>
								<span class="sw {step.state.anim}"></span>{step.state.label}
							</span>
						</li>
					{/each}
				</ul>
			</figure>
		</section>

		<section id="install">
			<h2><span class="n">01</span>Install</h2>
			<pre><code
					>git clone https://github.com/nvanderploeg/chronicle
cd chronicle && scripts/install.sh</code
				></pre>
			<p>
				The installer adds the <code>chronicle</code> skill and MCP server to your agent setup. Pass flags
				after the script:
			</p>
			<dl class="flags">
				{#each installFlags as [flag, text] (flag)}
					<dt><code>{flag}</code></dt>
					<dd>{text}</dd>
				{/each}
			</dl>
			<p>
				Dashboards live at <code>/p/&lt;projectId&gt;</code>. Anyone with the link can watch; only a
				write key can change anything.
			</p>
		</section>

		<section id="connect">
			<h2><span class="n">02</span>How agents connect</h2>
			<p>
				The <code>chronicle</code> skill tells an agent when to open a task and report progress. It does
				that through five MCP tools:
			</p>
			<ul class="tools">
				{#each tools as [name, text] (name)}
					<li><code>{name}</code><span>{text}</span></li>
				{/each}
			</ul>
			<p>
				On each task start the client looks for a server in this order and uses the first that
				answers:
			</p>
			<ol class="discovery">
				<li><code>CHRONICLE_URL</code> <span>when set, only this server is tried</span></li>
				<li><code>localhost:3280</code> <span>the local docker compose tracker</span></li>
				<li><code>chronicle.merc.camp</code> <span>the hosted tracker</span></li>
			</ol>
			<p>
				If none responds, the agent continues untracked. A missing tracker never interrupts the
				work.
			</p>
		</section>

		<section id="api">
			<h2><span class="n">03</span>API reference</h2>
			<p>
				JSON in and out. Errors are <code>{'{ "error": "…" }'}</code>. Rows marked with a key need
				<code>Authorization: Bearer &lt;writeKey&gt;</code>.
			</p>
			<div class="scroll">
				<table>
					<thead>
						<tr><th>Method</th><th>Path</th><th>Purpose</th></tr>
					</thead>
					<tbody>
						{#each routes as [method, path, text] (method + path)}
							<tr>
								<td class="m">{method}</td>
								<td
									><code>{path}</code>{#if needsKey(method, path)}<span
											class="key"
											title="needs write key">key</span
										>{/if}</td
								>
								<td>{text}</td>
							</tr>
						{/each}
					</tbody>
				</table>
			</div>

			<h3>Stream</h3>
			<p>
				<code>GET /api/projects/:id/stream</code> sends frames as
				<code>id: &lt;seq&gt;</code>, <code>event: config | task | node</code>, and a JSON
				<code>data</code> line. Reconnect with <code>Last-Event-ID</code> to replay missed events. A
				<code>: ping</code>
				comment keeps the connection warm; an <code>idle</code> event ends it after a quiet period.
			</p>

			<h3>Default states</h3>
			<p>
				The <code>build-it</code> preset. A project starts in <code>queued</code>.
			</p>
			<div class="scroll">
				<table>
					<thead>
						<tr><th>State</th><th>Key</th><th>Color</th><th>Kind</th><th>Motion</th></tr>
					</thead>
					<tbody>
						{#each states as s (s.key)}
							<tr>
								<td>
									<span class="chip" style:--c={s.color}
										><span class="sw {s.anim}"></span>{s.icon} {s.label}</span
									>
								</td>
								<td><code>{s.key}</code></td>
								<td><code>{s.color}</code></td>
								<td>{s.kind}</td>
								<td>{s.anim}</td>
							</tr>
						{/each}
					</tbody>
				</table>
			</div>
		</section>
	</main>

	<footer>
		<SiteFooter />
	</footer>
</div>

<style>
	.ws {
		--bg: #fafaf9;
		--fg: #1c1917;
		--muted: #6b6560;
		--line: #e7e5e4;
		--panel: #ffffff;
		--code: #f3f2f0;
		--accent: #0f766e;
		min-height: 100vh;
		background: var(--bg);
		color: var(--fg);
		font-family:
			ui-sans-serif,
			system-ui,
			-apple-system,
			'Segoe UI',
			sans-serif;
		line-height: 1.6;
		overflow-x: hidden;
	}

	@media (prefers-color-scheme: dark) {
		.ws {
			--bg: #12110f;
			--fg: #ece9e4;
			--muted: #9a948c;
			--line: #2a2723;
			--panel: #1a1816;
			--code: #1f1d1a;
			--accent: #5eead4;
		}
	}

	.top,
	main,
	footer {
		max-width: 52rem;
		margin: 0 auto;
		padding-inline: 1rem;
	}

	.top {
		display: flex;
		align-items: center;
		justify-content: space-between;
		padding-block: 1.25rem;
	}

	.mark {
		display: inline-flex;
		align-items: center;
		gap: 0.5rem;
		font-family: ui-monospace, 'SF Mono', Menlo, Consolas, monospace;
		font-weight: 600;
	}

	.dot {
		width: 0.6rem;
		height: 0.6rem;
		border-radius: 50%;
		background: #22c55e;
		box-shadow: 0 0 0 3px color-mix(in srgb, #22c55e 25%, transparent);
	}

	nav {
		display: flex;
		gap: 1rem;
		font-size: 0.9rem;
	}

	a {
		color: var(--accent);
		text-underline-offset: 3px;
	}

	nav a {
		color: var(--muted);
		text-decoration: none;
	}

	nav a:hover {
		color: var(--fg);
	}

	.hero {
		padding-block: 3rem 2rem;
	}

	.eyebrow {
		margin: 0 0 0.75rem;
		font-family: ui-monospace, 'SF Mono', Menlo, Consolas, monospace;
		font-size: 0.8rem;
		letter-spacing: 0.04em;
		color: var(--accent);
	}

	h1 {
		margin: 0;
		font-size: clamp(1.9rem, 6vw, 2.9rem);
		line-height: 1.12;
		letter-spacing: -0.02em;
		text-wrap: balance;
	}

	.lede {
		max-width: 40rem;
		margin: 1.25rem 0 2rem;
		color: var(--muted);
		font-size: 1.05rem;
	}

	section {
		padding-block: 2rem;
		border-top: 1px solid var(--line);
	}

	.hero {
		border-top: 0;
	}

	h2 {
		display: flex;
		align-items: baseline;
		gap: 0.75rem;
		margin: 0 0 1rem;
		font-size: 1.4rem;
		letter-spacing: -0.01em;
	}

	.n {
		font-family: ui-monospace, 'SF Mono', Menlo, Consolas, monospace;
		font-size: 0.8rem;
		color: var(--muted);
	}

	h3 {
		margin: 2rem 0 0.5rem;
		font-size: 1.05rem;
	}

	p {
		margin: 0.75rem 0;
	}

	code,
	pre {
		font-family: ui-monospace, 'SF Mono', Menlo, Consolas, monospace;
		font-size: 0.86em;
	}

	code {
		padding: 0.1em 0.35em;
		border-radius: 4px;
		background: var(--code);
		overflow-wrap: anywhere;
	}

	pre {
		margin: 1rem 0;
		padding: 1rem;
		overflow-x: auto;
		border: 1px solid var(--line);
		border-radius: 8px;
		background: var(--code);
		line-height: 1.7;
	}

	pre code {
		padding: 0;
		background: none;
		font-size: 0.9rem;
		overflow-wrap: normal;
	}

	.flags {
		display: grid;
		grid-template-columns: max-content 1fr;
		gap: 0.5rem 1rem;
		margin: 1rem 0;
	}

	.flags dt,
	.flags dd {
		margin: 0;
	}

	@media (max-width: 34rem) {
		.flags {
			grid-template-columns: 1fr;
			gap: 0;
		}
		.flags dd {
			margin-bottom: 0.6rem;
			color: var(--muted);
		}
	}

	.tools,
	.discovery {
		margin: 1rem 0;
		padding: 0;
		list-style: none;
		border: 1px solid var(--line);
		border-radius: 8px;
		background: var(--panel);
	}

	.tools li,
	.discovery li {
		display: flex;
		flex-wrap: wrap;
		gap: 0.25rem 1rem;
		padding: 0.65rem 0.9rem;
	}

	.tools li + li,
	.discovery li + li {
		border-top: 1px solid var(--line);
	}

	.tools code {
		min-width: 7.5rem;
		align-self: flex-start;
	}

	.tools span,
	.discovery span {
		flex: 1 1 14rem;
		color: var(--muted);
	}

	.discovery {
		counter-reset: step;
	}

	.discovery li {
		counter-increment: step;
		align-items: baseline;
	}

	.discovery li::before {
		content: counter(step);
		font-family: ui-monospace, 'SF Mono', Menlo, Consolas, monospace;
		font-size: 0.8rem;
		color: var(--muted);
	}

	.scroll {
		margin: 1rem 0;
		overflow-x: auto;
		border: 1px solid var(--line);
		border-radius: 8px;
		background: var(--panel);
	}

	table {
		width: 100%;
		border-collapse: collapse;
		font-size: 0.9rem;
	}

	th,
	td {
		padding: 0.55rem 0.8rem;
		text-align: left;
		vertical-align: baseline;
		white-space: nowrap;
	}

	td:last-child {
		white-space: normal;
		min-width: 14rem;
	}

	th {
		font-size: 0.75rem;
		font-weight: 600;
		letter-spacing: 0.05em;
		text-transform: uppercase;
		color: var(--muted);
		border-bottom: 1px solid var(--line);
	}

	tbody tr + tr td {
		border-top: 1px solid var(--line);
	}

	.m {
		font-family: ui-monospace, 'SF Mono', Menlo, Consolas, monospace;
		font-size: 0.8rem;
		color: var(--muted);
	}

	.key {
		margin-left: 0.5rem;
		padding: 0.05rem 0.4rem;
		border: 1px solid var(--line);
		border-radius: 999px;
		font-size: 0.7rem;
		color: var(--muted);
	}

	.chip {
		display: inline-flex;
		align-items: center;
		gap: 0.45rem;
		padding: 0.12rem 0.6rem 0.12rem 0.5rem;
		border-radius: 999px;
		background: color-mix(in srgb, var(--c) 16%, transparent);
		border: 1px solid color-mix(in srgb, var(--c) 45%, transparent);
		font-size: 0.82rem;
		white-space: nowrap;
	}

	.chip.small {
		font-size: 0.75rem;
	}

	.sw {
		width: 0.65rem;
		height: 0.65rem;
		border-radius: 3px;
		background: var(--c);
	}

	.sw.pulse {
		animation: pulse 1.6s ease-in-out infinite;
	}

	.sw.blink {
		animation: blink 1s steps(2, start) infinite;
	}

	.sw.shimmer {
		animation: pulse 2.4s ease-in-out infinite;
	}

	@keyframes pulse {
		50% {
			opacity: 0.35;
		}
	}

	@keyframes blink {
		50% {
			opacity: 0;
		}
	}

	@media (prefers-reduced-motion: reduce) {
		.sw {
			animation: none !important;
		}
	}

	.card {
		margin: 0;
		border: 1px solid var(--line);
		border-radius: 12px;
		background: var(--panel);
		box-shadow: 0 1px 2px rgb(0 0 0 / 0.04);
		overflow: hidden;
	}

	.card-head {
		display: flex;
		flex-wrap: wrap;
		justify-content: space-between;
		gap: 0.5rem;
		padding: 1rem 1.1rem;
		border-bottom: 1px solid var(--line);
	}

	.card-title {
		font-weight: 600;
	}

	.card-sub {
		font-family: ui-monospace, 'SF Mono', Menlo, Consolas, monospace;
		font-size: 0.78rem;
		color: var(--muted);
	}

	.steps {
		margin: 0;
		padding: 0.4rem 0;
		list-style: none;
	}

	.steps li {
		display: flex;
		align-items: center;
		gap: 0.7rem;
		padding: 0.45rem 1.1rem;
	}

	.steps li.sub {
		padding-left: 2.4rem;
	}

	.icon {
		width: 1.2rem;
		text-align: center;
		color: var(--c);
		font-weight: 700;
	}

	.step-title {
		flex: 1;
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		font-family: ui-monospace, 'SF Mono', Menlo, Consolas, monospace;
		font-size: 0.88rem;
	}

	footer {
		padding-block: 2rem 3rem;
		border-top: 1px solid var(--line);
		font-size: 0.85rem;
		overflow-wrap: anywhere;
	}
</style>
