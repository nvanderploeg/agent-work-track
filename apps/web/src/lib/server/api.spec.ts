import { describe, it, expect, beforeEach } from 'vitest';
import { readBody } from '#lib/server/api.ts';
import { subscribe } from '#lib/server/bus.ts';
import { PRESETS } from '#lib/server/presets.ts';
import { resetDb } from '#lib/server/test/db.ts';
import { GET as getHealth } from '../../routes/api/health/+server.ts';
import { GET as getPresets } from '../../routes/api/presets/+server.ts';
import { POST as postProject } from '../../routes/api/projects/+server.ts';
import {
	GET as getProjectHandler,
	PATCH as patchProjectHandler
} from '../../routes/api/projects/[id]/+server.ts';
import {
	PUT as putConfigHandler,
	PATCH as patchConfigHandler
} from '../../routes/api/projects/[id]/config/+server.ts';
import { POST as postTask } from '../../routes/api/projects/[id]/tasks/+server.ts';
import {
	GET as getTaskHandler,
	PATCH as patchTaskHandler
} from '../../routes/api/tasks/[taskId]/+server.ts';
import { GET as getEventsHandler } from '../../routes/api/tasks/[taskId]/events/+server.ts';
import { POST as postNoticeHandler } from '../../routes/api/tasks/[taskId]/notices/+server.ts';
import { POST as postImageHandler } from '../../routes/api/tasks/[taskId]/images/+server.ts';
import { GET as getImageFileHandler } from '../../routes/api/images/[imageId]/[file]/+server.ts';
import { fakeJpeg } from '#lib/server/test/jpeg.ts';
import { PUT as putNodeHandler } from '../../routes/api/tasks/[taskId]/nodes/[...path]/+server.ts';

type Body = Record<string, any>;

interface Proj {
	id: string;
	writeKey: string;
	url: string;
	config: Body;
}

interface NewTask {
	taskId: string;
	url: string;
	task: Body;
	nodes: Body[];
}

interface Call {
	method?: string;
	path: string;
	body?: unknown;
	rawBody?: string;
	key?: string;
	params?: Record<string, string>;
	origin?: string;
}

const ORIGIN = 'http://localhost';
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;
const BUILD_IT = PRESETS['build-it'];
const BUILD_IT_KEYS = [
	'queued',
	'planning',
	'in_work',
	'testing',
	'review',
	'needs_input',
	'failed',
	'done'
];

const CUSTOM_CONFIG = {
	theme: 'dark',
	initialState: 'todo',
	states: [
		{ key: 'todo', label: 'To do', color: '#111111', kind: 'pending', animation: 'none' },
		{
			key: 'doing',
			label: 'Doing',
			color: 'rgb(10, 20, 30)',
			kind: 'active',
			icon: 'D',
			animation: 'pulse'
		},
		{ key: 'shipped', label: 'Shipped', color: '#00ff00', kind: 'done', animation: 'none' }
	]
};

const BAD_PATHS: [string, string][] = [
	['a character outside the segment set', 'bad key!'],
	['an empty segment', 'ok//seg'],
	['a segment longer than 64 characters', 'x'.repeat(65)],
	['a path longer than 512 characters', Array(8).fill('s'.repeat(64)).join('/')],
	['a valid segment before an invalid one', 'ok/bad key!']
];

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 1100));

function event({ method = 'GET', path, body, rawBody, key, params = {}, origin = ORIGIN }: Call) {
	const url = new URL(path, origin);
	const headers = new Headers();
	const init: RequestInit = { method, headers };
	if (rawBody !== undefined) {
		headers.set('content-type', 'application/json');
		init.body = rawBody;
	} else if (body !== undefined) {
		headers.set('content-type', 'application/json');
		init.body = JSON.stringify(body);
	}
	if (key !== undefined) headers.set('authorization', `Bearer ${key}`);
	return {
		request: new Request(url, init),
		params,
		url,
		getClientAddress: () => '10.0.0.1'
	} as never;
}

const api = {
	presets: () => getPresets(event({ path: '/api/presets' })),
	createProject: (body: unknown = {}, origin?: string) =>
		postProject(event({ method: 'POST', path: '/api/projects', body, origin })),
	rawCreateProject: (rawBody: string) =>
		postProject(event({ method: 'POST', path: '/api/projects', rawBody })),
	getProject: (id: string) =>
		getProjectHandler(event({ path: `/api/projects/${id}`, params: { id } })),
	patchProject: (id: string, body: unknown, key?: string) =>
		patchProjectHandler(
			event({ method: 'PATCH', path: `/api/projects/${id}`, body, key, params: { id } })
		),
	putConfig: (id: string, body: unknown, key?: string) =>
		putConfigHandler(
			event({ method: 'PUT', path: `/api/projects/${id}/config`, body, key, params: { id } })
		),
	patchConfig: (id: string, body: unknown, key?: string) =>
		patchConfigHandler(
			event({ method: 'PATCH', path: `/api/projects/${id}/config`, body, key, params: { id } })
		),
	createTask: (id: string, body: unknown, key?: string) =>
		postTask(
			event({ method: 'POST', path: `/api/projects/${id}/tasks`, body, key, params: { id } })
		),
	getTask: (taskId: string) =>
		getTaskHandler(event({ path: `/api/tasks/${taskId}`, params: { taskId } })),
	patchTask: (taskId: string, body: unknown, key?: string) =>
		patchTaskHandler(
			event({ method: 'PATCH', path: `/api/tasks/${taskId}`, body, key, params: { taskId } })
		),
	getEvents: (taskId: string, path?: string) =>
		getEventsHandler(
			event({
				path: `/api/tasks/${taskId}/events${path === undefined ? '' : `?path=${encodeURIComponent(path)}`}`,
				params: { taskId }
			})
		),
	postNotice: (taskId: string, body: unknown, key?: string) =>
		postNoticeHandler(
			event({
				method: 'POST',
				path: `/api/tasks/${taskId}/notices`,
				body,
				key,
				params: { taskId }
			})
		),
	postImage: (taskId: string, body: unknown, key?: string) =>
		postImageHandler(
			event({
				method: 'POST',
				path: `/api/tasks/${taskId}/images`,
				body,
				key,
				params: { taskId }
			})
		),
	getImageFile: (imageId: string, file: string) =>
		getImageFileHandler(
			event({ path: `/api/images/${imageId}/${file}`, params: { imageId, file } })
		),
	putNode: (taskId: string, path: string, body: unknown, key?: string) =>
		putNodeHandler(
			event({
				method: 'PUT',
				path: `/api/tasks/${taskId}/nodes/${path}`,
				body,
				key,
				params: { taskId, path }
			})
		)
};

async function newProject(body: Body = {}): Promise<Proj> {
	const res = await api.createProject(body);
	expect(res.status).toBe(201);
	return (await res.json()) as Proj;
}

async function snapshot(id: string): Promise<Body> {
	const res = await api.getProject(id);
	expect(res.status).toBe(200);
	return res.json();
}

async function newTask(p: Proj, body: Body = { title: 'Chunk 2' }): Promise<NewTask> {
	const res = await api.createTask(p.id, body, p.writeKey);
	expect(res.status).toBe(201);
	return (await res.json()) as NewTask;
}

async function taskDetail(taskId: string): Promise<{ task: Body; nodes: Body[]; notices: Body[] }> {
	const res = await api.getTask(taskId);
	expect(res.status).toBe(200);
	return res.json();
}

async function events(taskId: string, path?: string): Promise<Body[]> {
	const res = await api.getEvents(taskId, path);
	expect(res.status).toBe(200);
	return (await res.json()).events;
}

beforeEach(async () => {
	await resetDb();
});

describe('GET /api/health', () => {
	it('reports the chronicle service with db ok', async () => {
		const res = await getHealth(event({ path: '/api/health' }));
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.service).toBe('chronicle');
		expect(typeof body.version).toBe('string');
		expect(body.db).toBe('ok');
	});
});

describe('GET /api/presets', () => {
	it('lists build-it with its config', async () => {
		const res = await api.presets();
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(Array.isArray(body.presets)).toBe(true);
		const found = body.presets.find((p: Body) => p.name === 'build-it');
		expect(found).toBeDefined();
		expect(found.config).toEqual(BUILD_IT);
	});
});

