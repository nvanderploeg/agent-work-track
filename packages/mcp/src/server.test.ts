import { afterEach, describe, expect, it, vi, type Mock } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';
import type { ChronicleClient } from '@chronicle/client';
import { createServer, type Opener, type WatchOptions } from './server.ts';

type Method =
	| 'discover'
	| 'startTask'
	| 'updateStep'
	| 'updateTask'
	| 'updateProject'
	| 'syncPrs'
	| 'getTask'
	| 'configure'
	| 'projectUrl'
	| 'doctor';

type FakeClient = Record<Method, Mock>;

const SERVER = 'http://localhost:3280';
const TASK_URL = `${SERVER}/p/proj1/t/task1`;

const TAGS = [{ text: 'round 2', color: '#a855f7' }];

const STEP_NODE = {
	path: 'build/compile',
	key: 'compile',
	title: 'Compile',
	state: 'active',
	note: 'running',
	tags: TAGS
};

const TASK = {
	id: 'task1',
	projectId: 'proj1',
	title: 'Ship chunk 5',
	summary: 'MCP server',
	state: 'active',
	note: null
};

const CONFIG = {
	theme: 'system',
	initialState: 'pending',
	states: [
		{ key: 'pending', label: 'Pending', color: '#94a3b8', kind: 'pending' },
		{ key: 'in_work', label: 'In work', color: '#14b8a6', kind: 'active' }
	]
};

function okResult(value: unknown) {
	return { ok: true, value };
}

function notOkResult(warning: string) {
	return { ok: false, warning };
}

const NOTICE = {
	id: 'n1',
	taskId: 'task1',
	path: null,
	kind: 'caveat',
	text: 'Flaky test skipped',
	createdAt: '2026-01-01T00:00:00.000Z'
};

const IMAGE = {
	id: 'i1',
	taskId: 'task1',
	path: null,
	caption: 'Login',
	review: true,
	width: 512,
	height: 341,
	createdAt: '2026-01-01T00:00:00.000Z'
};

function fakeClient(): FakeClient {
	return {
		discover: vi.fn(async () => SERVER),
		startTask: vi.fn(async () =>
			okResult({
				taskId: 'task1',
				url: TASK_URL,
				server: SERVER,
				projectId: 'proj1',
				projectUrl: `${SERVER}/p/proj1`,
				createdProject: false
			})
		),
		updateStep: vi.fn(async () => okResult({ node: STEP_NODE })),
		updateTask: vi.fn(async () => okResult({ task: TASK })),
		syncPrs: vi.fn(async () => okResult({ checked: 0, updated: [] })),
		updateProject: vi.fn(async () =>
			okResult({ project: { id: 'proj1', name: 'P' }, projectUrl: `${SERVER}/p/proj1` })
		),
		addNotice: vi.fn(async () => okResult({ notice: NOTICE })),
		addImage: vi.fn(async () => okResult({ image: IMAGE })),
		getTask: vi.fn(async () =>
			okResult({ task: TASK, nodes: [STEP_NODE], notices: [], url: TASK_URL })
		),
		configure: vi.fn(async () => okResult({ config: CONFIG, projectUrl: `${SERVER}/p/proj1` })),
		projectUrl: vi.fn(async () => okResult({ url: `${SERVER}/p/proj1` })),
		doctor: vi.fn(async () => ({
			configDir: '/home/test/.config/chronicle',
			pinned: null,
			probes: [{ server: SERVER, ok: true, version: '1.0.0' }],
			server: SERVER,
			repoKey: '/repo/.git',
			registered: { projectId: 'proj1', name: 'repo' }
		}))
	};
}

const closers: Array<() => Promise<void>> = [];

afterEach(async () => {
	while (closers.length > 0) {
		await closers.pop()?.();
	}
});

async function connect(
	client: FakeClient = fakeClient(),
	clientName = 'test-agent',
	watch: WatchOptions = { intervalMs: 0 },
	open: Opener = vi.fn()
) {
	const server = createServer(client as unknown as ChronicleClient, watch, open);
	const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
	const mcp = new Client({ name: clientName, version: '0.0.0' });
	await server.connect(serverTransport);
	await mcp.connect(clientTransport);
	closers.push(async () => {
		await mcp.close();
		await server.close();
	});
	return { mcp, client };
}

