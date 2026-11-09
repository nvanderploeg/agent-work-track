import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import http, { type IncomingHttpHeaders, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import {
	createClient,
	repoIdentity,
	repoFromRemote,
	UNREACHABLE_WARNING,
	DEFAULT_CANDIDATES,
	type ClientOptions,
	type ProjectConfig,
	type Task,
	type Node
} from './index.ts';

const DEAD = 'http://127.0.0.1:9';
const T = '2026-10-12T00:00:00.000Z';
const REPO_KEY = '/work/repo/.git';
const MONIKER = 'Quiet Teal Otter';

const CONFIG: ProjectConfig = {
	theme: 'system',
	initialState: 'queued',
	states: [
		{ key: 'queued', label: 'Not started', color: '#9ca3af', kind: 'pending' },
		{ key: 'done', label: 'Completed', color: '#22c55e', kind: 'done' }
	]
};

const TASK: Task = {
	id: 'task-1',
	projectId: 'proj-1',
	title: 'Ship chunk 2',
	summary: '',
	state: 'queued',
	note: '',
	agent: null,
	links: [],
	prs: [],
	repo: null,
	branch: null,
	createdAt: T,
	updatedAt: T,
	stateSince: T,
	finishedAt: null
};

const NODE: Node = {
	taskId: 'task-1',
	path: 'chunk-2/tests',
	parentPath: 'chunk-2',
	key: 'tests',
	depth: 2,
	title: 'Tests',
	state: 'done',
	note: '',
	tags: [],
	agent: null,
	links: [],
	position: 0,
	createdAt: T,
	updatedAt: T,
	stateSince: T
};

interface Recorded {
	method: string;
	path: string;
	headers: IncomingHttpHeaders;
	body: unknown;
}

type Reply =
	{ status: number; body?: unknown; text?: string; headers?: Record<string, string> } | 'hang';
type Handler = (req: Recorded) => Reply;

interface Fake {
	url: string;
	requests: Recorded[];
	handler: Handler;
	server: Server;
	closed: boolean;
}

const fakes: Fake[] = [];
let configDir: string;

async function startFake(
	handler: Handler = () => ({ status: 404, body: { error: 'not found' } })
): Promise<Fake> {
	const fake: Fake = { url: '', requests: [], handler, server: http.createServer(), closed: false };
	fake.server.on('request', (req, res) => {
		const chunks: Buffer[] = [];
		req.on('data', (chunk: Buffer) => chunks.push(chunk));
		req.on('end', () => {
			const raw = Buffer.concat(chunks).toString('utf8');
			const rec: Recorded = {
				method: req.method ?? '',
				path: req.url ?? '',
				headers: req.headers,
				body: raw === '' ? undefined : JSON.parse(raw)
			};
			fake.requests.push(rec);
			const reply = fake.handler(rec);
			if (reply === 'hang') return;
			res.writeHead(reply.status, { 'content-type': 'application/json', ...reply.headers });
			res.end(reply.text ?? JSON.stringify(reply.body ?? {}));
		});
	});
	await new Promise<void>((resolve) => fake.server.listen(0, '127.0.0.1', resolve));
	const { port } = fake.server.address() as AddressInfo;
	fake.url = `http://127.0.0.1:${port}`;
	fakes.push(fake);
	return fake;
}

async function closeFake(fake: Fake): Promise<void> {
	if (fake.closed) return;
	fake.closed = true;
	fake.server.closeAllConnections();
	await new Promise<void>((resolve) => fake.server.close(() => resolve()));
}

const healthy = (version = '0.1.0'): Reply => ({
	status: 200,
	body: { service: 'chronicle', version, db: 'ok' }
});

function answering(handler: Handler): Handler {
	return (req) => (req.method === 'GET' && req.path === '/api/health' ? healthy() : handler(req));
}

function taskBody(taskId: string, projectId: string, origin: string) {
	return {
		taskId,
		url: `${origin}/p/${projectId}/t/${taskId}`,
		task: { ...TASK, id: taskId, projectId },
		nodes: []
	};
}

function serveTasks(opts: { projectId?: string; writeKey?: string } = {}): Handler {
	const projectId = opts.projectId ?? 'proj-1';
	const writeKey = opts.writeKey ?? 'key-1';
	let n = 0;
	return (req) => {
		const origin = `http://${req.headers.host}`;
		if (req.method === 'GET' && req.path === '/api/health') return healthy();
		if (req.method === 'POST' && req.path === '/api/projects') {
			return {
				status: 201,
				body: {
					id: projectId,
					name: (req.body as { name?: string } | undefined)?.name ?? MONIKER,
					writeKey,
					url: `${origin}/p/${projectId}`,
					config: CONFIG
				}
			};
		}
		if (req.method === 'POST' && req.path === `/api/projects/${projectId}/tasks`) {
			if (req.headers.authorization !== `Bearer ${writeKey}`) {
				return { status: 403, body: { error: 'invalid write key' } };
			}
			n += 1;
			return { status: 201, body: taskBody(`task-${n}`, projectId, origin) };
		}
		return { status: 404, body: { error: 'not found' } };
	};
}

function workDir(): string {
	return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ws-')));
}

function makeClient(options: Partial<ClientOptions> = {}) {
	return createClient({
		env: {},
		configDir,
		loginFile: path.join(configDir, 'runestone', 'login.json'),
		candidates: [DEAD],
		probeTimeoutMs: 200,
		requestTimeoutMs: 200,
		...options
	});
}

function writeRaw(name: string, text: string): void {
	fs.mkdirSync(configDir, { recursive: true });
	fs.writeFileSync(path.join(configDir, name), text);
}

function seedFile(name: string, data: unknown): void {
	writeRaw(name, JSON.stringify(data));
}

function readFile(name: string): unknown {
	return JSON.parse(fs.readFileSync(path.join(configDir, name), 'utf8'));
}

function modeOf(name: string): number {
	return fs.statSync(path.join(configDir, name)).mode & 0o777;
}

function seedHandle(server: string, projectId = 'proj-1', writeKey = 'key-1', taskId = 'task-1') {
	seedFile('projects.json', { [server]: { [REPO_KEY]: { projectId, writeKey, name: 'repo' } } });
	seedFile('tasks.json', { [taskId]: { server, projectId } });
}

function git(cwd: string, args: string[]): void {
	execFileSync(
		'git',
		[
			'-c',
			'user.name=Test',
			'-c',
			'user.email=test@example.com',
			'-c',
			'commit.gpgsign=false',
			...args
		],
		{ cwd, stdio: 'pipe' }
	);
}

beforeEach(() => {
	configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-'));
});

afterEach(async () => {
	await Promise.all(fakes.splice(0).map(closeFake));
});

describe('exported constants', () => {
	it('lists the default candidates in probe order', () => {
		expect(DEFAULT_CANDIDATES).toEqual(['http://localhost:3280', 'https://chronicle.merc.camp']);
	});

	it('uses the exact unreachable warning text', () => {
		expect(UNREACHABLE_WARNING).toBe('chronicle unreachable — continuing untracked');
	});
});

describe('discover', () => {
	it('returns CHRONICLE_URL when it is healthy, trimmed, without probing candidates', async () => {
		const pinned = await startFake(() => healthy());
		const candidate = await startFake(() => healthy());
		const client = makeClient({
			env: { CHRONICLE_URL: `  ${pinned.url}/  ` },
			candidates: [candidate.url]
		});

		expect(await client.discover()).toBe(pinned.url);
		expect(pinned.requests.map((r) => [r.method, r.path])).toEqual([['GET', '/api/health']]);
		expect(candidate.requests).toHaveLength(0);
	});

	it('returns null for an unhealthy CHRONICLE_URL and never tries the candidates', async () => {
		const candidate = await startFake(() => healthy());
		const client = makeClient({ env: { CHRONICLE_URL: DEAD }, candidates: [candidate.url] });

		expect(await client.discover()).toBeNull();
		expect(candidate.requests).toHaveLength(0);
	});

	it('returns null for a CHRONICLE_URL that answers 503 and never tries the candidates', async () => {
		const pinned = await startFake(() => ({
			status: 503,
			body: { service: 'chronicle', version: '0.1.0', db: 'unavailable' }
		}));
		const candidate = await startFake(() => healthy());
		const client = makeClient({ env: { CHRONICLE_URL: pinned.url }, candidates: [candidate.url] });

		expect(await client.discover()).toBeNull();
		expect(candidate.requests).toHaveLength(0);
	});

	it('treats an empty CHRONICLE_URL as unset and falls back to the candidates', async () => {
		const candidate = await startFake(() => healthy());
		const client = makeClient({ env: { CHRONICLE_URL: '' }, candidates: [candidate.url] });

		expect(await client.discover()).toBe(candidate.url);
	});

	it('returns the first healthy candidate in order', async () => {
		const first = await startFake(() => healthy());
		const second = await startFake(() => healthy());
		const client = makeClient({ env: {}, candidates: [first.url, second.url] });

		expect(await client.discover()).toBe(first.url);
	});

	it('skips a candidate that is down and returns the next healthy one', async () => {
		const second = await startFake(() => healthy());
		const client = makeClient({ env: {}, candidates: [DEAD, second.url] });

		expect(await client.discover()).toBe(second.url);
	});

	it('does not treat a health answer naming another service as chronicle', async () => {
		const other = await startFake(() => ({
			status: 200,
			body: { service: 'something-else', db: 'ok' }
		}));
		const client = makeClient({ env: {}, candidates: [other.url] });

		expect(await client.discover()).toBeNull();
	});

	it('does not treat a non-2xx chronicle health answer as healthy', async () => {
		const sick = await startFake(() => ({
			status: 503,
			body: { service: 'chronicle', version: '0.1.0', db: 'unavailable' }
		}));
		const client = makeClient({ env: {}, candidates: [sick.url] });

		expect(await client.discover()).toBeNull();
	});

	it('does not treat a non-JSON health body as chronicle', async () => {
		const plain = await startFake(() => ({ status: 200, text: 'ok' }));
		const client = makeClient({ env: {}, candidates: [plain.url] });

		expect(await client.discover()).toBeNull();
	});

	it('treats a health probe that never answers as unhealthy', async () => {
		const hung = await startFake(() => 'hang');
		const client = makeClient({ env: {}, candidates: [hung.url] });

		expect(await client.discover()).toBeNull();
	});

	it('gives a remote candidate the longer probe timeout and a loopback one the short timeout', async () => {
		const slowHealth = (url: string, init?: { signal?: AbortSignal }) =>
			new Promise<Response>((resolve, reject) => {
				const timer = setTimeout(
					() => resolve(Response.json({ service: 'chronicle', version: '0.1.0', db: 'ok' })),
					150
				);
				init?.signal?.addEventListener('abort', () => {
					clearTimeout(timer);
					reject(init.signal?.reason);
				});
			});
		const options = {
			env: {},
			fetch: slowHealth as unknown as typeof fetch,
			probeTimeoutMs: 50,
			remoteProbeTimeoutMs: 1000
		};

		expect(await makeClient({ ...options, candidates: ['http://localhost:3280'] }).discover()).toBe(
			null
		);
		expect(
			await makeClient({ ...options, candidates: ['https://chronicle.example.com'] }).discover()
		).toBe('https://chronicle.example.com');
	});

	it('returns null when every candidate is down', async () => {
		const client = makeClient({ env: {}, candidates: [DEAD, 'http://127.0.0.1:8'] });

		expect(await client.discover()).toBeNull();
	});

	it('probes candidates with trailing slashes removed', async () => {
		const fake = await startFake(() => healthy());
		const client = makeClient({ env: {}, candidates: [`${fake.url}/`] });

		expect(await client.discover()).toBe(fake.url);
		expect(fake.requests.map((r) => r.path)).toEqual(['/api/health']);
	});

	it('probes through an injected fetch', async () => {
		const fetchMock = vi.fn(
			async () =>
				new Response(JSON.stringify({ service: 'chronicle', version: '0.1.0', db: 'ok' }), {
					status: 200,
					headers: { 'content-type': 'application/json' }
				})
		);
		const client = makeClient({
			env: {},
			candidates: ['http://fake.invalid'],
			fetch: fetchMock as unknown as typeof fetch
		});

		expect(await client.discover()).toBe('http://fake.invalid');
		expect(fetchMock).toHaveBeenCalled();
		expect(String(fetchMock.mock.calls[0][0])).toBe('http://fake.invalid/api/health');
	});
});

describe('startTask', () => {
	it('creates the project, posts the task with its write key, and records both registries', async () => {
		const fake = await startFake(serveTasks());
		const cwd = workDir();
		const client = makeClient({ candidates: [fake.url] });

		const result = await client.startTask({
			title: 'Ship chunk 2',
			summary: 'the summary',
			state: 'in_work',
			note: 'started',
			steps: [{ key: 'chunk-1', title: 'Chunk 1' }],
			cwd
		});

		expect(result).toEqual({
			ok: true,
			value: {
				taskId: 'task-1',
				url: `${fake.url}/p/proj-1/t/task-1`,
				server: fake.url,
				projectId: 'proj-1',
				projectUrl: `${fake.url}/p/proj-1`,
				createdProject: true
			}
		});

		const posts = fake.requests.filter((r) => r.method === 'POST');
		expect(posts).toHaveLength(2);
		expect(posts[0].path).toBe('/api/projects');
		expect(posts[0].body).toEqual({});
		expect(posts[1].path).toBe('/api/projects/proj-1/tasks');
		expect(posts[1].headers.authorization).toBe('Bearer key-1');
		expect(posts[1].body).toEqual({
			title: 'Ship chunk 2',
			summary: 'the summary',
			state: 'in_work',
			note: 'started',
			steps: [{ key: 'chunk-1', title: 'Chunk 1' }]
		});

		expect(readFile('projects.json')).toEqual({
			[fake.url]: {
				[cwd]: {
					projectId: 'proj-1',
					writeKey: 'key-1',
					name: MONIKER,
					projectUrl: `${fake.url}/p/proj-1`
				}
			}
		});
		expect(readFile('tasks.json')).toEqual({
			'task-1': { server: fake.url, projectId: 'proj-1', projectUrl: `${fake.url}/p/proj-1` }
		});
		expect(modeOf('projects.json')).toBe(0o600);
		expect(modeOf('tasks.json')).toBe(0o600);
		expect(fs.readdirSync(configDir).sort()).toEqual(['projects.json', 'tasks.json']);
	});

	it('leaves undefined optional fields out of the task body', async () => {
		const fake = await startFake(serveTasks());
		const client = makeClient({ candidates: [fake.url] });

		const result = await client.startTask({ title: 'Only a title', cwd: workDir() });

		expect(result.ok).toBe(true);
		const post = fake.requests.filter((r) => r.path === '/api/projects/proj-1/tasks')[0];
		expect(Object.keys(post.body as object)).toEqual(['title']);
	});

	it('reuses the registered project on later tasks in the same repo', async () => {
		const fake = await startFake(serveTasks());
		const cwd = workDir();
		const client = makeClient({ candidates: [fake.url] });

		const first = await client.startTask({ title: 'one', cwd });
		const second = await client.startTask({ title: 'two', cwd });

		expect(first).toMatchObject({ ok: true, value: { createdProject: true, taskId: 'task-1' } });
		expect(second).toMatchObject({
			ok: true,
			value: { createdProject: false, taskId: 'task-2', projectId: 'proj-1' }
		});
		const projectPosts = fake.requests.filter(
			(r) => r.method === 'POST' && r.path === '/api/projects'
		);
		const taskPosts = fake.requests.filter((r) => r.method === 'POST' && r.path.endsWith('/tasks'));
		expect(projectPosts).toHaveLength(1);
		expect(taskPosts).toHaveLength(2);
		expect(taskPosts[1].headers.authorization).toBe('Bearer key-1');
		const handle = { server: fake.url, projectId: 'proj-1', projectUrl: `${fake.url}/p/proj-1` };
		expect(readFile('tasks.json')).toEqual({ 'task-1': handle, 'task-2': handle });
	});

	it.each([401, 403, 404])(
		'creates a fresh project, overwrites the registry, and retries once when the task POST answers %i',
		async (status) => {
			const fake = await startFake((req) => {
				const origin = `http://${req.headers.host}`;
				if (req.method === 'GET' && req.path === '/api/health') return healthy();
				if (req.method === 'POST' && req.path === '/api/projects') {
					return {
						status: 201,
						body: {
							id: 'proj-2',
							name: MONIKER,
							writeKey: 'key-2',
							url: `${origin}/p/proj-2`,
							config: CONFIG
						}
					};
				}
				if (req.path === '/api/projects/proj-1/tasks') return { status, body: { error: 'stale' } };
				if (req.path === '/api/projects/proj-2/tasks')
					return { status: 201, body: taskBody('task-9', 'proj-2', origin) };
				return { status: 404, body: { error: 'not found' } };
			});
			const cwd = workDir();
			seedFile('projects.json', {
				[fake.url]: { [cwd]: { projectId: 'proj-1', writeKey: 'key-1', name: 'stale' } }
			});
			const client = makeClient({ candidates: [fake.url] });

			const result = await client.startTask({ title: 'x', cwd });

			expect(result).toEqual({
				ok: true,
				value: {
					taskId: 'task-9',
					url: `${fake.url}/p/proj-2/t/task-9`,
					server: fake.url,
					projectId: 'proj-2',
					projectUrl: `${fake.url}/p/proj-2`,
					createdProject: true
				}
			});
			const taskPosts = fake.requests.filter(
				(r) => r.method === 'POST' && r.path.endsWith('/tasks')
			);
			expect(taskPosts.map((r) => [r.path, r.headers.authorization])).toEqual([
				['/api/projects/proj-1/tasks', 'Bearer key-1'],
				['/api/projects/proj-2/tasks', 'Bearer key-2']
			]);
			expect(taskPosts[1].body).toEqual(taskPosts[0].body);
			expect(
				fake.requests.filter((r) => r.method === 'POST' && r.path === '/api/projects')
			).toHaveLength(1);
			expect(readFile('projects.json')).toEqual({
				[fake.url]: {
					[cwd]: {
						projectId: 'proj-2',
						writeKey: 'key-2',
						name: MONIKER,
						projectUrl: `${fake.url}/p/proj-2`
					}
				}
			});
			expect(readFile('tasks.json')).toEqual({
				'task-9': { server: fake.url, projectId: 'proj-2', projectUrl: `${fake.url}/p/proj-2` }
			});
		}
	);

	it('returns the unreachable warning when no candidate is healthy', async () => {
		const cwd = workDir();
		const client = makeClient({ candidates: [DEAD] });

		expect(await client.startTask({ title: 'x', cwd })).toEqual({
			ok: false,
			warning: UNREACHABLE_WARNING
		});
		expect(fs.existsSync(path.join(configDir, 'projects.json'))).toBe(false);
		expect(fs.existsSync(path.join(configDir, 'tasks.json'))).toBe(false);
	});

	it('returns the unreachable warning when creating the project answers 500', async () => {
		const fake = await startFake((req) => {
			if (req.method === 'GET' && req.path === '/api/health') return healthy();
			return { status: 500, body: { error: 'boom' } };
		});
		const client = makeClient({ candidates: [fake.url] });

		expect(await client.startTask({ title: 'x', cwd: workDir() })).toEqual({
			ok: false,
			warning: UNREACHABLE_WARNING
		});
	});

	it('returns the unreachable warning when the task POST never answers', async () => {
		const fake = await startFake((req) => {
			if (req.method === 'GET' && req.path === '/api/health') return healthy();
			if (req.method === 'POST' && req.path === '/api/projects') {
				return { status: 201, body: { id: 'proj-1', writeKey: 'key-1', url: '', config: CONFIG } };
			}
			return 'hang';
		});
		const client = makeClient({ candidates: [fake.url] });

		expect(await client.startTask({ title: 'x', cwd: workDir() })).toEqual({
			ok: false,
			warning: UNREACHABLE_WARNING
		});
	});

	it('returns a rejection warning when the server refuses the task body', async () => {
		const fake = await startFake((req) => {
			if (req.method === 'GET' && req.path === '/api/health') return healthy();
			if (req.method === 'POST' && req.path === '/api/projects') {
				return { status: 201, body: { id: 'proj-1', writeKey: 'key-1', url: '', config: CONFIG } };
			}
			return { status: 400, body: { error: 'title is required' } };
		});
		const client = makeClient({ candidates: [fake.url] });

		expect(await client.startTask({ title: '', cwd: workDir() })).toEqual({
			ok: false,
			warning: 'chronicle rejected the update: title is required'
		});
	});

	it('posts to CHRONICLE_URL alone when it is set', async () => {
		const pinned = await startFake(serveTasks());
		const other = await startFake(serveTasks());
		const client = makeClient({ env: { CHRONICLE_URL: pinned.url }, candidates: [other.url] });

		const result = await client.startTask({ title: 'x', cwd: workDir() });

		expect(result).toMatchObject({ ok: true, value: { server: pinned.url } });
		expect(other.requests).toHaveLength(0);
	});

	it.each(['projects.json', 'tasks.json'])(
		'leaves a damaged %s untouched and starts nothing, so stored write keys survive',
		async (name) => {
			const fake = await startFake(serveTasks());
			writeRaw(name, '{"almost": "json",}');
			const client = makeClient({ candidates: [fake.url] });

			const result = await client.startTask({ title: 'x', cwd: workDir() });

			expect(result).toEqual({
				ok: false,
				warning: `chronicle failed: ${path.join(configDir, name)} is not a JSON object; fix or delete it`
			});
			expect(fs.readFileSync(path.join(configDir, name), 'utf8')).toBe('{"almost": "json",}');
			expect(fake.requests.filter((r) => r.method === 'POST')).toHaveLength(0);
		}
	);

	it('links to the public origin the server answers with, not the address it was reached on', async () => {
		const PUBLIC = 'https://chronicle.example.com';
		const fake = await startFake((req) => {
			if (req.method === 'GET' && req.path === '/api/health') return healthy();
			if (req.method === 'POST' && req.path === '/api/projects') {
				return {
					status: 201,
					body: { id: 'proj-1', writeKey: 'key-1', url: `${PUBLIC}/p/proj-1`, config: CONFIG }
				};
			}
			if (req.method === 'POST' && req.path === '/api/projects/proj-1/tasks') {
				return { status: 201, body: taskBody('task-1', 'proj-1', PUBLIC) };
			}
			if (req.method === 'GET' && req.path === '/api/tasks/task-1') {
				return { status: 200, body: { task: TASK, nodes: [] } };
			}
			return { status: 404, body: { error: 'not found' } };
		});
		const cwd = workDir();
		const client = makeClient({ candidates: [fake.url] });

		const started = await client.startTask({ title: 'x', cwd });

		expect(started).toMatchObject({
			ok: true,
			value: { url: `${PUBLIC}/p/proj-1/t/task-1`, projectUrl: `${PUBLIC}/p/proj-1` }
		});
		expect(await client.getTask({ taskId: 'task-1' })).toMatchObject({
			ok: true,
			value: { url: `${PUBLIC}/p/proj-1/t/task-1` }
		});
		expect(await client.projectUrl({ taskId: 'task-1' })).toEqual({
			ok: true,
			value: { url: `${PUBLIC}/p/proj-1/t/task-1` }
		});
		expect(await client.projectUrl({ cwd })).toEqual({
			ok: true,
			value: { url: `${PUBLIC}/p/proj-1` }
		});
	});

	it('creates a missing configDir with mode 0700', async () => {
		const fake = await startFake(serveTasks());
		configDir = path.join(configDir, 'nested', 'chronicle');
		const client = makeClient({ candidates: [fake.url] });

		const result = await client.startTask({ title: 'x', cwd: workDir() });

		expect(result.ok).toBe(true);
		expect(fs.statSync(configDir).mode & 0o777).toBe(0o700);
		expect(modeOf('projects.json')).toBe(0o600);
	});
});

describe('addNotice', () => {
	const NOTICE = {
		id: 'n-1',
		taskId: 'task-1',
		path: 'chunk-1',
		kind: 'assumption',
		text: 'Assumed UTC',
		createdAt: '2026-01-01T00:00:00.000Z'
	};

	it('POSTs the notice to the handle server with the project write key', async () => {
		const fake = await startFake(() => ({ status: 201, body: { notice: NOTICE } }));
		seedHandle(fake.url);
		const client = makeClient({ candidates: [DEAD] });

		const result = await client.addNotice({
			taskId: 'task-1',
			kind: 'assumption',
			text: 'Assumed UTC',
			path: 'chunk-1'
		});

		expect(result).toEqual({ ok: true, value: { notice: NOTICE } });
		const [req] = fake.requests;
		expect(req.method).toBe('POST');
		expect(req.path).toBe('/api/tasks/task-1/notices');
		expect(req.headers.authorization).toBe('Bearer key-1');
		expect(req.body).toEqual({ kind: 'assumption', text: 'Assumed UTC', path: 'chunk-1' });
	});

	it('omits path when none is given', async () => {
		const fake = await startFake(() => ({ status: 201, body: { notice: NOTICE } }));
		seedHandle(fake.url);
		const client = makeClient({ candidates: [DEAD] });

		await client.addNotice({ taskId: 'task-1', kind: 'caveat', text: 'Flaky test' });

		expect(fake.requests[0].body).toEqual({ kind: 'caveat', text: 'Flaky test' });
	});

	it('returns the unknown-task warning for an unknown task', async () => {
		const client = makeClient({ candidates: [DEAD] });

		expect(await client.addNotice({ taskId: 'nope', kind: 'caveat', text: 'x' })).toEqual({
			ok: false,
			warning: 'unknown task nope on this machine — continuing untracked'
		});
	});
});

describe('addImage', () => {
	const IMAGE = {
		id: 'i-1',
		taskId: 'task-1',
		path: 'chunk-1',
		caption: 'Login page',
		review: true,
		width: 512,
		height: 341,
		createdAt: '2026-01-01T00:00:00.000Z'
	};
	let dir: string;
	let png: string;

	beforeEach(async () => {
		dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chronicle-image-'));
		png = path.join(dir, 'shot.png');
		const raw = Buffer.alloc(1200 * 800 * 4);
		for (let i = 0; i < raw.length; i += 4) {
			const px = i / 4;
			raw[i] = (px % 1200) % 256;
			raw[i + 1] = Math.floor(px / 1200) % 256;
			raw[i + 2] = (px * 7) % 256;
			raw[i + 3] = 200;
		}
		await sharp(raw, { raw: { width: 1200, height: 800, channels: 4 } })
			.png()
			.toFile(png);
	});

	afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

	async function jpeg(base64: unknown) {
		expect(typeof base64).toBe('string');
		const bytes = Buffer.from(base64 as string, 'base64');
		return { bytes, meta: await sharp(bytes).metadata() };
	}

	it('POSTs a 256 px thumb and a 512 px full JPEG for review', async () => {
		const fake = await startFake(() => ({ status: 201, body: { image: IMAGE } }));
		seedHandle(fake.url);
		const client = makeClient({ candidates: [DEAD] });

		const result = await client.addImage({
			taskId: 'task-1',
			file: png,
			path: 'chunk-1',
			caption: 'Login page',
			review: true
		});

		expect(result).toEqual({ ok: true, value: { image: IMAGE } });
		const [req] = fake.requests;
		expect(req.method).toBe('POST');
		expect(req.path).toBe('/api/tasks/task-1/images');
		expect(req.headers.authorization).toBe('Bearer key-1');
		const body = req.body as Record<string, unknown>;
		expect(body.caption).toBe('Login page');
		expect(body.path).toBe('chunk-1');
		const thumb = await jpeg(body.thumb);
		expect(thumb.meta.format).toBe('jpeg');
		expect([thumb.meta.width, thumb.meta.height]).toEqual([256, 171]);
		expect(thumb.bytes.length).toBeLessThanOrEqual(64 * 1024);
		const full = await jpeg(body.full);
		expect(full.meta.format).toBe('jpeg');
		expect([full.meta.width, full.meta.height]).toEqual([512, 341]);
		expect(full.bytes.length).toBeLessThanOrEqual(192 * 1024);
	});

	it('sends only the thumb without review, and never enlarges', async () => {
		const small = path.join(dir, 'small.png');
		await sharp({
			create: { width: 100, height: 40, channels: 3, background: '#336699' }
		})
			.png()
			.toFile(small);
		const fake = await startFake(() => ({ status: 201, body: { image: IMAGE } }));
		seedHandle(fake.url);
		const client = makeClient({ candidates: [DEAD] });

		await client.addImage({ taskId: 'task-1', file: small });

		const body = fake.requests[0].body as Record<string, unknown>;
		expect(Object.keys(body)).toEqual(['thumb']);
		const thumb = await jpeg(body.thumb);
		expect([thumb.meta.width, thumb.meta.height]).toEqual([100, 40]);
	});

	it('warns without contacting the server when the file is not an image', async () => {
		const fake = await startFake(() => ({ status: 201, body: { image: IMAGE } }));
		seedHandle(fake.url);
		const client = makeClient({ candidates: [DEAD] });
		const bogus = path.join(dir, 'notes.txt');
		fs.writeFileSync(bogus, 'not an image');

		expect(await client.addImage({ taskId: 'task-1', file: bogus })).toEqual({
			ok: false,
			warning: `chronicle failed: cannot read image ${bogus}`
		});
		expect(fake.requests).toEqual([]);
	});

	it('returns the unknown-task warning for an unknown task', async () => {
		const client = makeClient({ candidates: [DEAD] });

		expect(await client.addImage({ taskId: 'nope', file: png })).toEqual({
			ok: false,
			warning: 'unknown task nope on this machine — continuing untracked'
		});
	});
});

describe('updateStep', () => {
	it('PUTs the node to the handle server with the project write key', async () => {
		const fake = await startFake((req) =>
			req.method === 'PUT'
				? { status: 200, body: { node: NODE } }
				: { status: 404, body: { error: 'x' } }
		);
		seedHandle(fake.url);
		const client = makeClient({ candidates: [DEAD] });

		const result = await client.updateStep({
			taskId: 'task-1',
			path: 'chunk-2/tests',
			state: 'done',
			note: 'ok'
		});

		expect(result).toEqual({ ok: true, value: { node: NODE } });
		expect(fake.requests).toHaveLength(1);
		const [req] = fake.requests;
		expect(req.method).toBe('PUT');
		expect(req.path).toBe('/api/tasks/task-1/nodes/chunk-2/tests');
		expect(req.headers.authorization).toBe('Bearer key-1');
		expect(req.body).toEqual({ state: 'done', note: 'ok' });
	});

	it('URI-encodes each path segment and keeps the slashes', async () => {
		const fake = await startFake(() => ({ status: 200, body: { node: NODE } }));
		seedHandle(fake.url);
		const client = makeClient({ candidates: [DEAD] });

		await client.updateStep({ taskId: 'task-1', path: 'chunk 2/tests' });

		expect(fake.requests[0].path).toBe('/api/tasks/task-1/nodes/chunk%202/tests');
	});

	it('sends falsy-but-given values: empty note and position 0', async () => {
		const fake = await startFake(() => ({ status: 200, body: { node: NODE } }));
		seedHandle(fake.url);
		const client = makeClient({ candidates: [DEAD] });

		await client.updateStep({ taskId: 'task-1', path: 'a', note: '', position: 0 });

		expect(fake.requests[0].body).toEqual({ note: '', position: 0 });
	});

	it('sends tags and title when given', async () => {
		const fake = await startFake(() => ({ status: 200, body: { node: NODE } }));
		seedHandle(fake.url);
		const client = makeClient({ candidates: [DEAD] });
		const tags = [{ text: 'round 2', color: '#a855f7' }, { text: 'opus' }];

		await client.updateStep({ taskId: 'task-1', path: 'a', title: 'Tests', tags });

		expect(fake.requests[0].body).toEqual({ title: 'Tests', tags });
	});

	it('uses the write key of the project matching the handle, not another project on the same server', async () => {
		const fake = await startFake(() => ({ status: 200, body: { node: NODE } }));
		seedFile('projects.json', {
			[fake.url]: {
				'/work/a/.git': { projectId: 'proj-A', writeKey: 'key-A', name: 'a' },
				'/work/b/.git': { projectId: 'proj-B', writeKey: 'key-B', name: 'b' }
			}
		});
		seedFile('tasks.json', { 'task-b': { server: fake.url, projectId: 'proj-B' } });
		const client = makeClient({ candidates: [DEAD] });

		await client.updateStep({ taskId: 'task-b', path: 'a' });

		expect(fake.requests[0].path).toBe('/api/tasks/task-b/nodes/a');
		expect(fake.requests[0].headers.authorization).toBe('Bearer key-B');
	});

	it('uses the handle server and never runs discovery', async () => {
		const handleServer = await startFake(() => ({ status: 200, body: { node: NODE } }));
		const pinned = await startFake(() => healthy());
		seedHandle(handleServer.url);
		const client = makeClient({ env: { CHRONICLE_URL: pinned.url }, candidates: [pinned.url] });

		const result = await client.updateStep({ taskId: 'task-1', path: 'a' });

		expect(result.ok).toBe(true);
		expect(handleServer.requests.map((r) => r.method)).toEqual(['PUT']);
		expect(pinned.requests).toHaveLength(0);
	});

	it('returns the unknown-task warning without contacting any server', async () => {
		const fake = await startFake(() => ({ status: 200, body: { node: NODE } }));
		seedFile('projects.json', {});
		const client = makeClient({ env: { CHRONICLE_URL: fake.url }, candidates: [fake.url] });

		expect(await client.updateStep({ taskId: 'task-404', path: 'a' })).toEqual({
			ok: false,
			warning: 'unknown task task-404 on this machine — continuing untracked'
		});
		expect(fake.requests).toHaveLength(0);
	});

	it('names a damaged tasks.json in its warning', async () => {
		writeRaw('tasks.json', '[[');
		const client = makeClient({ candidates: [DEAD] });

		expect(await client.updateStep({ taskId: 'task-1', path: 'a' })).toEqual({
			ok: false,
			warning: `chronicle failed: ${path.join(configDir, 'tasks.json')} is not a JSON object; fix or delete it`
		});
	});

	it('waits out a short Retry-After on 429 and sends the update once more', async () => {
		let calls = 0;
		const fake = await startFake(() => {
			calls += 1;
			return calls === 1
				? { status: 429, body: { error: 'too many writes' }, headers: { 'retry-after': '0' } }
				: { status: 200, body: { node: NODE } };
		});
		seedHandle(fake.url);
		const client = makeClient({ candidates: [DEAD] });

		expect(await client.updateStep({ taskId: 'task-1', path: 'a' })).toEqual({
			ok: true,
			value: { node: NODE }
		});
		expect(fake.requests.map((r) => r.method)).toEqual(['PUT', 'PUT']);
	});

	it('reports a 429 whose Retry-After is too long to wait without retrying', async () => {
		const fake = await startFake(() => ({
			status: 429,
			body: { error: 'too many writes' },
			headers: { 'retry-after': '60' }
		}));
		seedHandle(fake.url);
		const client = makeClient({ candidates: [DEAD] });

		expect(await client.updateStep({ taskId: 'task-1', path: 'a' })).toEqual({
			ok: false,
			warning: 'chronicle rejected the update: too many writes'
		});
		expect(fake.requests).toHaveLength(1);
	});

	it('maps a 400 with validStates to a rejection naming the valid states', async () => {
		const fake = await startFake(() => ({
			status: 400,
			body: { error: 'unknown state', validStates: ['queued', 'done'] }
		}));
		seedHandle(fake.url);
		const client = makeClient({ candidates: [DEAD] });

		expect(await client.updateStep({ taskId: 'task-1', path: 'a', state: 'nope' })).toEqual({
			ok: false,
			warning: 'chronicle rejected the update: unknown state (valid states: queued, done)'
		});
	});

	it('maps a 400 without validStates to a rejection with only the error', async () => {
		const fake = await startFake(() => ({ status: 400, body: { error: 'invalid path' } }));
		seedHandle(fake.url);
		const client = makeClient({ candidates: [DEAD] });

		expect(await client.updateStep({ taskId: 'task-1', path: 'a' })).toEqual({
			ok: false,
			warning: 'chronicle rejected the update: invalid path'
		});
	});

	it('maps a 403 to a rejection carrying the server error', async () => {
		const fake = await startFake(() => ({ status: 403, body: { error: 'invalid write key' } }));
		seedHandle(fake.url);
		const client = makeClient({ candidates: [DEAD] });

		expect(await client.updateStep({ taskId: 'task-1', path: 'a' })).toEqual({
			ok: false,
			warning: 'chronicle rejected the update: invalid write key'
		});
	});

	it.each([500, 502, 503])('maps a %i to the unreachable warning', async (status) => {
		const fake = await startFake(() => ({ status, body: { error: 'down' } }));
		seedHandle(fake.url);
		const client = makeClient({ candidates: [DEAD] });

		expect(await client.updateStep({ taskId: 'task-1', path: 'a' })).toEqual({
			ok: false,
			warning: UNREACHABLE_WARNING
		});
	});

	it('maps a request that times out to the unreachable warning', async () => {
		const fake = await startFake(() => 'hang');
		seedHandle(fake.url);
		const client = makeClient({ candidates: [DEAD], requestTimeoutMs: 200 });

		expect(await client.updateStep({ taskId: 'task-1', path: 'a' })).toEqual({
			ok: false,
			warning: UNREACHABLE_WARNING
		});
	});

	it('maps a refused connection to the unreachable warning', async () => {
		const fake = await startFake(() => ({ status: 200, body: { node: NODE } }));
		seedHandle(fake.url);
		await closeFake(fake);
		const client = makeClient({ candidates: [DEAD] });

		expect(await client.updateStep({ taskId: 'task-1', path: 'a' })).toEqual({
			ok: false,
			warning: UNREACHABLE_WARNING
		});
	});
});

describe('updateTask', () => {
	it('PATCHes the task on the handle server and returns it', async () => {
		const updated = { ...TASK, state: 'done' };
		const fake = await startFake(() => ({ status: 200, body: { task: updated } }));
		seedHandle(fake.url);
		const client = makeClient({ candidates: [DEAD] });

		const result = await client.updateTask({
			taskId: 'task-1',
			state: 'done',
			summary: '',
			note: '',
			title: 'T'
		});

		expect(result).toEqual({ ok: true, value: { task: updated } });
		const [req] = fake.requests;
		expect(req.method).toBe('PATCH');
		expect(req.path).toBe('/api/tasks/task-1');
		expect(req.headers.authorization).toBe('Bearer key-1');
		expect(req.body).toEqual({ state: 'done', summary: '', note: '', title: 'T' });
	});

	it('sends an empty note as given', async () => {
		const fake = await startFake(() => ({ status: 200, body: { task: TASK } }));
		seedHandle(fake.url);
		const client = makeClient({ candidates: [DEAD] });

		await client.updateTask({ taskId: 'task-1', note: '' });

		expect(fake.requests[0].body).toEqual({ note: '' });
	});

	it('returns the unknown-task warning for an unknown task', async () => {
		const fake = await startFake(() => ({ status: 200, body: { task: TASK } }));
		const client = makeClient({ env: { CHRONICLE_URL: fake.url }, candidates: [fake.url] });

		expect(await client.updateTask({ taskId: 'task-404', state: 'done' })).toEqual({
			ok: false,
			warning: 'unknown task task-404 on this machine — continuing untracked'
		});
		expect(fake.requests).toHaveLength(0);
	});

	it('maps a 400 with validStates to a rejection naming the valid states', async () => {
		const fake = await startFake(() => ({
			status: 400,
			body: { error: 'unknown state', validStates: ['queued', 'done'] }
		}));
		seedHandle(fake.url);
		const client = makeClient({ candidates: [DEAD] });

		expect(await client.updateTask({ taskId: 'task-1', state: 'nope' })).toEqual({
			ok: false,
			warning: 'chronicle rejected the update: unknown state (valid states: queued, done)'
		});
	});

	it('maps a 500 to the unreachable warning', async () => {
		const fake = await startFake(() => ({ status: 500, body: { error: 'boom' } }));
		seedHandle(fake.url);
		const client = makeClient({ candidates: [DEAD] });

		expect(await client.updateTask({ taskId: 'task-1', state: 'done' })).toEqual({
			ok: false,
			warning: UNREACHABLE_WARNING
		});
	});

	it('maps a request that times out to the unreachable warning', async () => {
		const fake = await startFake(() => 'hang');
		seedHandle(fake.url);
		const client = makeClient({ candidates: [DEAD], requestTimeoutMs: 200 });

		expect(await client.updateTask({ taskId: 'task-1', state: 'done' })).toEqual({
			ok: false,
			warning: UNREACHABLE_WARNING
		});
	});
});

describe('getTask', () => {
	it('GETs the task and its nodes and returns the task URL under the handle project', async () => {
		const fake = await startFake(() => ({ status: 200, body: { task: TASK, nodes: [NODE] } }));
		seedHandle(fake.url);
		const client = makeClient({ candidates: [DEAD] });

		const result = await client.getTask({ taskId: 'task-1' });

		expect(result).toEqual({
			ok: true,
			value: { task: TASK, nodes: [NODE], notices: [], url: `${fake.url}/p/proj-1/t/task-1` }
		});
		expect(fake.requests).toHaveLength(1);
		expect(fake.requests[0].method).toBe('GET');
		expect(fake.requests[0].path).toBe('/api/tasks/task-1');
	});

	it('uses the handle server only and never runs discovery', async () => {
		const handleServer = await startFake(() => ({ status: 200, body: { task: TASK, nodes: [] } }));
		const pinned = await startFake(() => healthy());
		seedHandle(handleServer.url);
		const client = makeClient({ env: { CHRONICLE_URL: pinned.url }, candidates: [pinned.url] });

		const result = await client.getTask({ taskId: 'task-1' });

		expect(result).toMatchObject({
			ok: true,
			value: { url: `${handleServer.url}/p/proj-1/t/task-1` }
		});
		expect(handleServer.requests.map((r) => r.path)).toEqual(['/api/tasks/task-1']);
		expect(pinned.requests).toHaveLength(0);
	});

	it('returns the unknown-task warning for an unknown task', async () => {
		const fake = await startFake(() => ({ status: 200, body: { task: TASK, nodes: [] } }));
		const client = makeClient({ env: { CHRONICLE_URL: fake.url }, candidates: [fake.url] });

		expect(await client.getTask({ taskId: 'task-404' })).toEqual({
			ok: false,
			warning: 'unknown task task-404 on this machine — continuing untracked'
		});
		expect(fake.requests).toHaveLength(0);
	});

	it('maps a 404 from the server to a rejection with its error', async () => {
		const fake = await startFake(() => ({ status: 404, body: { error: 'task not found' } }));
		seedHandle(fake.url);
		const client = makeClient({ candidates: [DEAD] });

		expect(await client.getTask({ taskId: 'task-1' })).toEqual({
			ok: false,
			warning: 'chronicle rejected the update: task not found'
		});
	});

	it('maps a 500 to the unreachable warning', async () => {
		const fake = await startFake(() => ({ status: 500, body: { error: 'boom' } }));
		seedHandle(fake.url);
		const client = makeClient({ candidates: [DEAD] });

		expect(await client.getTask({ taskId: 'task-1' })).toEqual({
			ok: false,
			warning: UNREACHABLE_WARNING
		});
	});

	it('maps a refused connection to the unreachable warning', async () => {
		const fake = await startFake(() => ({ status: 200, body: { task: TASK, nodes: [] } }));
		seedHandle(fake.url);
		await closeFake(fake);
		const client = makeClient({ candidates: [DEAD] });

		expect(await client.getTask({ taskId: 'task-1' })).toEqual({
			ok: false,
			warning: UNREACHABLE_WARNING
		});
	});
});

describe('configure and projectUrl', () => {
	const REGISTERED = {
		projectId: 'proj-1',
		writeKey: 'key-1',
		name: 'repo'
	};

	function seedCwd(server: string, cwd: string): void {
		seedFile('projects.json', { [server]: { [cwd]: { ...REGISTERED, name: path.basename(cwd) } } });
	}

	it('PUTs the whole config to the project found for the cwd', async () => {
		const fake = await startFake(
			answering((req) =>
				req.method === 'PUT'
					? { status: 200, body: { config: CONFIG } }
					: { status: 404, body: { error: 'x' } }
			)
		);
		const cwd = workDir();
		seedCwd(fake.url, cwd);
		const client = makeClient({ candidates: [fake.url] });

		const result = await client.configure({ cwd, config: CONFIG });

		expect(result).toEqual({
			ok: true,
			value: { config: CONFIG, projectUrl: `${fake.url}/p/proj-1` }
		});
		const put = fake.requests.find((r) => r.method !== 'GET');
		expect(put?.method).toBe('PUT');
		expect(put?.path).toBe('/api/projects/proj-1/config');
		expect(put?.headers.authorization).toBe('Bearer key-1');
		expect(put?.body).toEqual(CONFIG);
	});

	it('PATCHes a patch to the project found for the cwd', async () => {
		const patched = { ...CONFIG, theme: 'dark' as const };
		const fake = await startFake(
			answering((req) =>
				req.method === 'PATCH'
					? { status: 200, body: { config: patched } }
					: { status: 404, body: { error: 'x' } }
			)
		);
		const cwd = workDir();
		seedCwd(fake.url, cwd);
		const client = makeClient({ candidates: [fake.url] });

		const result = await client.configure({ cwd, patch: { theme: 'dark' } });

		expect(result).toEqual({
			ok: true,
			value: { config: patched, projectUrl: `${fake.url}/p/proj-1` }
		});
		const patch = fake.requests.find((r) => r.method !== 'GET');
		expect(patch?.method).toBe('PATCH');
		expect(patch?.path).toBe('/api/projects/proj-1/config');
		expect(patch?.headers.authorization).toBe('Bearer key-1');
		expect(patch?.body).toEqual({ theme: 'dark' });
	});

	it('sends only the PUT when both config and patch are given', async () => {
		const fake = await startFake(
			answering((req) =>
				req.method === 'PUT'
					? { status: 200, body: { config: CONFIG } }
					: { status: 404, body: { error: 'x' } }
			)
		);
		const cwd = workDir();
		seedCwd(fake.url, cwd);
		const client = makeClient({ candidates: [fake.url] });

		await client.configure({ cwd, config: CONFIG, patch: { theme: 'dark' } });

		expect(fake.requests.filter((r) => r.method !== 'GET').map((r) => r.method)).toEqual(['PUT']);
		expect(fake.requests.find((r) => r.method === 'PUT')?.body).toEqual(CONFIG);
	});

	it('reads the current config when neither config nor patch is given', async () => {
		const fake = await startFake(
			answering((req) =>
				req.method === 'GET' && req.path === '/api/projects/proj-1'
					? {
							status: 200,
							body: {
								project: {
									id: 'proj-1',
									name: 'repo',
									config: CONFIG,
									createdAt: T,
									lastWriteAt: T
								},
								tasks: [],
								nodes: [],
								lastSeq: 0
							}
						}
					: { status: 404, body: { error: 'x' } }
			)
		);
		const cwd = workDir();
		seedCwd(fake.url, cwd);
		const client = makeClient({ candidates: [fake.url] });

		const result = await client.configure({ cwd });

		expect(result).toEqual({
			ok: true,
			value: { config: CONFIG, projectUrl: `${fake.url}/p/proj-1` }
		});
		expect(fake.requests.map((r) => r.method)).toEqual(['GET', 'GET']);
	});

	it('uses the handle project and server when a taskId is given', async () => {
		const fake = await startFake(
			answering((req) =>
				req.method === 'PATCH'
					? { status: 200, body: { config: CONFIG } }
					: { status: 404, body: { error: 'x' } }
			)
		);
		seedHandle(fake.url);
		const client = makeClient({ env: { CHRONICLE_URL: DEAD }, candidates: [DEAD] });

		const result = await client.configure({ taskId: 'task-1', patch: { initialState: 'queued' } });

		expect(result).toMatchObject({ ok: true, value: { projectUrl: `${fake.url}/p/proj-1` } });
		const patch = fake.requests.find((r) => r.method === 'PATCH');
		expect(patch?.path).toBe('/api/projects/proj-1/config');
		expect(patch?.headers.authorization).toBe('Bearer key-1');
	});

	it('returns the no-project warning when the repo has no registered project', async () => {
		const fake = await startFake(() => healthy());
		const cwd = workDir();
		const client = makeClient({ candidates: [fake.url] });

		expect(await client.configure({ cwd, patch: { theme: 'dark' } })).toEqual({
			ok: false,
			warning: 'no chronicle project for this repo yet — start a task first'
		});
	});

	it('names a damaged projects.json in its warning', async () => {
		const fake = await startFake(() => healthy());
		writeRaw('projects.json', '{{{');
		const client = makeClient({ candidates: [fake.url] });

		expect(await client.projectUrl({ cwd: workDir() })).toEqual({
			ok: false,
			warning: `chronicle failed: ${path.join(configDir, 'projects.json')} is not a JSON object; fix or delete it`
		});
	});

	it('projectUrl returns the project URL for the cwd', async () => {
		const fake = await startFake(() => healthy());
		const cwd = workDir();
		seedCwd(fake.url, cwd);
		const client = makeClient({ candidates: [fake.url] });

		expect(await client.projectUrl({ cwd })).toEqual({
			ok: true,
			value: { url: `${fake.url}/p/proj-1` }
		});
	});

	it('projectUrl with a taskId returns that task URL', async () => {
		const fake = await startFake(() => healthy());
		seedHandle(fake.url);
		const client = makeClient({ candidates: [DEAD] });

		expect(await client.projectUrl({ taskId: 'task-1' })).toEqual({
			ok: true,
			value: { url: `${fake.url}/p/proj-1/t/task-1` }
		});
	});
});

describe('doctor', () => {
	it('reports the pinned server, its probe, and the registry entry for this repo', async () => {
		const fake = await startFake(serveTasks());
		const cwd = workDir();
		const client = makeClient({ env: { CHRONICLE_URL: `${fake.url}/` }, candidates: [DEAD] });
		await client.startTask({ title: 'x', cwd });

		const report = await client.doctor({ cwd });

		expect(report).toEqual({
			configDir,
			pinned: fake.url,
			probes: [{ server: fake.url, ok: true, version: '0.1.0' }],
			server: fake.url,
			repoKey: cwd,
			registered: { projectId: 'proj-1', name: MONIKER },
			registryError: null
		});
	});

	it('probes each candidate in order and names the first healthy one', async () => {
		const up = await startFake(() => healthy('2.0.0'));
		const cwd = workDir();
		const client = makeClient({ env: {}, candidates: [DEAD, up.url] });

		const report = await client.doctor({ cwd });

		expect(report).toEqual({
			configDir,
			pinned: null,
			probes: [
				{ server: DEAD, ok: false },
				{ server: up.url, ok: true, version: '2.0.0' }
			],
			server: up.url,
			repoKey: cwd,
			registered: null,
			registryError: null
		});
	});

	it('reports a null server when every candidate is down', async () => {
		const client = makeClient({ env: {}, candidates: [DEAD] });

		const report = await client.doctor({ cwd: workDir() });

		expect(report.server).toBeNull();
		expect(report.probes).toEqual([{ server: DEAD, ok: false }]);
		expect(report.registered).toBeNull();
	});

	it('resolves with the registry problem when projects.json is damaged', async () => {
		const up = await startFake(() => healthy());
		writeRaw('projects.json', 'nope');
		const client = makeClient({ env: {}, candidates: [up.url] });

		const report = await client.doctor({ cwd: workDir() });

		expect(report.registered).toBeNull();
		expect(report.registryError).toBe(
			`${path.join(configDir, 'projects.json')} is not a JSON object; fix or delete it`
		);
	});

	it('resolves with a null server when the transport throws', async () => {
		const client = makeClient({
			env: {},
			candidates: ['http://fake.invalid'],
			fetch: vi.fn().mockRejectedValue(new TypeError('fetch failed')) as unknown as typeof fetch
		});

		const report = await client.doctor({ cwd: workDir() });

		expect(report.server).toBeNull();
		expect(report.probes).toEqual([{ server: 'http://fake.invalid', ok: false }]);
	});
});

describe('methods never reject', () => {
	it('resolve with ok:false when the transport throws on every call', async () => {
		seedHandle('http://fake.invalid');
		const cwd = workDir();
		const failing = vi
			.fn()
			.mockRejectedValue(new TypeError('fetch failed')) as unknown as typeof fetch;
		const client = makeClient({ env: {}, candidates: ['http://fake.invalid'], fetch: failing });

		await expect(client.discover()).resolves.toBeNull();
		await expect(client.startTask({ title: 'x', cwd })).resolves.toEqual({
			ok: false,
			warning: UNREACHABLE_WARNING
		});
		await expect(client.updateStep({ taskId: 'task-1', path: 'a' })).resolves.toEqual({
			ok: false,
			warning: UNREACHABLE_WARNING
		});
		await expect(client.updateTask({ taskId: 'task-1', state: 'done' })).resolves.toEqual({
			ok: false,
			warning: UNREACHABLE_WARNING
		});
		await expect(client.getTask({ taskId: 'task-1' })).resolves.toEqual({
			ok: false,
			warning: UNREACHABLE_WARNING
		});
		await expect(client.configure({ taskId: 'task-1', patch: { theme: 'dark' } })).resolves.toEqual(
			{
				ok: false,
				warning: UNREACHABLE_WARNING
			}
		);
		await expect(client.projectUrl({ taskId: 'task-1' })).resolves.toEqual({
			ok: true,
			value: { url: 'http://fake.invalid/p/proj-1/t/task-1' }
		});
		expect(failing).toHaveBeenCalled();
	});
});

describe('repoIdentity', () => {
	it('gives a git repo the key of its common .git dir and the repo dir name', async () => {
		const repo = workDir();
		git(repo, ['init', '-q']);
		git(repo, ['commit', '-q', '--allow-empty', '-m', 'init']);

		const identity = await repoIdentity(repo);

		expect(identity).toEqual({ repoKey: path.join(repo, '.git'), name: path.basename(repo) });
		expect(identity.repoKey).toMatch(/\/\.git$/);
	});

	it('resolves a subdirectory of a repo to the same repo key', async () => {
		const repo = workDir();
		git(repo, ['init', '-q']);
		git(repo, ['commit', '-q', '--allow-empty', '-m', 'init']);
		const sub = path.join(repo, 'packages', 'client');
		fs.mkdirSync(sub, { recursive: true });

		expect(await repoIdentity(sub)).toEqual({
			repoKey: path.join(repo, '.git'),
			name: path.basename(repo)
		});
	});

	it('gives a git worktree the repo key and name of its main repo', async () => {
		const repo = workDir();
		git(repo, ['init', '-q']);
		git(repo, ['commit', '-q', '--allow-empty', '-m', 'init']);
		const worktree = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ws-wt-')), 'wt');
		git(repo, ['worktree', 'add', '-q', '--detach', worktree]);

		const main = await repoIdentity(repo);
		const linked = await repoIdentity(worktree);

		expect(linked.repoKey).toBe(main.repoKey);
		expect(linked.name).toBe(path.basename(repo));
		expect(linked.repoKey).toBe(path.join(repo, '.git'));
	});

	it('falls back to the realpath and basename outside git', async () => {
		const dir = workDir();

		expect(await repoIdentity(dir)).toEqual({ repoKey: dir, name: path.basename(dir) });
	});

	it('gives a non-git dir a key that does not end in .git', async () => {
		const dir = workDir();

		const identity = await repoIdentity(dir);

		expect(identity.repoKey.endsWith('/.git')).toBe(false);
	});

	it('keys a git repo and a plain dir differently', async () => {
		const repo = workDir();
		git(repo, ['init', '-q']);
		git(repo, ['commit', '-q', '--allow-empty', '-m', 'init']);
		const plain = workDir();

		expect((await repoIdentity(repo)).repoKey).not.toBe((await repoIdentity(plain)).repoKey);
	});
});

describe('project names, refs and agent info', () => {
	function withPatch(base: Handler): Handler {
		return (req) =>
			req.method === 'PATCH' && req.path === '/api/projects/proj-1'
				? {
						status: 200,
						body: { project: { id: 'proj-1', name: (req.body as { name: string }).name } }
					}
				: base(req);
	}

	it('names a new project after `project` when given', async () => {
		const fake = await startFake(serveTasks());
		const client = makeClient({ candidates: [fake.url] });

		await client.startTask({ title: 't', project: 'Billing revamp', cwd: workDir() });

		expect(fake.requests.find((r) => r.path === '/api/projects')?.body).toEqual({
			name: 'Billing revamp'
		});
	});

	it('renames the registered project once when a later start names it differently', async () => {
		const fake = await startFake(withPatch(serveTasks()));
		const cwd = workDir();
		const client = makeClient({ candidates: [fake.url] });

		await client.startTask({ title: 'one', cwd });
		await client.startTask({ title: 'two', project: 'Billing', cwd });
		await client.startTask({ title: 'three', project: 'Billing', cwd });

		const patches = fake.requests.filter((r) => r.method === 'PATCH');
		expect(patches).toHaveLength(1);
		expect(patches[0].headers.authorization).toBe('Bearer key-1');
		expect(patches[0].body).toEqual({ name: 'Billing' });
		expect(readFile('projects.json')).toMatchObject({ [fake.url]: { [cwd]: { name: 'Billing' } } });
	});

	it('sends the repo and branch of the git checkout it runs in', async () => {
		const fake = await startFake(serveTasks());
		const cwd = workDir();
		git(cwd, ['init', '-q', '-b', 'feat/cards']);
		git(cwd, ['remote', 'add', 'origin', 'git@github.com:me/chronicle.git']);
		const client = makeClient({ candidates: [fake.url] });

		await client.startTask({ title: 't', cwd });

		const post = fake.requests.find((r) => r.path === '/api/projects/proj-1/tasks');
		expect(post?.body).toMatchObject({ repo: 'me/chronicle', branch: 'feat/cards' });
	});

	it('lets explicit repo and branch win over git', async () => {
		const fake = await startFake(serveTasks());
		const cwd = workDir();
		git(cwd, ['init', '-q', '-b', 'main']);
		const client = makeClient({ candidates: [fake.url] });

		await client.startTask({ title: 't', repo: 'x/y', branch: 'b', cwd });

		const post = fake.requests.find((r) => r.path === '/api/projects/proj-1/tasks');
		expect(post?.body).toMatchObject({ repo: 'x/y', branch: 'b' });
	});

	it('fills agent.tool with claude-code when CLAUDECODE=1 and the caller named no tool', async () => {
		const fake = await startFake(serveTasks());
		const client = makeClient({ candidates: [fake.url], env: { CLAUDECODE: '1' } });

		await client.startTask({ title: 'a', agent: { model: 'opus' }, cwd: workDir() });
		await client.startTask({ title: 'b', agent: { tool: 'codex' }, cwd: workDir() });

		const posts = fake.requests.filter((r) => r.path === '/api/projects/proj-1/tasks');
		expect((posts[0].body as { agent: unknown }).agent).toEqual({
			model: 'opus',
			tool: 'claude-code'
		});
		expect((posts[1].body as { agent: unknown }).agent).toEqual({ tool: 'codex' });
	});

	it('sends agent and links on step and task updates', async () => {
		const fake = await startFake(
			answering(() => ({ status: 200, body: { node: NODE, task: TASK } }))
		);
		seedHandle(fake.url);
		const client = makeClient();
		const links = [{ url: 'https://github.com/me/repo/pull/1', label: 'PR' }];

		await client.updateStep({ taskId: 'task-1', path: 'a', agent: { tokens: 9 }, links });
		await client.updateTask({ taskId: 'task-1', state: 'done', agent: { tokens: 10 } });

		expect(fake.requests[0].body).toEqual({ agent: { tokens: 9 }, links });
		expect(fake.requests[1].body).toEqual({ state: 'done', agent: { tokens: 10 } });
	});

	it('PATCHes the project from a task handle with updateProject', async () => {
		const fake = await startFake(
			answering(() => ({ status: 200, body: { project: { id: 'proj-1', name: 'N', notes: 'x' } } }))
		);
		seedHandle(fake.url);
		const client = makeClient();

		const result = await client.updateProject({ taskId: 'task-1', notes: 'x' });

		expect(result.ok).toBe(true);
		expect(fake.requests[0]).toMatchObject({
			method: 'PATCH',
			path: '/api/projects/proj-1',
			body: { notes: 'x' }
		});
		expect(fake.requests[0].headers.authorization).toBe('Bearer key-1');
	});
});

describe('repoFromRemote', () => {
	it.each([
		['git@github.com:me/chronicle.git', 'me/chronicle'],
		['https://github.com/me/chronicle', 'me/chronicle'],
		['https://gitlab.com/group/sub/proj.git', 'sub/proj'],
		['ssh://git@host:2222/me/repo.git/', 'me/repo']
	])('reads %s as %s', (remote, repo) => {
		expect(repoFromRemote(remote)).toBe(repo);
	});
});

describe('syncPrs', () => {
	const PR = 'https://github.com/me/repo/pull/42';
	const REVIEW_CONFIG = {
		...CONFIG,
		states: [
			...CONFIG.states,
			{ key: 'review', label: 'In review', color: '#7dd3fc', kind: 'review' as const }
		]
	};

	function forge(state: string, extra: Record<string, unknown> = {}) {
		return vi.fn(async () => JSON.stringify({ number: 42, title: 'T', state, ...extra }));
	}

	function serving(task: Partial<Task>) {
		return answering((req) => {
			if (req.method === 'GET' && req.path === '/api/tasks/task-1') {
				return { status: 200, body: { task: { ...TASK, ...task }, nodes: [] } };
			}
			if (req.method === 'GET' && req.path === '/api/projects/proj-1') {
				return { status: 200, body: { project: { config: REVIEW_CONFIG } } };
			}
			if (req.method === 'PATCH') return { status: 200, body: { task: TASK } };
			return { status: 404, body: { error: 'not found' } };
		});
	}

	it('writes the fresh PR status when it changed', async () => {
		const fake = await startFake(serving({ state: 'review', prs: [{ url: PR, state: 'open' }] }));
		seedHandle(fake.url);
		const client = makeClient({
			runCommand: forge('OPEN', { reviewDecision: 'APPROVED' })
		});

		const result = await client.syncPrs();

		expect(result).toEqual({ ok: true, value: { checked: 1, updated: ['task-1'] } });
		const patch = fake.requests.find((r) => r.method === 'PATCH');
		expect(patch?.body).toEqual({
			prs: [{ url: PR, number: 42, title: 'T', state: 'open', review: 'approved' }]
		});
	});

	it('moves a task in review to done when every PR merged', async () => {
		const fake = await startFake(serving({ state: 'review', prs: [{ url: PR, state: 'open' }] }));
		seedHandle(fake.url);
		const client = makeClient({ runCommand: forge('MERGED') });

		await client.syncPrs();

		const patch = fake.requests.find((r) => r.method === 'PATCH');
		expect(patch?.body).toMatchObject({ state: 'done', note: 'merged' });
	});

	it('updates a merged PR but leaves a task outside review in its state', async () => {
		const fake = await startFake(serving({ state: 'in_work', prs: [{ url: PR, state: 'open' }] }));
		seedHandle(fake.url);
		const client = makeClient({ runCommand: forge('MERGED') });

		await client.syncPrs();

		const patch = fake.requests.find((r) => r.method === 'PATCH');
		expect(patch?.body).not.toHaveProperty('state');
		expect((patch?.body as { prs: { state: string }[] }).prs[0].state).toBe('merged');
	});

	it('writes nothing when the forge reports what the dashboard already shows', async () => {
		const pr = { url: PR, number: 42, title: 'T', state: 'open' };
		const fake = await startFake(serving({ state: 'review', prs: [pr] }));
		seedHandle(fake.url);
		const client = makeClient({ runCommand: forge('OPEN') });

		expect(await client.syncPrs()).toEqual({ ok: true, value: { checked: 1, updated: [] } });
		expect(fake.requests.some((r) => r.method === 'PATCH')).toBe(false);
	});

	it('writes nothing when gh is unavailable', async () => {
		const fake = await startFake(serving({ state: 'review', prs: [{ url: PR, state: 'open' }] }));
		seedHandle(fake.url);
		const client = makeClient({ runCommand: vi.fn(async () => null) });

		await client.syncPrs();

		expect(fake.requests.some((r) => r.method === 'PATCH')).toBe(false);
	});

	it('stops checking a task once all its PRs are merged or closed', async () => {
		const fake = await startFake(serving({ state: 'done', prs: [{ url: PR, state: 'merged' }] }));
		seedHandle(fake.url);
		const run = forge('MERGED');
		const client = makeClient({ runCommand: run });

		await client.syncPrs();
		await client.syncPrs();

		expect(run).not.toHaveBeenCalled();
		expect(fake.requests.filter((r) => r.path === '/api/tasks/task-1')).toHaveLength(1);
	});
});