describe('POST /api/projects', () => {
	it('creates a project with a uuid v4 id, a write key, a url, and the build-it config by default', async () => {
		const res = await api.createProject({});
		expect(res.status).toBe(201);
		const body = await res.json();
		expect(Object.keys(body).sort()).toEqual(['config', 'id', 'name', 'url', 'writeKey']);
		expect(body.id).toMatch(UUID_V4);
		expect(typeof body.writeKey).toBe('string');
		expect(body.writeKey.length).toBeGreaterThan(0);
		expect(body.url).toBe(`http://localhost/p/${body.id}`);
		expect(body.config).toEqual(BUILD_IT);
	});

	it('issues a different id and write key for each project', async () => {
		const a = await newProject();
		const b = await newProject();
		expect(a.id).not.toBe(b.id);
		expect(a.writeKey).not.toBe(b.writeKey);
	});

	it('names the project with a three-word moniker when no name is given', async () => {
		const p = await newProject();
		const snap = await snapshot(p.id);
		expect(snap.project.name).toMatch(/^[A-Z][a-z]+ [A-Z][a-z]+ [A-Z][a-z]+$/);
		expect(snap.project.name).toBe((p as Proj & { name: string }).name);
	});

	it('stores notes and links given at creation', async () => {
		const links = [{ url: 'https://trello.com/b/abc', label: 'Board' }];
		const p = await newProject({ name: 'Demo', notes: 'Q4 billing work', links });
		const snap = await snapshot(p.id);
		expect(snap.project.notes).toBe('Q4 billing work');
		expect(snap.project.links).toEqual(links);
	});

	it('uses the name it is given', async () => {
		const p = await newProject({ name: 'Demo' });
		const snap = await snapshot(p.id);
		expect(snap.project.name).toBe('Demo');
	});

	it('builds the url from the request origin', async () => {
		const res = await api.createProject({}, 'https://ws.example.com');
		expect(res.status).toBe(201);
		const body = await res.json();
		expect(body.url).toBe(`https://ws.example.com/p/${body.id}`);
	});

	it('uses the named preset', async () => {
		const res = await api.createProject({ preset: 'build-it' });
		expect(res.status).toBe(201);
		expect((await res.json()).config).toEqual(BUILD_IT);
	});

	it('rejects an unknown preset with 400', async () => {
		const res = await api.createProject({ preset: 'nope' });
		expect(res.status).toBe(400);
		const body = await res.json();
		expect(typeof body.error).toBe('string');
	});

	it('uses a custom config in place of the preset', async () => {
		const res = await api.createProject({ preset: 'build-it', config: CUSTOM_CONFIG });
		expect(res.status).toBe(201);
		const body = await res.json();
		expect(body.config).toEqual(CUSTOM_CONFIG);
		const snap = await snapshot(body.id);
		expect(snap.project.config).toEqual(CUSTOM_CONFIG);
	});

	it('rejects an invalid custom config with 400', async () => {
		const res = await api.createProject({ config: { ...CUSTOM_CONFIG, initialState: 'ghost' } });
		expect(res.status).toBe(400);
		expect(typeof (await res.json()).error).toBe('string');
	});

	it('rejects a custom config with a color containing a semicolon with 400', async () => {
		const states = [
			{ ...CUSTOM_CONFIG.states[0], color: 'red;' },
			...CUSTOM_CONFIG.states.slice(1)
		];
		const res = await api.createProject({ config: { ...CUSTOM_CONFIG, states } });
		expect(res.status).toBe(400);
		expect(typeof (await res.json()).error).toBe('string');
	});

	it('rejects a malformed JSON body with 400', async () => {
		const res = await api.rawCreateProject('{nope');
		expect(res.status).toBe(400);
		expect(typeof (await res.json()).error).toBe('string');
	});
});

describe('GET /api/projects/:id', () => {
	it('returns an empty snapshot for a fresh project and omits the write key', async () => {
		const p = await newProject();
		const res = await api.getProject(p.id);
		expect(res.status).toBe(200);
		const snap = await res.json();
		expect(snap.project.id).toBe(p.id);
		expect(typeof snap.project.name).toBe('string');
		expect(snap.project.notes).toBe('');
		expect(snap.project.links).toEqual([]);
		expect(snap.project.config).toEqual(BUILD_IT);
		expect(snap.project.createdAt).toMatch(ISO);
		expect(snap.project.lastWriteAt).toMatch(ISO);
		expect(snap.tasks).toEqual([]);
		expect(snap.nodes).toEqual([]);
		expect(snap.lastSeq).toBe(0);
		expect(JSON.stringify(snap)).not.toContain(p.writeKey);
	});

	it('returns 404 project not found for an unknown project', async () => {
		const res = await api.getProject(crypto.randomUUID());
		expect(res.status).toBe(404);
		expect(await res.json()).toEqual({ error: 'project not found' });
	});

	it('returns 400 for a malformed project id', async () => {
		const res = await api.getProject('not-a-uuid');
		expect(res.status).toBe(400);
		expect(typeof (await res.json()).error).toBe('string');
	});
});

describe('GET /api/projects/:id task order', () => {
	it('lists tasks newest first by createdAt', async () => {
		const p = await newProject();
		const first = await newTask(p, { title: 'First' });
		await tick();
		const second = await newTask(p, { title: 'Second' });

		const snap = await snapshot(p.id);
		expect(snap.tasks.map((t: Body) => t.id)).toEqual([second.taskId, first.taskId]);
	}, 15000);
});

describe('write auth', () => {
	let a: Proj;
	let b: Proj;
	let taskA: NewTask;

	beforeEach(async () => {
		a = await newProject();
		b = await newProject();
		taskA = await newTask(a, { title: 'Owned by A' });
	});

	function write(name: string, key?: string): Promise<Response> {
		switch (name) {
			case 'PUT config':
				return api.putConfig(a.id, CUSTOM_CONFIG, key);
			case 'PATCH config':
				return api.patchConfig(a.id, { theme: 'light' }, key);
			case 'POST tasks':
				return api.createTask(a.id, { title: 'New' }, key);
			case 'PATCH task':
				return api.patchTask(taskA.taskId, { title: 'Renamed' }, key);
			case 'PUT node':
				return api.putNode(taskA.taskId, 'chunk-2', {}, key);
		}
		throw new Error(`unknown write ${name}`);
	}

	const ROUTES = ['PUT config', 'PATCH config', 'POST tasks', 'PATCH task', 'PUT node'];

	it.each(ROUTES)('%s without a bearer token returns 401 missing write key', async (name) => {
		const res = await write(name);
		expect(res.status).toBe(401);
		expect(await res.json()).toEqual({ error: 'missing write key' });
	});

	it.each(ROUTES)(
		'%s with another project write key returns 403 invalid write key',
		async (name) => {
			const res = await write(name, b.writeKey);
			expect(res.status).toBe(403);
			expect(await res.json()).toEqual({ error: 'invalid write key' });
		}
	);

	it.each(ROUTES)('%s with a made-up bearer token returns 403 invalid write key', async (name) => {
		const res = await write(name, 'not-a-real-key');
		expect(res.status).toBe(403);
		expect(await res.json()).toEqual({ error: 'invalid write key' });
	});

	it('leaves config, tasks, nodes, and events untouched after rejected writes', async () => {
		expect((await write('PUT config')).status).toBe(401);
		expect((await write('PATCH task', b.writeKey)).status).toBe(403);
		expect((await write('PUT node', b.writeKey)).status).toBe(403);
		expect((await write('POST tasks', b.writeKey)).status).toBe(403);

		const snap = await snapshot(a.id);
		expect(snap.project.config).toEqual(BUILD_IT);
		expect(snap.tasks.map((t: Body) => t.id)).toEqual([taskA.taskId]);
		expect(snap.tasks[0].title).toBe('Owned by A');
		expect(snap.tasks[0].state).toBe('queued');
		expect(snap.nodes).toEqual([]);
		expect(await events(taskA.taskId)).toHaveLength(1);
	});
});