type Outcome =
	{ failed: true; error: unknown } | { failed: boolean; result: { isError?: boolean } };

async function callOutcome(
	mcp: Client,
	name: string,
	args: Record<string, unknown>
): Promise<Outcome> {
	try {
		const result = await mcp.callTool({ name, arguments: args });
		return { failed: result.isError === true, result };
	} catch (error) {
		return { failed: true, error };
	}
}

describe('chronicle MCP server', () => {
	it('identifies itself as the chronicle server', async () => {
		const { mcp } = await connect();

		expect(mcp.getServerVersion()?.name).toBe('chronicle');
	});

	describe('tool listing', () => {
		it('lists exactly the eight chronicle tools', async () => {
			const { mcp } = await connect();

			const { tools } = await mcp.listTools();

			expect(tools.map((t) => t.name).sort()).toEqual([
				'add_image',
				'add_notice',
				'configure',
				'get_task',
				'start_task',
				'update_project',
				'update_step',
				'update_task'
			]);
		});

		it('gives every tool a non-empty description', async () => {
			const { mcp } = await connect();

			const { tools } = await mcp.listTools();

			for (const tool of tools) {
				expect(tool.description?.trim().length ?? 0, tool.name).toBeGreaterThan(0);
			}
		});

		it('tells the agent to show the returned url to the user in start_task', async () => {
			const { mcp } = await connect();

			const { tools } = await mcp.listTools();
			const startTask = tools.find((t) => t.name === 'start_task');

			expect(startTask?.description).toMatch(/url/i);
		});

		it.each([
			[
				'start_task',
				['title'],
				[
					'agent',
					'branch',
					'cwd',
					'links',
					'note',
					'project',
					'prs',
					'repo',
					'state',
					'steps',
					'summary',
					'title'
				]
			],
			[
				'update_step',
				['path', 'taskId'],
				['agent', 'links', 'path', 'position', 'note', 'state', 'tags', 'taskId', 'title']
			],
			[
				'update_task',
				['taskId'],
				['agent', 'links', 'note', 'prs', 'state', 'summary', 'taskId', 'title']
			],
			['update_project', [], ['cwd', 'links', 'name', 'notes', 'taskId']],
			['get_task', ['taskId'], ['taskId']],
			['configure', [], ['config', 'cwd', 'patch', 'taskId']]
		])(
			'%s declares the contract input fields and required set',
			async (name, required, properties) => {
				const { mcp } = await connect();

				const { tools } = await mcp.listTools();
				const tool = tools.find((t) => t.name === name);

				expect(tool, `${name} is listed`).toBeDefined();
				expect([...(tool?.inputSchema.required ?? [])].sort(), `${name} required`).toEqual(
					[...required].sort()
				);
				expect(
					Object.keys(tool?.inputSchema.properties ?? {}).sort(),
					`${name} properties`
				).toEqual([...properties].sort());
			}
		);
	});

	describe('forwarding to the client', () => {
		it('names the tool from a Claude Code client when start_task names none', async () => {
			const { mcp, client } = await connect(fakeClient(), 'claude-code');

			await mcp.callTool({ name: 'start_task', arguments: { title: 't', agent: { model: 'm' } } });

			expect(client.startTask).toHaveBeenCalledWith({
				title: 't',
				agent: { model: 'm', tool: 'claude-code' }
			});
		});

		it('keeps an explicit tool over the client name', async () => {
			const { mcp, client } = await connect(fakeClient(), 'codex-mcp-client');

			await mcp.callTool({ name: 'start_task', arguments: { title: 't', agent: { tool: 'x' } } });

			expect(client.startTask).toHaveBeenCalledWith({ title: 't', agent: { tool: 'x' } });
		});

		it('forwards nested subtasks, agent and links to startTask', async () => {
			const { mcp, client } = await connect();
			const args = {
				title: 't',
				steps: [{ key: 'a', subtasks: [{ key: 'b', subtasks: [{ key: 'c' }] }] }],
				agent: { tool: 'codex', model: 'gpt', effort: 'high' },
				links: [{ url: 'https://trello.com/c/x', label: 'card' }],
				project: 'Billing'
			};

			await mcp.callTool({ name: 'start_task', arguments: args });

			expect(client.startTask).toHaveBeenCalledWith(args);
		});

		it('forwards update_project to updateProject', async () => {
			const { mcp, client } = await connect();
			const args = { taskId: 'task1', name: 'N', notes: 'why', links: [{ url: 'https://x.test' }] };

			await mcp.callTool({ name: 'update_project', arguments: args });

			expect(client.updateProject).toHaveBeenCalledWith(args);
		});

		it('forwards every start_task argument unchanged to startTask', async () => {
			const { mcp, client } = await connect();
			const args = {
				title: 'Ship chunk 5',
				summary: 'MCP server',
				state: 'active',
				note: 'started',
				steps: [{ key: 'compile', title: 'Compile', state: 'active', note: 'n', tags: TAGS }],
				cwd: '/repo'
			};

			await mcp.callTool({ name: 'start_task', arguments: args });

			expect(client.startTask).toHaveBeenCalledTimes(1);
			expect(client.startTask).toHaveBeenCalledWith(args);
		});

		it('forwards every update_step argument unchanged to updateStep', async () => {
			const { mcp, client } = await connect();
			const args = {
				taskId: 'task1',
				path: 'build/compile',
				title: 'Compile',
				state: 'done',
				note: 'green',
				tags: TAGS,
				position: 2
			};

			await mcp.callTool({ name: 'update_step', arguments: args });

			expect(client.updateStep).toHaveBeenCalledTimes(1);
			expect(client.updateStep).toHaveBeenCalledWith(args);
		});

		it('forwards every update_task argument unchanged to updateTask', async () => {
			const { mcp, client } = await connect();
			const args = {
				taskId: 'task1',
				title: 'Ship chunk 5',
				summary: 'MCP server',
				state: 'done',
				note: 'merged'
			};

			await mcp.callTool({ name: 'update_task', arguments: args });

			expect(client.updateTask).toHaveBeenCalledTimes(1);
			expect(client.updateTask).toHaveBeenCalledWith(args);
		});

		it('forwards the taskId to getTask', async () => {
			const { mcp, client } = await connect();

			await mcp.callTool({ name: 'get_task', arguments: { taskId: 'task1' } });

			expect(client.getTask).toHaveBeenCalledTimes(1);
			expect(client.getTask).toHaveBeenCalledWith({ taskId: 'task1' });
		});

		it('forwards a full config and a task-scoped cwd to configure', async () => {
			const { mcp, client } = await connect();
			const args = { taskId: 'task1', cwd: '/repo', config: CONFIG };

			await mcp.callTool({ name: 'configure', arguments: args });

			expect(client.configure).toHaveBeenCalledTimes(1);
			expect(client.configure).toHaveBeenCalledWith(args);
		});

		it('forwards a state patch to configure', async () => {
			const { mcp, client } = await connect();
			const args = {
				patch: { states: [{ key: 'in_work', color: '#14b8a6' }] }
			};

			await mcp.callTool({ name: 'configure', arguments: args });

			expect(client.configure).toHaveBeenCalledTimes(1);
			expect(client.configure).toHaveBeenCalledWith(args);
		});

		it('forwards an empty object to configure when no arguments are given', async () => {
			const { mcp, client } = await connect();

			await mcp.callTool({ name: 'configure', arguments: {} });

			expect(client.configure).toHaveBeenCalledTimes(1);
			expect(client.configure).toHaveBeenCalledWith({});
		});

		it('passes tags and nested steps through intact to startTask', async () => {
			const { mcp, client } = await connect();
			const steps = [
				{
					key: 'build',
					title: 'Build',
					state: 'active',
					tags: TAGS
				},
				{
					key: 'test',
					state: 'pending',
					note: 'after build'
				}
			];

			await mcp.callTool({ name: 'start_task', arguments: { title: 'T', steps } });

			const [input] = client.startTask.mock.calls[0];
			expect(input.steps).toEqual(steps);
			expect(input.steps[0].tags).toEqual([{ text: 'round 2', color: '#a855f7' }]);
		});

		it('passes tags through intact to updateStep', async () => {
			const { mcp, client } = await connect();

			await mcp.callTool({
				name: 'update_step',
				arguments: { taskId: 'task1', path: 'build', tags: TAGS }
			});

			const [input] = client.updateStep.mock.calls[0];
			expect(input.tags).toEqual([{ text: 'round 2', color: '#a855f7' }]);
		});
	});

	describe('result mapping', () => {
		const okCases: Array<[string, Method, Record<string, unknown>, unknown]> = [
			[
				'start_task',
				'startTask',
				{ title: 'T' },
				okResult({
					taskId: 'task1',
					url: TASK_URL,
					server: SERVER,
					projectId: 'proj1',
					projectUrl: `${SERVER}/p/proj1`,
					createdProject: true
				})
			],
			[
				'update_step',
				'updateStep',
				{ taskId: 'task1', path: 'build' },
				okResult({ node: STEP_NODE })
			],
			['update_task', 'updateTask', { taskId: 'task1' }, okResult({ task: TASK })],
			[
				'add_notice',
				'addNotice',
				{ taskId: 'task1', kind: 'caveat', text: 'Flaky test skipped' },
				okResult({ notice: NOTICE })
			],
			[
				'add_image',
				'addImage',
				{ taskId: 'task1', file: '/tmp/shot.png', caption: 'Login', review: true },
				okResult({ image: IMAGE })
			],
			[
				'get_task',
				'getTask',
				{ taskId: 'task1' },
				okResult({ task: TASK, nodes: [STEP_NODE], notices: [], url: TASK_URL })
			],
			['configure', 'configure', {}, okResult({ config: CONFIG, projectUrl: `${SERVER}/p/proj1` })]
		];

		it.each(okCases)(
			'%s returns one text item of JSON.stringify(value) when the client is ok',
			async (name, method, args, result) => {
				const client = fakeClient();
				client[method].mockResolvedValueOnce(result);
				const { mcp } = await connect(client);

				const response = await mcp.callTool({ name, arguments: args });

				expect(response.isError).toBeFalsy();
				expect(response.content).toEqual([
					{ type: 'text', text: JSON.stringify((result as { value: unknown }).value) }
				]);
			}
		);

		const notOkCases: Array<[string, Method, Record<string, unknown>]> = [
			['start_task', 'startTask', { title: 'T' }],
			['update_step', 'updateStep', { taskId: 'task1', path: 'build' }],
			['update_task', 'updateTask', { taskId: 'task1' }],
			['add_notice', 'addNotice', { taskId: 'task1', kind: 'caveat', text: 'x' }],
			['add_image', 'addImage', { taskId: 'task1', file: '/tmp/shot.png' }],
			['get_task', 'getTask', { taskId: 'task1' }],
			['configure', 'configure', {}]
		];

		it.each(notOkCases)(
			'%s returns a single "chronicle: <warning>" text item without isError when the client is not ok',
			async (name, method, args) => {
				const warning = 'chronicle rejected the update: no such task';
				const client = fakeClient();
				client[method].mockResolvedValueOnce(notOkResult(warning));
				const { mcp } = await connect(client);

				const response = await mcp.callTool({ name, arguments: args });

				expect(response.isError).toBeFalsy();
				expect(response.content).toEqual([{ type: 'text', text: `chronicle: ${warning}` }]);
			}
		);

		it('reports the unreachable warning verbatim for start_task', async () => {
			const warning = 'chronicle unreachable — continuing untracked';
			const client = fakeClient();
			client.startTask.mockResolvedValueOnce(notOkResult(warning));
			const { mcp } = await connect(client);

			const response = await mcp.callTool({ name: 'start_task', arguments: { title: 'T' } });

			expect(response.isError).toBeFalsy();
			expect(response.content).toEqual([{ type: 'text', text: `chronicle: ${warning}` }]);
		});
	});

	describe('invalid arguments', () => {
		it.each([
			['update_step', { taskId: 'task1' }, 'updateStep'],
			['update_task', { title: 'no id' }, 'updateTask'],
			['get_task', {}, 'getTask'],
			['start_task', {}, 'startTask'],
			['update_step', { taskId: 'task1', path: 'a', position: 1.5 }, 'updateStep']
		] as const)(
			'%s with a missing or malformed argument fails without calling the client',
			async (name, args, method) => {
				const client = fakeClient();
				const { mcp } = await connect(client);

				const outcome = await callOutcome(mcp, name, args);

				expect(outcome.failed).toBe(true);
				if ('error' in outcome) {
					expect(outcome.error).toBeInstanceOf(McpError);
					expect((outcome.error as McpError).code).toBe(ErrorCode.InvalidParams);
				}
				expect(client[method]).not.toHaveBeenCalled();
			}
		);
	});
});

