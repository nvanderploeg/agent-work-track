import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import http, { type IncomingHttpHeaders, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { createClient } from './index.ts';

interface Recorded {
	method: string;
	path: string;
	headers: IncomingHttpHeaders;
	body: any;
}

let server: Server;
let url: string;
let requests: Recorded[];
let reply: (req: Recorded) => { status: number; body: unknown };
let configDir: string;
let loginFile: string;

beforeEach(async () => {
	configDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'login-')));
	loginFile = path.join(configDir, 'runestone', 'login.json');
	requests = [];
	refreshes = 0;
	reply = () => ({ status: 404, body: { error: 'not found' } });
	server = http.createServer((req, res) => {
		const chunks: Buffer[] = [];
		req.on('data', (c: Buffer) => chunks.push(c));
		req.on('end', () => {
			const raw = Buffer.concat(chunks).toString('utf8');
			const rec = {
				method: req.method ?? '',
				path: req.url ?? '',
				headers: req.headers,
				body: raw.startsWith('{') ? JSON.parse(raw) : raw || undefined
			};
			requests.push(rec);
			const out =
				rec.path === '/api/health'
					? healthy()
					: rec.path === '/api/auth/config'
						? { status: 200, body: { apiKey: 'web-key', projectId: 'runestone-d3a35' } }
						: (identity(rec) ?? reply(rec));
			res.writeHead(out.status, { 'content-type': 'application/json' });
			res.end(JSON.stringify(out.body));
		});
	});
	await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
	url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterEach(async () => {
	await new Promise((resolve) => server.close(resolve));
});

// Firebase's token endpoints. A refresh hands out a new ID token each time, as Firebase does.
let refreshes = 0;
function identity(req: Recorded) {
	const path = req.path.split('?')[0];
	if (path === '/identity/signIn') {
		return {
			status: 200,
			body: { idToken: jwt(CLAIMS), refreshToken: 'refresh-1', expiresIn: '3600' }
		};
	}
	if (path === '/identity/refresh') {
		refreshes++;
		return {
			status: 200,
			body: { id_token: `id-r${refreshes}`, refresh_token: 'refresh-1', expires_in: '3600' }
		};
	}
	return undefined;
}

const jwt = (claims: object) => `h.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.s`;
const CLAIMS = { sub: 'uid-1', aud: 'runestone-d3a35', email: 'a@b.test' };
const LOGIN = { refreshToken: 'refresh-1', uid: 'uid-1', projectId: 'runestone-d3a35' };

const healthy = () => ({ status: 200, body: { service: 'chronicle', version: '1', db: 'ok' } });

const makeClient = () =>
	createClient({
		env: {},
		configDir,
		loginFile,
		candidates: [url],
		loginPollMs: 5,
		requestTimeoutMs: 1000,
		identityUrls: { signIn: `${url}/identity/signIn`, refresh: `${url}/identity/refresh` }
	});

const stored = () => JSON.parse(fs.readFileSync(loginFile, 'utf8'));
const seedLogin = (login: object = LOGIN) => {
	fs.mkdirSync(path.dirname(loginFile), { recursive: true });
	fs.writeFileSync(loginFile, JSON.stringify(login));
};

function deviceServer(polls: number) {
	let left = polls;
	reply = (req) => {
		if (req.method === 'POST' && req.path === '/api/auth/device') {
			return {
				status: 201,
				body: {
					deviceCode: 'dev-secret',
					userCode: 'ABCD-2345',
					verificationUrl: `${url}/device?code=ABCD-2345`,
					expiresIn: 60,
					interval: 3
				}
			};
		}
		if (req.method === 'POST' && req.path === '/api/auth/device/token') {
			return left-- > 0
				? { status: 202, body: { status: 'pending' } }
				: { status: 200, body: { status: 'approved', customToken: 'custom', apiKey: 'web-key' } };
		}
		return { status: 404, body: { error: 'not found' } };
	};
}

describe('login', () => {
	it('shows the code, trades the custom token for a refresh token and stores it at mode 0600', async () => {
		deviceServer(2);
		const codes: string[] = [];

		const result = await makeClient().login({
			label: 'laptop',
			onCode: (code) => codes.push(`${code.verificationUrl} ${code.userCode}`)
		});

		expect(result).toEqual({ ok: true, value: { server: url } });
		expect(codes).toEqual([`${url}/device?code=ABCD-2345 ABCD-2345`]);
		const polls = requests.filter((r) => r.path === '/api/auth/device/token');
		expect(polls).toHaveLength(3);
		expect(polls[0].headers.authorization).toBe('Bearer dev-secret');
		expect(requests.find((r) => r.path === '/api/auth/device')?.body).toEqual({ label: 'laptop' });
		const signIn = requests.find((r) => r.path.startsWith('/identity/signIn'));
		expect(signIn?.path).toBe('/identity/signIn?key=web-key');
		expect(signIn?.body).toEqual({ token: 'custom', returnSecureToken: true });
		expect(stored()).toEqual({ ...LOGIN, email: 'a@b.test' });
		expect(fs.statSync(loginFile).mode & 0o777).toBe(0o600);
		expect(fs.statSync(path.dirname(loginFile)).mode & 0o777).toBe(0o700);
	});

	it('reports a denied or expired login without storing anything', async () => {
		reply = (req) =>
			req.path === '/api/auth/device'
				? deviceBody()
				: { status: 410, body: { error: 'the login expired or was denied; start again' } };

		const result = await makeClient().login();

		expect(result).toMatchObject({ ok: false });
		expect(fs.existsSync(loginFile)).toBe(false);
	});
});