describe('POST /api/projects/:id/tasks', () => {
	it('creates a task with defaults and a task url', async () => {
		const p = await newProject();
		const res = await api.createTask(p.id, { title: 'Build it' }, p.writeKey);
		expect(res.status).toBe(201);
		const body = await res.json();
		expect(body.taskId).toMatch(UUID_V4);
		expect(body.url).toBe(`http://localhost/p/${p.id}/t/${body.taskId}`);
		expect(body.task.id).toBe(body.taskId);
		expect(body.task.projectId).toBe(p.id);
		expect(body.task.title).toBe('Build it');
		expect(body.task.summary).toBe('');
		expect(body.task.note).toBe('');
		expect(body.task.state).toBe('queued');
		expect(body.task.finishedAt).toBeNull();
		expect(body.task.stateSince).toMatch(ISO);
		expect(body.task.createdAt).toMatch(ISO);
		expect(body.task.updatedAt).toMatch(ISO);
		expect(body.nodes).toEqual([]);
	});

	it('uses an explicit state, summary, and note', async () => {
		const p = await newProject();
		const res = await api.createTask(
			p.id,
			{ title: 'Started', summary: 'Sum', state: 'in_work', note: 'started' },
			p.writeKey
		);
		expect(res.status).toBe(201);
		const { task } = await res.json();
		expect(task.state).toBe('in_work');
		expect(task.summary).toBe('Sum');
		expect(task.note).toBe('started');
		expect(task.finishedAt).toBeNull();
	});

	it('creates steps as depth-1 nodes in array order with positions 0, 1, 2', async () => {
		const p = await newProject();
		const t = await newTask(p, {
			title: 'Steps',
			steps: [
				{ key: 'chunk-1', title: 'First' },
				{ key: 'chunk-2' },
				{ key: 'chunk-3', state: 'planning', note: 'n', tags: [{ text: 'x', color: '#f00' }] }
			]
		});
		expect(t.nodes).toHaveLength(3);

		const { nodes } = await taskDetail(t.taskId);
		const steps = nodes.filter((n) => n.depth === 1);
		expect(steps.map((n) => n.path)).toEqual(['chunk-1', 'chunk-2', 'chunk-3']);
		expect(steps.map((n) => n.position)).toEqual([0, 1, 2]);
		expect(steps.map((n) => n.key)).toEqual(['chunk-1', 'chunk-2', 'chunk-3']);
		expect(steps.map((n) => n.parentPath)).toEqual([null, null, null]);
		expect(steps.map((n) => n.taskId)).toEqual([t.taskId, t.taskId, t.taskId]);
		expect(steps.map((n) => n.title)).toEqual(['First', 'chunk-2', 'chunk-3']);
		expect(steps.map((n) => n.state)).toEqual(['queued', 'queued', 'planning']);
		expect(steps[2].note).toBe('n');
		expect(steps[2].tags).toEqual([{ text: 'x', color: '#f00' }]);
	});

	it('returns 400 with validStates listing all preset states for an unknown state', async () => {
		const p = await newProject();
		const res = await api.createTask(p.id, { title: 'Bad', state: 'nope' }, p.writeKey);
		expect(res.status).toBe(400);
		const body = await res.json();
		expect(typeof body.error).toBe('string');
		expect([...body.validStates].sort()).toEqual([...BUILD_IT_KEYS].sort());
		expect((await snapshot(p.id)).tasks).toEqual([]);
	});

	it('rejects a step with an unknown state and creates no task', async () => {
		const p = await newProject();
		const res = await api.createTask(
			p.id,
			{ title: 'Bad step', steps: [{ key: 'one', state: 'nope' }] },
			p.writeKey
		);
		expect(res.status).toBe(400);
		const snap = await snapshot(p.id);
		expect(snap.tasks).toEqual([]);
		expect(snap.nodes).toEqual([]);
	});

	it.each([['a step key outside the segment set', 'bad key!']])(
		'rejects a step with %s and creates no task',
		async (_name, key) => {
			const p = await newProject();
			const res = await api.createTask(p.id, { title: 'Bad key', steps: [{ key }] }, p.writeKey);
			expect(res.status).toBe(400);
			expect((await snapshot(p.id)).tasks).toEqual([]);
		}
	);

	it('rejects a body without a title with 400', async () => {
		const p = await newProject();
		const res = await api.createTask(p.id, { summary: 'no title' }, p.writeKey);
		expect(res.status).toBe(400);
		expect(typeof (await res.json()).error).toBe('string');
		expect((await snapshot(p.id)).tasks).toEqual([]);
	});
});

describe('GET /api/tasks/:taskId', () => {
	it('returns the task and its nodes', async () => {
		const p = await newProject();
		const t = await newTask(p, { title: 'Read me', steps: [{ key: 'one' }, { key: 'two' }] });
		const res = await api.getTask(t.taskId);
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.task.id).toBe(t.taskId);
		expect(body.task.title).toBe('Read me');
		expect(body.nodes.map((n: Body) => n.path).sort()).toEqual(['one', 'two']);
	});

	it('returns 404 task not found for an unknown task', async () => {
		const res = await api.getTask(crypto.randomUUID());
		expect(res.status).toBe(404);
		expect(await res.json()).toEqual({ error: 'task not found' });
	});

	it('returns 400 for a malformed task id', async () => {
		const res = await api.getTask('abc');
		expect(res.status).toBe(400);
		expect(typeof (await res.json()).error).toBe('string');
	});
});

describe('PATCH /api/tasks/:taskId', () => {
	it('moves stateSince and resets an omitted note when the state changes', async () => {
		const p = await newProject();
		const t = await newTask(p, { title: 'T', note: 'waiting' });
		const before = t.task.stateSince;
		await tick();

		const res = await api.patchTask(t.taskId, { state: 'planning' }, p.writeKey);
		expect(res.status).toBe(200);
		const { task } = await res.json();
		expect(task.state).toBe('planning');
		expect(task.note).toBe('');
		expect(task.stateSince).toMatch(ISO);
		expect(Date.parse(task.stateSince)).toBeGreaterThan(Date.parse(before));
	}, 15000);

	it('keeps an explicit note when the state changes', async () => {
		const p = await newProject();
		const t = await newTask(p, { title: 'T', note: 'waiting' });
		const res = await api.patchTask(t.taskId, { state: 'testing', note: 'running' }, p.writeKey);
		expect(res.status).toBe(200);
		const { task } = await res.json();
		expect(task.state).toBe('testing');
		expect(task.note).toBe('running');
	});

	it('keeps stateSince and an omitted note when the state is written unchanged', async () => {
		const p = await newProject();
		const t = await newTask(p, { title: 'T', note: 'waiting' });
		const before = t.task.stateSince;
		await tick();

		const res = await api.patchTask(t.taskId, { state: 'queued' }, p.writeKey);
		expect(res.status).toBe(200);
		const { task } = await res.json();
		expect(task.state).toBe('queued');
		expect(task.stateSince).toBe(before);
		expect(task.note).toBe('waiting');
	}, 15000);

	it('clears the note when given an empty string, without a state change', async () => {
		const p = await newProject();
		const t = await newTask(p, { title: 'T', note: 'waiting' });
		const res = await api.patchTask(t.taskId, { note: '' }, p.writeKey);
		expect(res.status).toBe(200);
		const { task } = await res.json();
		expect(task.note).toBe('');
		expect(task.state).toBe('queued');
	});

	it('sets finishedAt on done and failed and clears it on a return to an active state', async () => {
		const p = await newProject();
		const t = await newTask(p, { title: 'T' });
		expect(t.task.finishedAt).toBeNull();

		const done = await api.patchTask(t.taskId, { state: 'done' }, p.writeKey);
		const doneTask = (await done.json()).task;
		expect(doneTask.finishedAt).toMatch(ISO);

		const failed = await api.patchTask(t.taskId, { state: 'failed' }, p.writeKey);
		const failedTask = (await failed.json()).task;
		expect(failedTask.state).toBe('failed');
		expect(failedTask.finishedAt).toMatch(ISO);

		const back = await api.patchTask(t.taskId, { state: 'in_work' }, p.writeKey);
		const backTask = (await back.json()).task;
		expect(backTask.state).toBe('in_work');
		expect(backTask.finishedAt).toBeNull();
	});

	it('clears finishedAt when the state moves to blocked', async () => {
		const p = await newProject();
		const t = await newTask(p, { title: 'T', state: 'done' });
		expect(t.task.finishedAt).toMatch(ISO);
		const res = await api.patchTask(t.taskId, { state: 'needs_input' }, p.writeKey);
		expect((await res.json()).task.finishedAt).toBeNull();
	});

	it('changes title and summary without touching state, stateSince, or note', async () => {
		const p = await newProject();
		const t = await newTask(p, { title: 'Old', note: 'keep me' });
		const res = await api.patchTask(t.taskId, { title: 'Renamed', summary: 'S' }, p.writeKey);
		expect(res.status).toBe(200);
		const { task } = await res.json();
		expect(task.title).toBe('Renamed');
		expect(task.summary).toBe('S');
		expect(task.state).toBe('queued');
		expect(task.stateSince).toBe(t.task.stateSince);
		expect(task.note).toBe('keep me');
	});

	it('rejects an unknown state with 400 and validStates, leaving the task unchanged', async () => {
		const p = await newProject();
		const t = await newTask(p, { title: 'T' });
		const res = await api.patchTask(t.taskId, { state: 'nope' }, p.writeKey);
		expect(res.status).toBe(400);
		const body = await res.json();
		expect(typeof body.error).toBe('string');
		expect([...body.validStates].sort()).toEqual([...BUILD_IT_KEYS].sort());
		expect((await taskDetail(t.taskId)).task.state).toBe('queued');
	});

	it('returns 404 task not found for an unknown task', async () => {
		const p = await newProject();
		const res = await api.patchTask(crypto.randomUUID(), { title: 'x' }, p.writeKey);
		expect(res.status).toBe(404);
		expect(await res.json()).toEqual({ error: 'task not found' });
	});
});