describe('dashboard opener', () => {
	it('opens the task url once start_task succeeds', async () => {
		const client = fakeClient();
		client.startTask.mockResolvedValueOnce(
			okResult({
				taskId: 'task1',
				url: TASK_URL,
				server: SERVER,
				projectId: 'proj1',
				projectUrl: `${SERVER}/p/proj1`,
				createdProject: false
			})
		);
		const open = vi.fn();
		const { mcp } = await connect(client, 'test-agent', { intervalMs: 0 }, open);

		await mcp.callTool({ name: 'start_task', arguments: { title: 'T' } });

		expect(open).toHaveBeenCalledExactlyOnceWith(TASK_URL);
	});

	it('opens nothing when start_task returns a warning', async () => {
		const client = fakeClient();
		client.startTask.mockResolvedValueOnce(
			notOkResult('chronicle unreachable — continuing untracked')
		);
		const open = vi.fn();
		const { mcp } = await connect(client, 'test-agent', { intervalMs: 0 }, open);

		await mcp.callTool({ name: 'start_task', arguments: { title: 'T' } });

		expect(open).not.toHaveBeenCalled();
	});

	it('opens nothing on later writes to the task', async () => {
		const open = vi.fn();
		const { mcp } = await connect(fakeClient(), 'test-agent', { intervalMs: 0 }, open);

		await mcp.callTool({ name: 'update_step', arguments: { taskId: 'task1', path: 'a' } });
		await mcp.callTool({ name: 'update_task', arguments: { taskId: 'task1', state: 'done' } });

		expect(open).not.toHaveBeenCalled();
	});
});