function deviceBody() {
	return {
		status: 201,
		body: {
			deviceCode: 'd',
			userCode: 'ABCD-2345',
			verificationUrl: `${url}/device`,
			expiresIn: 60,
			interval: 3
		}
	};
}

function seedTask() {
	fs.writeFileSync(
		path.join(configDir, 'tasks.json'),
		JSON.stringify({ t1: { server: url, projectId: 'p1' } })
	);
	fs.writeFileSync(
		path.join(configDir, 'projects.json'),
		JSON.stringify({ [url]: { '/x': { projectId: 'p1', writeKey: '', name: 'P' } } })
	);
}

describe('ID tokens', () => {
	it('are refreshed once and reused until shortly before they expire', async () => {
		seedLogin({ ...LOGIN, refreshToken: 'refresh-1' });
		reply = () => ({ status: 200, body: { task: { id: 't1' } } });
		seedTask();
		const client = makeClient();

		await client.updateTask({ taskId: 't1', note: 'a' });
		await client.updateTask({ taskId: 't1', note: 'b' });

		expect(refreshes).toBe(1);
	});

	it('stop being sent once Firebase refuses the refresh token', async () => {
		seedLogin({ ...LOGIN, refreshToken: 'revoked' });
		reply = () => ({ status: 200, body: { task: { id: 't1' } } });
		seedTask();
		const client = createClient({
			env: {},
			configDir,
			loginFile,
			candidates: [url],
			requestTimeoutMs: 1000,
			identityUrls: { signIn: `${url}/nope`, refresh: `${url}/nope` }
		});

		const result = await client.updateTask({ taskId: 't1', note: 'a' });

		expect(result).toMatchObject({ ok: false });
		expect(requests.some((r) => r.method === 'PATCH')).toBe(false);
	});
});

describe('login file', () => {
	it('is re-read on every use, so a login by another Runestone tool takes effect at once', async () => {
		seedLogin({ ...LOGIN, refreshToken: 'refresh-a' });
		reply = () => ({ status: 200, body: { task: { id: 't1' } } });
		seedTask();
		const client = makeClient();
		await client.updateTask({ taskId: 't1', note: 'a' });

		seedLogin({ ...LOGIN, refreshToken: 'refresh-b' });
		await client.updateTask({ taskId: 't1', note: 'b' });

		const refreshed = requests.filter((r) => r.path.startsWith('/identity/refresh'));
		expect(refreshed.map((r) => r.body)).toEqual([
			'grant_type=refresh_token&refresh_token=refresh-a',
			'grant_type=refresh_token&refresh_token=refresh-b'
		]);
	});

	it('is ignored when it belongs to another Firebase project', async () => {
		seedLogin({ ...LOGIN, projectId: 'elsewhere' });
		reply = () => ({ status: 200, body: { task: { id: 't1' } } });
		seedTask();

		const result = await makeClient().updateTask({ taskId: 't1', note: 'a' });

		expect(result).toMatchObject({ ok: false });
		expect(refreshes).toBe(0);
	});

	it('reads as logged out while damaged', async () => {
		fs.mkdirSync(path.dirname(loginFile), { recursive: true });
		fs.writeFileSync(loginFile, '{"refreshTok');

		expect(await makeClient().logout()).toMatchObject({ ok: false });
	});
});

describe('owned projects', () => {
	it('are created and written with a refreshed Firebase ID token, never a write key', async () => {
		seedLogin({ ...LOGIN, refreshToken: 'refresh-1' });
		reply = (req) => {
			if (req.path === '/api/projects') {
				return { status: 201, body: { id: 'p1', name: 'Mine', url: `${url}/p/p1`, config: {} } };
			}
			if (req.path === '/api/projects/p1/tasks') {
				return { status: 201, body: { taskId: 't1', url: `${url}/p/p1/t/t1` } };
			}
			if (req.path === '/api/tasks/t1') {
				return { status: 200, body: { task: { id: 't1' } } };
			}
			return { status: 404, body: { error: 'not found' } };
		};
		const client = makeClient();

		const started = await client.startTask({ title: 'T', cwd: configDir });
		const updated = await client.updateTask({ taskId: 't1', note: 'n' });

		expect(started.ok && updated.ok).toBe(true);
		const writes = requests.filter((r) => r.method !== 'GET' && r.path.startsWith('/api/'));
		expect(writes.map((r) => r.headers.authorization)).toEqual([
			'Bearer id-r1',
			'Bearer id-r1',
			'Bearer id-r1'
		]);
		expect(refreshes).toBe(1);
		const registry = JSON.parse(fs.readFileSync(path.join(configDir, 'projects.json'), 'utf8'));
		expect(JSON.stringify(registry)).not.toContain('refresh-1');
	});
});