describe('PUT /api/tasks/:taskId/nodes/<path>', () => {
	let p: Proj;
	let t: NewTask;

	beforeEach(async () => {
		p = await newProject();
		t = await newTask(p, { title: 'Node host' });
	});

	it('creates a missing node with title defaulting to its key', async () => {
		const res = await api.putNode(t.taskId, 'chunk-2', {}, p.writeKey);
		expect(res.status).toBe(200);
		const { node } = await res.json();
		expect(node.taskId).toBe(t.taskId);
		expect(node.path).toBe('chunk-2');
		expect(node.key).toBe('chunk-2');
		expect(node.parentPath).toBeNull();
		expect(node.depth).toBe(1);
		expect(node.title).toBe('chunk-2');
		expect(node.state).toBe('queued');
		expect(node.note).toBe('');
		expect(node.tags).toEqual([]);
		expect(node.position).toBe(0);
		expect(node.createdAt).toMatch(ISO);
		expect(node.updatedAt).toMatch(ISO);
		expect(node.stateSince).toMatch(ISO);
	});

	it('moves a pending task to the first active state when a node goes active', async () => {
		await api.putNode(t.taskId, 'a', { state: 'queued' }, p.writeKey);
		expect((await (await api.getTask(t.taskId)).json()).task.state).toBe('queued');
		await api.putNode(t.taskId, 'a', { state: 'in_work' }, p.writeKey);
		expect((await (await api.getTask(t.taskId)).json()).task.state).toBe('planning');
	});

	it('keeps the task note and does not restart a task moved back to pending', async () => {
		await api.patchTask(t.taskId, { note: 'waiting on design' }, p.writeKey);
		await api.putNode(t.taskId, 'a', { state: 'in_work' }, p.writeKey);
		const { task } = await (await api.getTask(t.taskId)).json();
		expect(task.state).toBe('planning');
		expect(task.note).toBe('waiting on design');

		await api.patchTask(t.taskId, { state: 'queued' }, p.writeKey);
		await api.putNode(t.taskId, 'a', { note: 'still going' }, p.writeKey);
		expect((await (await api.getTask(t.taskId)).json()).task.state).toBe('queued');
	});

	it('creates a node with the given title, state, note, and tags', async () => {
		const res = await api.putNode(
			t.taskId,
			'chunk-3',
			{ title: 'Third', state: 'testing', note: 'n', tags: [{ text: 'risky', color: '#ef4444' }] },
			p.writeKey
		);
		expect(res.status).toBe(200);
		const { node } = await res.json();
		expect(node.title).toBe('Third');
		expect(node.state).toBe('testing');
		expect(node.note).toBe('n');
		expect(node.tags).toEqual([{ text: 'risky', color: '#ef4444' }]);
	});

	it('keeps the fields an update does not mention', async () => {
		await api.putNode(
			t.taskId,
			'chunk-3',
			{ title: 'Third', state: 'testing', note: 'n', tags: [{ text: 'risky' }] },
			p.writeKey
		);
		const before = (await taskDetail(t.taskId)).nodes.find((n) => n.path === 'chunk-3');

		const res = await api.putNode(t.taskId, 'chunk-3', { title: 'Renamed' }, p.writeKey);
		expect(res.status).toBe(200);
		const { node } = await res.json();
		expect(node.title).toBe('Renamed');
		expect(node.state).toBe('testing');
		expect(node.note).toBe('n');
		expect(node.tags).toEqual([{ text: 'risky' }]);
		expect(node.position).toBe(before.position);
		expect(node.stateSince).toBe(before.stateSince);
	});

	it('resets an omitted note when the node state changes', async () => {
		await api.putNode(t.taskId, 'chunk-3', { state: 'testing', note: 'n' }, p.writeKey);
		const res = await api.putNode(t.taskId, 'chunk-3', { state: 'done' }, p.writeKey);
		const { node } = await res.json();
		expect(node.state).toBe('done');
		expect(node.note).toBe('');
	});

	it('moves stateSince when the node state changes and keeps it on a title-only update', async () => {
		await api.putNode(t.taskId, 'chunk-3', { state: 'queued' }, p.writeKey);
		const before = (await taskDetail(t.taskId)).nodes.find((n) => n.path === 'chunk-3').stateSince;
		await tick();

		const titleOnly = await api.putNode(t.taskId, 'chunk-3', { title: 'Still queued' }, p.writeKey);
		expect((await titleOnly.json()).node.stateSince).toBe(before);

		const changed = await api.putNode(t.taskId, 'chunk-3', { state: 'planning' }, p.writeKey);
		const { node } = await changed.json();
		expect(node.state).toBe('planning');
		expect(Date.parse(node.stateSince)).toBeGreaterThan(Date.parse(before));
	}, 15000);

	it('replaces tags only when tags are given', async () => {
		await api.putNode(
			t.taskId,
			'n',
			{ tags: [{ text: 'a' }, { text: 'b', color: '#abc' }] },
			p.writeKey
		);

		const noTags = await api.putNode(t.taskId, 'n', { note: 'x' }, p.writeKey);
		expect((await noTags.json()).node.tags).toEqual([{ text: 'a' }, { text: 'b', color: '#abc' }]);

		const replaced = await api.putNode(t.taskId, 'n', { tags: [{ text: 'c' }] }, p.writeKey);
		expect((await replaced.json()).node.tags).toEqual([{ text: 'c' }]);

		const cleared = await api.putNode(t.taskId, 'n', { tags: [] }, p.writeKey);
		expect((await cleared.json()).node.tags).toEqual([]);
	});

	it('appends an omitted position after the siblings, scoped per parent', async () => {
		const pos = async (path: string, body: Body = {}) => {
			const res = await api.putNode(t.taskId, path, body, p.writeKey);
			expect(res.status).toBe(200);
			return (await res.json()).node.position;
		};

		expect(await pos('a')).toBe(0);
		expect(await pos('b')).toBe(1);
		expect(await pos('c')).toBe(2);
		expect(await pos('b/x')).toBe(0);
		expect(await pos('b/y')).toBe(1);
		expect(await pos('d', { position: 10 })).toBe(10);
		expect(await pos('e')).toBe(11);
		expect(await pos('b', { title: 'B' })).toBe(1);
	});

	it('uses an explicit position over the append order, and an update with position sets it', async () => {
		const res = await api.putNode(t.taskId, 'z', { position: 7 }, p.writeKey);
		expect((await res.json()).node.position).toBe(7);

		const moved = await api.putNode(t.taskId, 'z', { position: 0 }, p.writeKey);
		expect((await moved.json()).node.position).toBe(0);

		const next = await api.putNode(t.taskId, 'y', {}, p.writeKey);
		expect((await next.json()).node.position).toBe(1);
	});

	it('creates missing ancestors for a deep path with depth, parentPath, title, and state', async () => {
		const res = await api.putNode(t.taskId, 'a/b/c', { title: 'Leaf' }, p.writeKey);
		expect(res.status).toBe(200);
		const { node } = await res.json();
		expect(node.path).toBe('a/b/c');
		expect(node.key).toBe('c');
		expect(node.parentPath).toBe('a/b');
		expect(node.depth).toBe(3);
		expect(node.title).toBe('Leaf');

		const { nodes } = await taskDetail(t.taskId);
		expect(nodes).toHaveLength(3);
		const a = nodes.find((n) => n.path === 'a');
		const ab = nodes.find((n) => n.path === 'a/b');
		expect(a).toMatchObject({
			key: 'a',
			depth: 1,
			parentPath: null,
			title: 'a',
			state: 'queued',
			note: ''
		});
		expect(ab).toMatchObject({ key: 'b', depth: 2, parentPath: 'a', title: 'b', state: 'queued' });
	});

	it('does not recreate an existing ancestor', async () => {
		await api.putNode(t.taskId, 'a', { title: 'Root', state: 'planning' }, p.writeKey);
		const res = await api.putNode(t.taskId, 'a/b/c', {}, p.writeKey);
		expect(res.status).toBe(200);

		const { nodes } = await taskDetail(t.taskId);
		const a = nodes.find((n) => n.path === 'a');
		expect(a.title).toBe('Root');
		expect(a.state).toBe('planning');
		expect(nodes.filter((n) => n.path === 'a')).toHaveLength(1);
	});

	it('writes one event per created ancestor, ancestors first, then the leaf', async () => {
		await api.putNode(t.taskId, 'a/b/c', {}, p.writeKey);
		const evs = (await events(t.taskId)).filter((e) => e.type === 'node');
		expect(evs.map((e) => e.path)).toEqual(['a', 'a/b', 'a/b/c']);
		const seqs = evs.map((e) => e.seq);
		expect(seqs).toEqual([...seqs].sort((x, y) => x - y));
	});

	it.each(BAD_PATHS)(
		'rejects a path with %s with 400 and creates no nodes',
		async (_name, path) => {
			const res = await api.putNode(t.taskId, path, {}, p.writeKey);
			expect(res.status).toBe(400);
			expect(typeof (await res.json()).error).toBe('string');
			expect((await taskDetail(t.taskId)).nodes).toEqual([]);
		}
	);

	it('rejects an unknown node state with 400 and validStates, creating no node', async () => {
		const res = await api.putNode(t.taskId, 'n1', { state: 'nope' }, p.writeKey);
		expect(res.status).toBe(400);
		const body = await res.json();
		expect(typeof body.error).toBe('string');
		expect([...body.validStates].sort()).toEqual([...BUILD_IT_KEYS].sort());
		expect((await taskDetail(t.taskId)).nodes).toEqual([]);
	});

	it('returns 404 task not found for an unknown task', async () => {
		const res = await api.putNode(crypto.randomUUID(), 'chunk-2', {}, p.writeKey);
		expect(res.status).toBe(404);
		expect(await res.json()).toEqual({ error: 'task not found' });
	});

	it('returns nodes of a task in depth then position order in the project snapshot', async () => {
		await api.putNode(t.taskId, 'a', {}, p.writeKey);
		await api.putNode(t.taskId, 'b', {}, p.writeKey);
		await api.putNode(t.taskId, 'a/x', {}, p.writeKey);

		const snap = await snapshot(p.id);
		expect(snap.nodes.map((n: Body) => n.path)).toEqual(['a', 'b', 'a/x']);
	});
});

