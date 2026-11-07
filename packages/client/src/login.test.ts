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

beforeEach(async () => {
	configDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'login-')));
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
			const out = rec.path === '/api/health' ? healthy() : (identity(rec) ?? reply(rec));
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
			body: { idToken: 'id-1', refreshToken: 'refresh-1', expiresIn: '3600' }
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

const healthy = () => ({ status: 200, body: { service: 'chronicle', version: '1', db: 'ok' } });

const makeClient = () =>
	createClient({
		env: {},
		configDir,
		candidates: [url],
		loginPollMs: 5,
		requestTimeoutMs: 1000,
		identityUrls: { signIn: `${url}/identity/signIn`, refresh: `${url}/identity/refresh` }
	});

const tokens = () => JSON.parse(fs.readFileSync(path.join(configDir, 'tokens.json'), 'utf8'));

function deviceServer(polls: number) {
	let left = polls;
	reply = (req) => {
		if (req.method === 'POST' && req.path === '/api/device') {
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
		if (req.method === 'GET' && req.path === '/api/device') {
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
		const polls = requests.filter((r) => r.method === 'GET' && r.path === '/api/device');
		expect(polls).toHaveLength(3);
		expect(polls[0].headers.authorization).toBe('Bearer dev-secret');
		expect(requests.find((r) => r.method === 'POST')?.body).toEqual({ label: 'laptop' });
		const signIn = requests.find((r) => r.path.startsWith('/identity/signIn'));
		expect(signIn?.path).toBe('/identity/signIn?key=web-key');
		expect(signIn?.body).toEqual({ token: 'custom', returnSecureToken: true });
		expect(tokens()).toEqual({
			[url]: { refreshToken: 'refresh-1', apiKey: 'web-key', label: 'laptop' }
		});
		expect(fs.statSync(path.join(configDir, 'tokens.json')).mode & 0o777).toBe(0o600);
	});

	it('reports a denied or expired login without storing anything', async () => {
		reply = (req) =>
			req.method === 'POST'
				? deviceBody()
				: { status: 410, body: { error: 'the login expired or was denied; start again' } };

		const result = await makeClient().login();

		expect(result).toMatchObject({ ok: false });
		expect(fs.existsSync(path.join(configDir, 'tokens.json'))).toBe(false);
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
		fs.writeFileSync(
			path.join(configDir, 'tokens.json'),
			JSON.stringify({ [url]: { refreshToken: 'refresh-1', apiKey: 'web-key' } })
		);
		reply = () => ({ status: 200, body: { task: { id: 't1' } } });
		seedTask();
		const client = makeClient();

		await client.updateTask({ taskId: 't1', note: 'a' });
		await client.updateTask({ taskId: 't1', note: 'b' });

		expect(refreshes).toBe(1);
	});

	it('stop being sent once Firebase refuses the refresh token', async () => {
		fs.writeFileSync(
			path.join(configDir, 'tokens.json'),
			JSON.stringify({ [url]: { refreshToken: 'revoked', apiKey: 'web-key' } })
		);
		reply = () => ({ status: 200, body: { task: { id: 't1' } } });
		seedTask();
		const client = createClient({
			env: {},
			configDir,
			candidates: [url],
			requestTimeoutMs: 1000,
			identityUrls: { signIn: `${url}/nope`, refresh: `${url}/nope` }
		});

		const result = await client.updateTask({ taskId: 't1', note: 'a' });

		expect(result).toMatchObject({ ok: false });
		expect(requests.some((r) => r.method === 'PATCH')).toBe(false);
	});
});

describe('owned projects', () => {
	it('are created and written with a refreshed Firebase ID token, never a write key', async () => {
		fs.writeFileSync(
			path.join(configDir, 'tokens.json'),
			JSON.stringify({ [url]: { refreshToken: 'refresh-1', apiKey: 'web-key' } })
		);
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
	it('signs the user out at the server and forgets the refresh token locally', async () => {
		fs.writeFileSync(
			path.join(configDir, 'tokens.json'),
			JSON.stringify({ [url]: { refreshToken: 'refresh-1', apiKey: 'web-key' } })
		);
		reply = () => ({ status: 200, body: { ok: true } });

		const result = await makeClient().logout();

		expect(result).toEqual({ ok: true, value: { server: url, revoked: true } });
		const revoke = requests.find((r) => r.method === 'DELETE');
		expect([revoke?.path, revoke?.headers.authorization]).toEqual(['/api/token', 'Bearer id-r1']);
		expect(tokens()).toEqual({});
	});

	it('says so when nobody is logged in', async () => {
		expect(await makeClient().logout()).toMatchObject({ ok: false });
	});
});