describe('logout', () => {
	it('signs the user out at the server and removes the login file', async () => {
		seedLogin({ ...LOGIN, refreshToken: 'refresh-1' });
		reply = () => ({ status: 200, body: { ok: true } });

		const result = await makeClient().logout();

		expect(result).toEqual({ ok: true, value: { server: url, revoked: true } });
		const revoke = requests.find((r) => r.method === 'DELETE');
		expect([revoke?.path, revoke?.headers.authorization]).toEqual([
			'/api/me/agents',
			'Bearer id-r1'
		]);
		expect(fs.existsSync(loginFile)).toBe(false);
	});

	it('says so when nobody is logged in', async () => {
		expect(await makeClient().logout()).toMatchObject({ ok: false });
	});
});

describe('lapsed login', () => {
	function projectServer(tasks: () => { status: number; body: unknown }) {
		reply = (req) => {
			if (req.method === 'POST' && req.path === '/api/projects') {
				return { status: 201, body: { id: 'p1', name: 'Mine', url: `${url}/p/p1`, config: {} } };
			}
			if (req.path === '/api/projects/p1/tasks') return tasks();
			return { status: 404, body: { error: 'not found' } };
		};
	}
	const ok = () => ({ status: 201, body: { taskId: 't1', url: `${url}/p/p1/t/t1` } });
	const createCalls = () =>
		requests.filter((r) => r.method === 'POST' && r.path === '/api/projects').length;
	const registry = () =>
		JSON.parse(fs.readFileSync(path.join(configDir, 'projects.json'), 'utf8'))[url];

	async function ownedProject() {
		seedLogin();
		projectServer(ok);
		await makeClient().startTask({ title: 'T', cwd: configDir });
		requests.length = 0;
	}

	it('never replaces an owned project with a public one when logged out', async () => {
		await ownedProject();
		fs.rmSync(loginFile);

		const result = await makeClient().startTask({ title: 'T', cwd: configDir });

		expect(result).toMatchObject({ ok: false, warning: expect.stringContaining('login lapsed') });
		expect(createCalls()).toBe(0);
		expect(Object.values(registry())).toEqual([expect.objectContaining({ writeKey: '' })]);
	});

	it('never replaces an owned project when the login file is damaged', async () => {
		await ownedProject();
		fs.writeFileSync(loginFile, '{"refreshTok');

		const result = await makeClient().startTask({ title: 'T', cwd: configDir });

		expect(result).toMatchObject({ ok: false, warning: expect.stringContaining('login lapsed') });
		expect(createCalls()).toBe(0);
	});

	it('never replaces an owned project when the refresh fails', async () => {
		await ownedProject();
		const client = createClient({
			env: {},
			configDir,
			loginFile,
			candidates: [url],
			requestTimeoutMs: 1000,
			identityUrls: { signIn: `${url}/nope`, refresh: `${url}/nope` }
		});

		const result = await client.startTask({ title: 'T', cwd: configDir });

		expect(result).toMatchObject({ ok: false, warning: expect.stringContaining('login lapsed') });
		expect(createCalls()).toBe(0);
	});

	it('does not create a first project without a token while a login file exists', async () => {
		fs.mkdirSync(path.dirname(loginFile), { recursive: true });
		fs.writeFileSync(loginFile, 'damaged');
		projectServer(ok);

		const result = await makeClient().startTask({ title: 'T', cwd: configDir });

		expect(result).toMatchObject({ ok: false, warning: expect.stringContaining('login lapsed') });
		expect(createCalls()).toBe(0);
	});

	it('does not replace an owned project the server rejects with 403', async () => {
		await ownedProject();
		projectServer(() => ({ status: 403, body: { error: 'forbidden' } }));

		const result = await makeClient().startTask({ title: 'T', cwd: configDir });

		expect(result).toMatchObject({ ok: false });
		expect(createCalls()).toBe(0);
	});

	it('does not replace a project on a 503', async () => {
		await ownedProject();
		projectServer(() => ({ status: 503, body: { error: 'down' } }));
		const before = registry();

		const result = await makeClient().startTask({ title: 'T', cwd: configDir });

		expect(result).toMatchObject({ ok: false });
		expect(createCalls()).toBe(0);
		expect(registry()).toEqual(before);
	});

	it('reports the lapse, not an unknown task, when writing to an owned task', async () => {
		seedTask();

		const result = await makeClient().updateTask({ taskId: 't1', note: 'a' });

		expect(result).toMatchObject({ ok: false, warning: expect.stringContaining('login lapsed') });
	});
});