describe('GET /api/tasks/:taskId/events', () => {
	it('appends one event per changed row when a task is created with two steps', async () => {
		const p = await newProject();
		const t = await newTask(p, { title: 'Two steps', steps: [{ key: 'one' }, { key: 'two' }] });

		const evs = await events(t.taskId);
		expect(evs).toHaveLength(3);
		expect(evs.map((e) => e.type).sort()).toEqual(['node', 'node', 'task']);
		for (const e of evs) {
			expect(e.taskId).toBe(t.taskId);
			expect(e.at).toMatch(ISO);
			expect(typeof e.seq).toBe('number');
		}
		expect(new Set(evs.map((e) => e.seq)).size).toBe(3);
	});

	it('carries the full row in payload, with path set only on node events', async () => {
		const p = await newProject();
		const t = await newTask(p, { title: 'Payloads', steps: [{ key: 'one' }, { key: 'two' }] });

		const evs = await events(t.taskId);
		const taskEv = evs.find((e) => e.type === 'task');
		expect(taskEv.path).toBeNull();
		expect(taskEv.payload.id).toBe(t.taskId);
		expect(taskEv.payload.title).toBe('Payloads');

		const nodeEvs = evs.filter((e) => e.type === 'node');
		expect(nodeEvs.map((e) => e.path).sort()).toEqual(['one', 'two']);
		for (const e of nodeEvs) {
			expect(e.payload.path).toBe(e.path);
			expect(e.payload.taskId).toBe(t.taskId);
		}
	});

	it('returns events in ascending seq and appends a task event on a state change', async () => {
		const p = await newProject();
		const t = await newTask(p, { title: 'Ordered', steps: [{ key: 'one' }] });
		await api.patchTask(t.taskId, { state: 'planning' }, p.writeKey);

		const evs = await events(t.taskId);
		expect(evs).toHaveLength(3);
		const seqs = evs.map((e) => e.seq);
		expect(seqs).toEqual([...seqs].sort((x, y) => x - y));
		const last = evs[evs.length - 1];
		expect(last.type).toBe('task');
		expect(last.payload.state).toBe('planning');
	});

	it('filters to one node when path is given', async () => {
		const p = await newProject();
		const t = await newTask(p, { title: 'Filter' });
		await api.putNode(t.taskId, 'a', {}, p.writeKey);
		await api.putNode(t.taskId, 'a/x', {}, p.writeKey);

		const all = await events(t.taskId);
		expect(all.map((e) => e.path)).toEqual([null, 'a', 'a/x']);

		const onlyA = await events(t.taskId, 'a');
		expect(onlyA).toHaveLength(1);
		expect(onlyA[0].path).toBe('a');

		const onlyAX = await events(t.taskId, 'a/x');
		expect(onlyAX).toHaveLength(1);
		expect(onlyAX[0].path).toBe('a/x');

		expect(await events(t.taskId, 'nope')).toEqual([]);
	});

	it('returns 404 task not found for an unknown task', async () => {
		const res = await api.getEvents(crypto.randomUUID());
		expect(res.status).toBe(404);
		expect(await res.json()).toEqual({ error: 'task not found' });
	});

	it('appends no event for a rejected write', async () => {
		const p = await newProject();
		const t = await newTask(p, { title: 'Rejected', steps: [{ key: 'one' }] });
		const res = await api.patchTask(t.taskId, { state: 'nope' }, p.writeKey);
		expect(res.status).toBe(400);
		expect(await events(t.taskId)).toHaveLength(2);
	});

	it('reports in the project snapshot a lastSeq equal to the highest event seq', async () => {
		const p = await newProject();
		const t = await newTask(p, { title: 'Seq', steps: [{ key: 'one' }, { key: 'two' }] });
		await api.patchTask(t.taskId, { state: 'testing' }, p.writeKey);

		const evs = await events(t.taskId);
		expect(evs).toHaveLength(4);
		const snap = await snapshot(p.id);
		expect(snap.lastSeq).toBe(Math.max(...evs.map((e) => e.seq)));
	});
});

describe('in-process bus', () => {
	it('delivers each appended event to a subscriber in seq order, identical to the stored log', async () => {
		const p = await newProject();
		const received: Body[] = [];
		const unsubscribe = subscribe(p.id, (e) => {
			received.push(e as unknown as Body);
		});

		const t = await newTask(p, { title: 'Bus', steps: [{ key: 'one' }, { key: 'two' }] });
		await api.patchTask(t.taskId, { state: 'planning' }, p.writeKey);
		unsubscribe();

		const stored = await events(t.taskId);
		expect(stored).toHaveLength(4);
		expect(received).toEqual(stored);
		const seqs = received.map((e) => e.seq);
		expect(seqs).toEqual([...seqs].sort((x, y) => x - y));
	});

	it('stops delivering to a listener after unsubscribe', async () => {
		const p = await newProject();
		const t = await newTask(p, { title: 'Unsub' });
		const received: unknown[] = [];
		const unsubscribe = subscribe(p.id, (e) => {
			received.push(e);
		});
		unsubscribe();

		const res = await api.patchTask(t.taskId, { title: 'After unsubscribe' }, p.writeKey);
		expect(res.status).toBe(200);
		expect(received).toEqual([]);
	});

	it('delivers only events of the written project', async () => {
		const pa = await newProject();
		const pb = await newProject();
		const tA = await newTask(pa, { title: 'In A' });

		const onA: unknown[] = [];
		const onB: unknown[] = [];
		const unsubA = subscribe(pa.id, (e) => {
			onA.push(e);
		});
		const unsubB = subscribe(pb.id, (e) => {
			onB.push(e);
		});

		await api.patchTask(tA.taskId, { title: 'Still A' }, pa.writeKey);
		unsubA();
		unsubB();

		expect(onA).toHaveLength(1);
		expect(onB).toEqual([]);
	});

	it('publishes nothing for a rejected write', async () => {
		const p = await newProject();
		const t = await newTask(p, { title: 'Nothing' });
		const received: unknown[] = [];
		const unsubscribe = subscribe(p.id, (e) => {
			received.push(e);
		});

		const res = await api.patchTask(t.taskId, { state: 'nope' }, p.writeKey);
		unsubscribe();

		expect(res.status).toBe(400);
		expect(received).toEqual([]);
	});
});