describe('PR watcher', () => {
	afterEach(() => vi.useRealTimers());

	it('syncs every interval once connected', async () => {
		vi.useFakeTimers();
		const client = fakeClient();
		await connect(client, 'test-agent', { intervalMs: 60_000, soonMs: 1_000 });

		await vi.advanceTimersByTimeAsync(1_000);
		expect(client.syncPrs).toHaveBeenCalledTimes(1);
		await vi.advanceTimersByTimeAsync(60_000);
		expect(client.syncPrs).toHaveBeenCalledTimes(2);
	});

	it('checks a task soon after update_task sends prs', async () => {
		vi.useFakeTimers();
		const client = fakeClient();
		const { mcp } = await connect(client, 'test-agent', { intervalMs: 600_000, soonMs: 1_000 });
		await vi.advanceTimersByTimeAsync(1_000);
		client.syncPrs.mockClear();

		await mcp.callTool({
			name: 'update_task',
			arguments: {
				taskId: 'task1',
				state: 'review',
				prs: [{ url: 'https://github.com/o/r/pull/1' }]
			}
		});
		await vi.advanceTimersByTimeAsync(1_000);

		expect(client.syncPrs).toHaveBeenCalledWith({ taskIds: ['task1'] });
	});

	it('never syncs when the interval is 0', async () => {
		vi.useFakeTimers();
		const client = fakeClient();
		const { mcp } = await connect(client, 'test-agent', { intervalMs: 0 });

		await mcp.callTool({
			name: 'update_task',
			arguments: { taskId: 'task1', prs: [{ url: 'https://github.com/o/r/pull/1' }] }
		});
		await vi.advanceTimersByTimeAsync(10 * 60_000);

		expect(client.syncPrs).not.toHaveBeenCalled();
	});

	it('survives a sync that throws', async () => {
		vi.useFakeTimers();
		const client = fakeClient();
		client.syncPrs.mockRejectedValue(new Error('boom'));
		await connect(client, 'test-agent', { intervalMs: 60_000, soonMs: 1_000 });

		await vi.advanceTimersByTimeAsync(61_000);

		expect(client.syncPrs).toHaveBeenCalledTimes(2);
	});
});
