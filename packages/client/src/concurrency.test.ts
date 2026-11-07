import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import http, { type IncomingHttpHeaders, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { createClient, type Task } from './index.ts';

const T = '2026-10-12T00:00:00.000Z';

const TASK: Task = {
	id: 'task-1',
	projectId: 'proj-1',
	title: 'Concurrent',
	summary: '',
	state: 'queued',
	note: '',
	createdAt: T,
	updatedAt: T,
	stateSince: T,
	finishedAt: null
};

interface Recorded {
	method: string;
	path: string;
	headers: IncomingHttpHeaders;
	body: unknown;
}

interface Fake {
	url: string;
	requests: Recorded[];
	server: Server;
}

const fakes: Fake[] = [];
const tempDirs: string[] = [];
let configDir: string;

function route(req: Recorded, origin: string, counters: { projects: number; tasks: number }) {
	if (req.method === 'GET' && req.path === '/api/health') {
		return { status: 200, body: { service: 'chronicle', version: '0.1.0', db: 'ok' } };
	}
	if (req.method === 'POST' && req.path === '/api/projects') {
		counters.projects += 1;
		const id = `proj-${counters.projects}`;
		return {
			status: 201,
			body: { id, name: 'Quiet Teal Otter', writeKey: `key-${id}`, url: `${origin}/p/${id}` }
		};
	}
	const posted = req.path.match(/^\/api\/projects\/([^/]+)\/tasks$/);
	if (req.method === 'POST' && posted) {
		const projectId = posted[1];
		if (req.headers.authorization !== `Bearer key-${projectId}`) {
			return { status: 403, body: { error: 'invalid write key' } };
		}
		counters.tasks += 1;
		const taskId = `task-${counters.tasks}`;
		return {
			status: 201,
			body: {
				taskId,
				url: `${origin}/p/${projectId}/t/${taskId}`,
				task: { ...TASK, id: taskId, projectId },
				nodes: []
			}
		};
	}
	const patched = req.path.match(/^\/api\/tasks\/([^/]+)$/);
	if (req.method === 'PATCH' && patched) {
		return { status: 200, body: { task: { ...TASK, id: patched[1], state: 'done' } } };
	}
	return { status: 404, body: { error: 'not found' } };
}

async function startFake(): Promise<Fake> {
	const requests: Recorded[] = [];
	const counters = { projects: 0, tasks: 0 };
	const server = http.createServer((req, res) => {
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
			requests.push(rec);
			const reply = route(rec, `http://${req.headers.host}`, counters);
			res.writeHead(reply.status, { 'content-type': 'application/json' });
			res.end(JSON.stringify(reply.body));
		});
	});
	await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
	const { port } = server.address() as AddressInfo;
	const fake: Fake = { url: `http://127.0.0.1:${port}`, requests, server };
	fakes.push(fake);
	return fake;
}

function workDir(): string {
	const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ws-cwd-')));
	tempDirs.push(dir);
	return dir;
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

function makeClient(url: string) {
	return createClient({
		env: { CHRONICLE_URL: url },
		configDir,
		loginFile: path.join(configDir, 'runestone', 'login.json'),
		probeTimeoutMs: 1000,
		requestTimeoutMs: 5000
	});
}

function readJsonFile(name: string): Record<string, Record<string, { projectId: string }>> {
	return JSON.parse(fs.readFileSync(path.join(configDir, name), 'utf8'));
}

function failures(results: { ok: boolean }[]): unknown[] {
	return results.filter((r) => !r.ok);
}

beforeEach(() => {
	configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-config-'));
	tempDirs.push(configDir);
});

afterEach(async () => {
	await Promise.all(
		fakes.splice(0).map(
			(fake) =>
				new Promise<void>((resolve) => {
					fake.server.closeAllConnections();
					fake.server.close(() => resolve());
				})
		)
	);
	for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('concurrent startTask', () => {
	it('keeps every registry entry when eight non-git starts run at once', async () => {
		const fake = await startFake();
		const client = makeClient(fake.url);
		const cwds = Array.from({ length: 8 }, () => workDir());

		const started = await Promise.all(
			cwds.map((cwd, i) => client.startTask({ title: `task ${i}`, cwd }))
		);

		expect(failures(started)).toEqual([]);
		const taskIds = started.flatMap((r) => (r.ok ? [r.value.taskId] : []));
		expect(new Set(taskIds).size).toBe(8);

		const handles = readJsonFile('tasks.json');
		expect(Object.keys(handles).sort()).toEqual([...taskIds].sort());

		const registry = readJsonFile('projects.json');
		expect(Object.keys(registry[fake.url]).sort()).toEqual([...cwds].sort());
		const projectIds = Object.values(registry[fake.url]).map((entry) => entry.projectId);
		expect(new Set(projectIds).size).toBe(8);

		const updated = await Promise.all(
			taskIds.map((taskId) => client.updateTask({ taskId, state: 'done' }))
		);

		expect(failures(updated)).toEqual([]);
		const patches = fake.requests.filter((r) => r.method === 'PATCH');
		expect(patches.map((r) => r.path).sort()).toEqual(
			taskIds.map((id) => `/api/tasks/${id}`).sort()
		);

		expect(fs.readdirSync(configDir).sort()).toEqual(['projects.json', 'tasks.json']);
	});

	it('creates one project when six starts in the same repo run at once', async () => {
		const fake = await startFake();
		const client = makeClient(fake.url);
		const repo = workDir();
		git(repo, ['init', '-q']);
		git(repo, ['commit', '-q', '--allow-empty', '-m', 'init']);

		const started = await Promise.all(
			Array.from({ length: 6 }, (_, i) => client.startTask({ title: `task ${i}`, cwd: repo }))
		);

		expect(failures(started)).toEqual([]);
		const creates = fake.requests.filter((r) => r.method === 'POST' && r.path === '/api/projects');
		expect(creates).toHaveLength(1);

		const taskIds = started.flatMap((r) => (r.ok ? [r.value.taskId] : []));
		expect(started.flatMap((r) => (r.ok ? [r.value.projectId] : []))).toEqual(
			Array(6).fill('proj-1')
		);
		const taskPosts = fake.requests.filter(
			(r) => r.method === 'POST' && r.path.startsWith('/api/projects/')
		);
		expect(taskPosts.map((r) => r.path)).toEqual(Array(6).fill('/api/projects/proj-1/tasks'));

		expect(readJsonFile('tasks.json')).toEqual(
			Object.fromEntries(
				taskIds.map((id) => [
					id,
					{ server: fake.url, projectId: 'proj-1', projectUrl: `${fake.url}/p/proj-1` }
				])
			)
		);
		expect(readJsonFile('projects.json')).toEqual({
			[fake.url]: {
				[path.join(repo, '.git')]: {
					projectId: 'proj-1',
					writeKey: 'key-proj-1',
					name: 'Quiet Teal Otter',
					projectUrl: `${fake.url}/p/proj-1`
				}
			}
		});

		const updated = await Promise.all(
			taskIds.map((taskId) => client.updateTask({ taskId, state: 'done' }))
		);
		expect(failures(updated)).toEqual([]);

		expect(fs.readdirSync(configDir).sort()).toEqual(['projects.json', 'tasks.json']);
	});
});