describe('PUT and PATCH /api/projects/:id/config', () => {
	it('PUT replaces the whole config', async () => {
		const p = await newProject();
		const res = await api.putConfig(p.id, CUSTOM_CONFIG, p.writeKey);
		expect(res.status).toBe(200);
		expect((await res.json()).config).toEqual(CUSTOM_CONFIG);

		const snap = await snapshot(p.id);
		expect(snap.project.config).toEqual(CUSTOM_CONFIG);
		expect(snap.project.config.states.map((s: Body) => s.key)).not.toContain('queued');
	});

	it('PUT rejects an invalid config with 400 and keeps the old one', async () => {
		const p = await newProject();
		const { theme: _omitted, ...noTheme } = CUSTOM_CONFIG;
		const res = await api.putConfig(p.id, noTheme, p.writeKey);
		expect(res.status).toBe(400);
		expect(typeof (await res.json()).error).toBe('string');
		expect((await snapshot(p.id)).project.config).toEqual(BUILD_IT);
	});

	it('PUT rejects an initialState that is not a state key with 400', async () => {
		const p = await newProject();
		const res = await api.putConfig(p.id, { ...CUSTOM_CONFIG, initialState: 'ghost' }, p.writeKey);
		expect(res.status).toBe(400);
		expect((await snapshot(p.id)).project.config).toEqual(BUILD_IT);
	});

	it('PATCH merges fields into an existing state by key and keeps its position', async () => {
		const p = await newProject({ config: CUSTOM_CONFIG });
		const res = await api.patchConfig(
			p.id,
			{ states: [{ key: 'doing', label: 'Working' }] },
			p.writeKey
		);
		expect(res.status).toBe(200);
		const { config } = await res.json();
		expect(config.states.map((s: Body) => s.key)).toEqual(['todo', 'doing', 'shipped']);
		expect(config.states[1]).toEqual({
			key: 'doing',
			label: 'Working',
			color: 'rgb(10, 20, 30)',
			kind: 'active',
			icon: 'D',
			animation: 'pulse'
		});
		expect(config.theme).toBe('dark');
		expect(config.initialState).toBe('todo');
	});

	it('PATCH sets theme and initialState and leaves states alone', async () => {
		const p = await newProject({ config: CUSTOM_CONFIG });
		const res = await api.patchConfig(p.id, { theme: 'light', initialState: 'doing' }, p.writeKey);
		expect(res.status).toBe(200);
		const { config } = await res.json();
		expect(config.theme).toBe('light');
		expect(config.initialState).toBe('doing');
		expect(config.states).toEqual(CUSTOM_CONFIG.states);
	});

	it('PATCH appends a full new state', async () => {
		const p = await newProject({ config: CUSTOM_CONFIG });
		const res = await api.patchConfig(
			p.id,
			{
				states: [
					{ key: 'review', label: 'Review', color: '#0ea5e9', kind: 'active', animation: 'none' }
				]
			},
			p.writeKey
		);
		expect(res.status).toBe(200);
		const { config } = await res.json();
		expect(config.states.map((s: Body) => s.key)).toEqual(['todo', 'doing', 'shipped', 'review']);
	});

	it('PATCH rejects a partial new state with 400 and keeps the config', async () => {
		const p = await newProject({ config: CUSTOM_CONFIG });
		const res = await api.patchConfig(
			p.id,
			{ states: [{ key: 'review', label: 'Review' }] },
			p.writeKey
		);
		expect(res.status).toBe(400);
		expect((await snapshot(p.id)).project.config).toEqual(CUSTOM_CONFIG);
	});

	it('PATCH rejects an initialState that is not in the resulting states with 400', async () => {
		const p = await newProject({ config: CUSTOM_CONFIG });
		const res = await api.patchConfig(p.id, { initialState: 'ghost' }, p.writeKey);
		expect(res.status).toBe(400);
		expect((await snapshot(p.id)).project.config).toEqual(CUSTOM_CONFIG);
	});

	it('PATCH rejects an unknown theme with 400', async () => {
		const p = await newProject({ config: CUSTOM_CONFIG });
		const res = await api.patchConfig(p.id, { theme: 'neon' }, p.writeKey);
		expect(res.status).toBe(400);
		expect((await snapshot(p.id)).project.config).toEqual(CUSTOM_CONFIG);
	});

	it('emits a config event carrying the replaced config', async () => {
		const p = await newProject();
		const received: Body[] = [];
		const unsubscribe = subscribe(p.id, (e) => {
			received.push(e as unknown as Body);
		});
		const res = await api.putConfig(p.id, CUSTOM_CONFIG, p.writeKey);
		unsubscribe();

		expect(res.status).toBe(200);
		expect(received).toHaveLength(1);
		expect(received[0].type).toBe('config');
		expect(received[0].taskId).toBeNull();
		expect(received[0].path).toBeNull();
		expect(received[0].payload.config).toEqual(CUSTOM_CONFIG);
	});

	it('emits a config event carrying the merged config on PATCH', async () => {
		const p = await newProject({ config: CUSTOM_CONFIG });
		const received: Body[] = [];
		const unsubscribe = subscribe(p.id, (e) => {
			received.push(e as unknown as Body);
		});
		const res = await api.patchConfig(p.id, { theme: 'light' }, p.writeKey);
		unsubscribe();

		expect(res.status).toBe(200);
		expect(received).toHaveLength(1);
		expect(received[0].type).toBe('config');
		expect(received[0].payload.config).toEqual({ ...CUSTOM_CONFIG, theme: 'light' });
	});

	describe('lastWriteAt moves on every write', () => {
		const writes: [string, (p: Proj, taskId: string) => Promise<Response>][] = [
			['PUT config', (p) => api.putConfig(p.id, CUSTOM_CONFIG, p.writeKey)],
			['PATCH config', (p) => api.patchConfig(p.id, { theme: 'light' }, p.writeKey)],
			['POST task', (p) => api.createTask(p.id, { title: 'Second' }, p.writeKey)],
			['PATCH task', (p, taskId) => api.patchTask(taskId, { title: 'Renamed' }, p.writeKey)],
			['PUT node', (p, taskId) => api.putNode(taskId, 'chunk-2', {}, p.writeKey)]
		];

		it.each(writes)(
			'%s moves lastWriteAt forward',
			async (_name, run) => {
				const p = await newProject();
				const t = await newTask(p, { title: 'Clock' });
				const before = (await snapshot(p.id)).project.lastWriteAt;
				await tick();

				const res = await run(p, t.taskId);
				expect(res.status).toBeGreaterThanOrEqual(200);
				expect(res.status).toBeLessThan(300);

				const after = (await snapshot(p.id)).project.lastWriteAt;
				expect(Date.parse(after)).toBeGreaterThan(Date.parse(before));
			},
			15000
		);
	});
});

describe('PATCH /api/projects/:id', () => {
	it('renames the project and sets notes and links, publishing a project event', async () => {
		const p = await newProject({ name: 'Old' });
		const seen: Body[] = [];
		const unsubscribe = subscribe(p.id, (e) => seen.push(e));
		const links = [{ url: 'https://github.com/me/repo' }];
		const res = await api.patchProject(p.id, { name: 'New', notes: 'Why', links }, p.writeKey);
		unsubscribe();
		expect(res.status).toBe(200);
		const { project } = await res.json();
		expect(project).toMatchObject({ id: p.id, name: 'New', notes: 'Why', links });
		expect(seen.map((e) => e.type)).toEqual(['project']);
		expect(seen[0].payload).toMatchObject({ name: 'New', notes: 'Why', links });
	});

	it('keeps fields it is not given and emits nothing when nothing changes', async () => {
		const p = await newProject({ name: 'Keep', notes: 'n' });
		const seen: Body[] = [];
		const unsubscribe = subscribe(p.id, (e) => seen.push(e));
		const res = await api.patchProject(p.id, { name: 'Keep' }, p.writeKey);
		unsubscribe();
		expect((await res.json()).project).toMatchObject({ name: 'Keep', notes: 'n' });
		expect(seen).toEqual([]);
	});

	it('needs the write key', async () => {
		const p = await newProject();
		expect((await api.patchProject(p.id, { name: 'x' })).status).toBe(401);
		expect((await api.patchProject(p.id, { name: 'x' }, 'ws_wrong')).status).toBe(403);
	});

	it('rejects a link that is not an http(s) URL', async () => {
		const p = await newProject();
		const res = await api.patchProject(
			p.id,
			{ links: [{ url: 'javascript:alert(1)' }] },
			p.writeKey
		);
		expect(res.status).toBe(400);
		expect((await res.json()).error).toBe('links[0].url must be an http(s) URL');
	});
});

describe('agent info, links and refs', () => {
	it('stores agent, links, repo and branch on a new task', async () => {
		const p = await newProject();
		const agent = { tool: 'claude-code', model: 'claude-opus-5-5', effort: 'high' };
		const links = [{ url: 'https://github.com/me/repo/issues/7', label: '#7' }];
		const { task } = await newTask(p, {
			title: 'T',
			agent,
			links,
			repo: 'me/repo',
			branch: 'feat/x'
		});
		expect(task).toMatchObject({ agent, links, repo: 'me/repo', branch: 'feat/x' });
	});

	it('defaults agent to null, links to empty and refs to null', async () => {
		const p = await newProject();
		const { task, nodes } = await newTask(p, { title: 'T', steps: [{ key: 'a' }] });
		expect(task).toMatchObject({ agent: null, links: [], repo: null, branch: null });
		expect(nodes[0]).toMatchObject({ agent: null, links: [] });
	});

	it('merges agent fields on later writes, so tokens can arrive at completion', async () => {
		const p = await newProject();
		const { taskId } = await newTask(p, { title: 'T', agent: { tool: 'codex', model: 'gpt' } });
		const res = await api.patchTask(
			taskId,
			{ state: 'done', agent: { tokens: 120_000 } },
			p.writeKey
		);
		expect((await res.json()).task.agent).toEqual({ tool: 'codex', model: 'gpt', tokens: 120_000 });

		await api.putNode(taskId, 'a', { agent: { model: 'haiku' } }, p.writeKey);
		const node = await api.putNode(taskId, 'a', { agent: { tokens: 5 } }, p.writeKey);
		expect((await node.json()).node.agent).toEqual({ model: 'haiku', tokens: 5 });
	});

	it('emits no event when an agent write changes nothing', async () => {
		const p = await newProject();
		const { taskId } = await newTask(p, { title: 'T' });
		await api.putNode(taskId, 'a', { agent: { model: 'm' } }, p.writeKey);
		const before = (await events(taskId, 'a')).length;
		await api.putNode(taskId, 'a', { agent: { model: 'm' } }, p.writeKey);
		expect(await events(taskId, 'a')).toHaveLength(before);
	});

	it('rejects negative or fractional tokens and over-long agent fields', async () => {
		const p = await newProject();
		const { taskId } = await newTask(p);
		for (const agent of [{ tokens: -1 }, { tokens: 1.5 }, { model: 'x'.repeat(65) }, 'opus']) {
			const res = await api.putNode(taskId, 'a', { agent }, p.writeKey);
			expect(res.status).toBe(400);
		}
	});

	it("replaces a node's links as a whole", async () => {
		const p = await newProject();
		const { taskId } = await newTask(p);
		await api.putNode(taskId, 'a', { links: [{ url: 'https://a.test' }] }, p.writeKey);
		const res = await api.putNode(taskId, 'a', { links: [{ url: 'https://b.test' }] }, p.writeKey);
		expect((await res.json()).node.links).toEqual([{ url: 'https://b.test' }]);
	});
});

describe('presubmitted subtasks', () => {
	it('creates nested subtasks from steps[].subtasks in order, under their step', async () => {
		const p = await newProject();
		const { nodes } = await newTask(p, {
			title: 'T',
			steps: [
				{
					key: 'a',
					subtasks: [
						{ key: 'x', title: 'X' },
						{ key: 'y', subtasks: [{ key: 'z' }] }
					]
				},
				{ key: 'b' }
			]
		});
		expect(nodes.map((n) => [n.path, n.parentPath, n.position, n.state])).toEqual([
			['a', null, 0, 'queued'],
			['a/x', 'a', 0, 'queued'],
			['a/y', 'a', 1, 'queued'],
			['a/y/z', 'a/y', 0, 'queued'],
			['b', null, 1, 'queued']
		]);
		expect(nodes[1].title).toBe('X');
	});

	it('rejects duplicate keys among siblings', async () => {
		const p = await newProject();
		const res = await api.createTask(
			p.id,
			{ title: 'T', steps: [{ key: 'a', subtasks: [{ key: 'x' }, { key: 'x' }] }] },
			p.writeKey
		);
		expect(res.status).toBe(400);
		expect((await res.json()).error).toBe('duplicate step key "x"');
	});
});

describe('pull requests on tasks', () => {
	it('stores prs given at creation and replaces them as a whole on patch', async () => {
		const p = await newProject();
		const pr = {
			url: 'https://github.com/me/repo/pull/42',
			number: 42,
			title: 'Add rate limiting',
			state: 'open',
			checks: 'pending',
			review: 'pending'
		};
		const { task, taskId } = await newTask(p, { title: 'T', prs: [pr] });
		expect(task.prs).toEqual([pr]);

		const merged = { ...pr, state: 'merged', checks: 'passing', review: 'approved' };
		const res = await api.patchTask(taskId, { state: 'done', prs: [merged] }, p.writeKey);
		expect((await res.json()).task).toMatchObject({ state: 'done', prs: [merged] });
	});

	it('defaults prs to an empty list', async () => {
		const p = await newProject();
		expect((await newTask(p)).task.prs).toEqual([]);
	});

	it('emits no event when the same prs are sent again', async () => {
		const p = await newProject();
		const prs = [{ url: 'https://gitlab.com/g/p/-/merge_requests/3', state: 'draft' }];
		const { taskId } = await newTask(p, { title: 'T', prs });
		const before = (await events(taskId)).length;
		await api.patchTask(taskId, { prs }, p.writeKey);
		expect(await events(taskId)).toHaveLength(before);
	});

	it.each([
		[{ url: 'ftp://x' }, 'prs[0].url must be an http(s) URL'],
		[
			{ url: 'https://x.test', state: 'approved' },
			'prs[0].state must be one of draft, open, merged, closed'
		],
		[{ url: 'https://x.test', number: 0 }, 'prs[0].number must be a positive integer'],
		[
			{ url: 'https://x.test', checks: 'red' },
			'prs[0].checks must be one of pending, passing, failing'
		]
	])('rejects %j', async (pr, error) => {
		const p = await newProject();
		const res = await api.createTask(p.id, { title: 'T', prs: [pr] }, p.writeKey);
		expect(res.status).toBe(400);
		expect((await res.json()).error).toBe(error);
	});
});

describe('POST /api/tasks/:taskId/notices', () => {
	it('stores a notice, returns it with 201 and lists it with the task and the snapshot', async () => {
		const p = await newProject();
		const { taskId } = await newTask(p, { title: 'T', steps: [{ key: 'one' }] });

		const res = await api.postNotice(
			taskId,
			{ kind: 'assumption', text: 'Assumed UTC', path: 'one' },
			p.writeKey
		);

		expect(res.status).toBe(201);
		const { notice } = await res.json();
		expect(notice).toMatchObject({
			taskId,
			path: 'one',
			kind: 'assumption',
			text: 'Assumed UTC'
		});
		expect(notice.id).toMatch(UUID_V4);
		expect(notice.createdAt).toMatch(ISO);
		expect((await taskDetail(taskId)).notices).toEqual([notice]);
		expect((await snapshot(p.id)).notices).toEqual([notice]);
	});

	it('defaults path to null for a task-level notice', async () => {
		const p = await newProject();
		const { taskId } = await newTask(p);
		const res = await api.postNotice(taskId, { kind: 'caveat', text: 'Flaky' }, p.writeKey);
		expect((await res.json()).notice.path).toBeNull();
	});

	it('publishes a notice event but keeps it out of node timelines', async () => {
		const p = await newProject();
		const { taskId } = await newTask(p, { title: 'T', steps: [{ key: 'one' }] });
		const received: Body[] = [];
		const unsubscribe = subscribe(p.id, (e) => {
			received.push(e as unknown as Body);
		});

		await api.postNotice(taskId, { kind: 'caveat', text: 'x', path: 'one' }, p.writeKey);
		unsubscribe();

		expect(received).toHaveLength(1);
		expect(received[0]).toMatchObject({ type: 'notice', taskId, path: 'one' });
		expect((await events(taskId, 'one')).map((e) => e.type)).toEqual(['node']);
		expect((await events(taskId)).map((e) => e.type)).not.toContain('notice');
	});

	it('requires the write key of the task project', async () => {
		const p = await newProject();
		const other = await newProject();
		const { taskId } = await newTask(p);
		const body = { kind: 'caveat', text: 'x' };

		expect((await api.postNotice(taskId, body)).status).toBe(401);
		expect((await api.postNotice(taskId, body, other.writeKey)).status).toBe(403);
	});

	it('returns 404 for an unknown task', async () => {
		const p = await newProject();
		const res = await api.postNotice(
			crypto.randomUUID(),
			{ kind: 'caveat', text: 'x' },
			p.writeKey
		);
		expect(res.status).toBe(404);
	});

	it.each([
		[{ text: 'x' }, 'kind is required'],
		[{ kind: 'hunch', text: 'x' }, 'notice.kind must be one of assumption, caveat'],
		[{ kind: 'caveat' }, 'text is required'],
		[{ kind: 'caveat', text: '' }, 'text must be a non-empty string of at most 2000 characters'],
		[
			{ kind: 'caveat', text: 'x'.repeat(2001) },
			'text must be a non-empty string of at most 2000 characters'
		],
		[{ kind: 'caveat', text: 'x', path: 'bad key!' }, 'malformed node path'],
		[{ kind: 'caveat', text: 'x', path: 7 }, 'path must be a string']
	])('rejects %j', async (body, error) => {
		const p = await newProject();
		const { taskId } = await newTask(p);
		const res = await api.postNotice(taskId, body, p.writeKey);
		expect(res.status).toBe(400);
		expect((await res.json()).error).toBe(error);
	});
});

describe('images', () => {
	const thumb = fakeJpeg(256, 144).toString('base64');
	const full = fakeJpeg(512, 288).toString('base64');

	it('stores a review image, serves both sizes and lists the record', async () => {
		const p = await newProject();
		const { taskId } = await newTask(p, { title: 'T', steps: [{ key: 'one' }] });

		const res = await api.postImage(
			taskId,
			{ thumb, full, caption: 'Login page', path: 'one' },
			p.writeKey
		);

		expect(res.status).toBe(201);
		const { image } = await res.json();
		expect(image).toMatchObject({
			taskId,
			path: 'one',
			caption: 'Login page',
			review: true,
			width: 512,
			height: 288
		});
		expect(image.id).toMatch(UUID_V4);
		expect(image.createdAt).toMatch(ISO);
		expect((await api.getTask(taskId).then((r) => r.json())).images).toEqual([image]);
		expect((await snapshot(p.id)).images).toEqual([image]);

		const small = await api.getImageFile(image.id, 'thumb.jpg');
		expect(small.status).toBe(200);
		expect(small.headers.get('content-type')).toBe('image/jpeg');
		expect(small.headers.get('cache-control')).toBe('private, max-age=604800, immutable');
		expect(Buffer.from(await small.arrayBuffer()).toString('base64')).toBe(thumb);
		const large = await api.getImageFile(image.id, 'full.jpg');
		expect(Buffer.from(await large.arrayBuffer()).toString('base64')).toBe(full);
	});

	it('keeps a thumbnail-only image out of review and has no full view', async () => {
		const p = await newProject();
		const { taskId } = await newTask(p);
		const { image } = await (await api.postImage(taskId, { thumb }, p.writeKey)).json();

		expect(image).toMatchObject({ review: false, caption: '', path: null, width: 256 });
		expect((await api.getImageFile(image.id, 'full.jpg')).status).toBe(404);
		expect((await api.getImageFile(image.id, 'other.jpg')).status).toBe(404);
	});

	it('answers 404 image expired for an id with no bytes', async () => {
		const res = await api.getImageFile(crypto.randomUUID(), 'thumb.jpg');
		expect(res.status).toBe(404);
		expect((await res.json()).error).toBe('image expired');
	});

	it('publishes an image event but keeps it out of node timelines', async () => {
		const p = await newProject();
		const { taskId } = await newTask(p, { title: 'T', steps: [{ key: 'one' }] });
		const received: Body[] = [];
		const unsubscribe = subscribe(p.id, (e) => {
			received.push(e as unknown as Body);
		});

		await api.postImage(taskId, { thumb, path: 'one' }, p.writeKey);
		unsubscribe();

		expect(received).toHaveLength(1);
		expect(received[0]).toMatchObject({ type: 'image', taskId, path: 'one' });
		expect((await events(taskId, 'one')).map((e) => e.type)).toEqual(['node']);
	});

	it('requires the write key of the task project', async () => {
		const p = await newProject();
		const other = await newProject();
		const { taskId } = await newTask(p);

		expect((await api.postImage(taskId, { thumb })).status).toBe(401);
		expect((await api.postImage(taskId, { thumb }, other.writeKey)).status).toBe(403);
	});

	const THUMB_ERROR = 'thumb must be a base64 JPEG of at most 256×256 px and 64 KiB';
	const FULL_ERROR = 'full must be a base64 JPEG of at most 512×512 px and 192 KiB';
	it.each([
		['no thumb', {}, 'thumb is required'],
		['a thumb too wide', { thumb: fakeJpeg(257, 10).toString('base64') }, THUMB_ERROR],
		['a thumb too heavy', { thumb: fakeJpeg(10, 10, 64 * 1024).toString('base64') }, THUMB_ERROR],
		[
			'a PNG thumb',
			{ thumb: Buffer.from('\x89PNG\r\n\x1a\n0000').toString('base64') },
			THUMB_ERROR
		],
		['a thumb that is not base64', { thumb: '***' }, THUMB_ERROR],
		['a full too tall', { thumb, full: fakeJpeg(10, 513).toString('base64') }, FULL_ERROR],
		[
			'a caption too long',
			{ thumb, caption: 'x'.repeat(301) },
			'caption must be a string of at most 300 characters'
		],
		['a bad path', { thumb, path: 'bad key!' }, 'malformed node path']
	])('rejects %s', async (_, body, error) => {
		const p = await newProject();
		const { taskId } = await newTask(p);
		const res = await api.postImage(taskId, body, p.writeKey);
		expect(res.status).toBe(400);
		expect((await res.json()).error).toBe(error);
	});
});

describe('review kind', () => {
	it('puts an In review state with the review kind after testing in build-it', () => {
		const keys = BUILD_IT.states.map((s) => s.key);
		expect(keys.indexOf('review')).toBe(keys.indexOf('testing') + 1);
		expect(BUILD_IT.states.find((s) => s.key === 'review')).toMatchObject({
			label: 'In review',
			kind: 'review',
			color: '#7dd3fc'
		});
	});

	it('accepts review as a kind in a custom config', async () => {
		const p = await newProject();
		const res = await api.patchConfig(
			p.id,
			{ states: [{ key: 'qa', label: 'QA', color: '#123456', kind: 'review' }] },
			p.writeKey
		);
		expect(res.status).toBe(200);
	});
});

describe('body size cap', () => {
	it('refuses a chunked body past the cap without trusting Content-Length', async () => {
		const chunk = new Uint8Array(1024 * 1024).fill(32);
		let sent = 0;
		const body = new ReadableStream<Uint8Array>({
			pull(controller) {
				if (sent++ >= 6) controller.close();
				else controller.enqueue(chunk);
			}
		});
		const request = new Request('http://localhost/x', {
			method: 'POST',
			body,
			duplex: 'half'
		} as RequestInit);

		await expect(readBody(request)).rejects.toMatchObject({ status: 413 });
	});
});
