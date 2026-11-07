import { beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { db } from '#lib/server/db/index.ts';
import { deviceCodes } from '#lib/server/db/schema.ts';
import { resetDb } from '#lib/server/test/db.ts';

const auth = vi.hoisted(() => ({
	verifyIdToken: vi.fn(),
	createSessionCookie: vi.fn(),
	verifySessionCookie: vi.fn(),
	createCustomToken: vi.fn(),
	revokeRefreshTokens: vi.fn()
}));

// Only Firebase is faked: identity.ts, device.ts, viewer.ts and the routes are the real ones.
vi.mock('firebase-admin/app', () => ({
	cert: (json: unknown) => json,
	getApps: () => [],
	initializeApp: () => ({})
}));
vi.mock('firebase-admin/auth', () => ({ getAuth: () => auth }));

const { bearer, bearerUser, pollDevice } = await import('./device.ts');
const { POST: startDevice } = await import('../../routes/api/auth/device/+server.ts');
const { POST: pollRoute } = await import('../../routes/api/auth/device/token/+server.ts');
const { GET: lookupDevice, POST: answerDevice } =
	await import('../../routes/api/me/device/+server.ts');
const { DELETE: signOut, POST: signIn } = await import('../../routes/api/auth/session/+server.ts');
const { DELETE: revokeAgents } = await import('../../routes/api/me/agents/+server.ts');
const { POST: postProject } = await import('../../routes/api/projects/+server.ts');
const { GET: getStream } = await import('../../routes/api/projects/[id]/stream/+server.ts');

const ORIGIN = 'http://localhost';
const TOKEN = 'eyJhbGciOi.eyJ1aWQiOiJ4In0.c2ln';

interface Call {
	method?: string;
	path: string;
	headers?: Record<string, string>;
	body?: unknown;
	ip?: string;
	params?: Record<string, string>;
}

function ev({ method = 'GET', path, headers = {}, body, ip = '10.0.0.1', params = {} }: Call) {
	const url = new URL(path, ORIGIN);
	const all = new Headers({ origin: ORIGIN, ...headers });
	if (body !== undefined) all.set('content-type', 'application/json');
	return {
		request: new Request(url, {
			method,
			headers: all,
			body: body === undefined ? undefined : JSON.stringify(body)
		}),
		params,
		url,
		getClientAddress: () => ip
	} as never;
}

const failure = (code?: string) => Object.assign(new Error('boom'), code ? { code } : {});
const cookieOf = (name: string) => ({ cookie: `runestone_session=${name}` });
const json = async (response: Response) => response.json() as Promise<Record<string, any>>;

beforeEach(async () => {
	vi.resetAllMocks();
	await resetDb();
});

describe('Bearer parsing', () => {
	it.each([
		['Bearer abc', 'abc'],
		['bearer   abc  ', 'abc'],
		['Basic abc', undefined],
		['Bearer a b', undefined],
		['', undefined]
	])('reads %j as %j', (header, expected) => {
		const request = new Request(ORIGIN, { headers: header ? { authorization: header } : {} });

		expect(bearer(request)).toBe(expected);
	});

	it('never sends a write key to Firebase', async () => {
		const request = new Request(ORIGIN, { headers: { authorization: 'Bearer ws_secret-key' } });

		expect(await bearerUser(request)).toBeNull();
		expect(auth.verifyIdToken).not.toHaveBeenCalled();
	});
});

describe('Firebase verification', () => {
	const asTool = (token = TOKEN) => ({ authorization: `Bearer ${token}` });

	it('answers 403 for a revoked token and 503 for an outage, and revokes nothing on either', async () => {
		auth.verifyIdToken.mockRejectedValueOnce(failure('auth/id-token-revoked'));
		const revoked = await revokeAgents(
			ev({ method: 'DELETE', path: '/api/me/agents', headers: asTool(`eyJ.t1.sig`) })
		);
		auth.verifyIdToken.mockRejectedValueOnce(failure('auth/internal-error'));
		const outage = await revokeAgents(
			ev({ method: 'DELETE', path: '/api/me/agents', headers: asTool(`eyJ.t2.sig`) })
		);

		expect([revoked.status, outage.status]).toEqual([403, 503]);
		expect(auth.revokeRefreshTokens).not.toHaveBeenCalled();
	});

	it('answers 503 when creating a project during an outage, never an anonymous project', async () => {
		auth.verifyIdToken.mockRejectedValue(failure());

		const res = await postProject(
			ev({ method: 'POST', path: '/api/projects', headers: asTool(`eyJ.t3.sig`), body: {} })
		);

		expect(res.status).toBe(503);
	});

	it('answers 503 for a session during an outage', async () => {
		auth.verifySessionCookie.mockRejectedValue(failure('auth/network-error'));

		const res = await revokeAgents(
			ev({ method: 'DELETE', path: '/api/me/agents', headers: cookieOf('outage') })
		);

		expect(res.status).toBe(503);
	});

	it('refuses a tool login token as a browser session', async () => {
		auth.verifyIdToken.mockResolvedValue({
			uid: 'u',
			auth_time: Date.now() / 1000,
			firebase: { sign_in_provider: 'custom' }
		});

		const res = await signIn(
			ev({ method: 'POST', path: '/api/auth/session', body: { idToken: TOKEN } })
		);

		expect(res.status).toBe(403);
		expect(auth.createSessionCookie).not.toHaveBeenCalled();
	});
});

describe('DELETE /api/auth/session', () => {
	const signOutAs = (name: string) =>
		signOut(ev({ method: 'DELETE', path: '/api/auth/session', headers: cookieOf(name) }));

	it('revokes every refresh token of the user and clears the cookie', async () => {
		auth.verifySessionCookie.mockResolvedValue({ uid: 'alice' });

		const res = await signOutAs('so-1');

		expect(auth.revokeRefreshTokens).toHaveBeenCalledWith('alice');
		expect(res.headers.get('set-cookie')).toContain('Max-Age=0');
	});

	it('clears the cookie even when revocation fails', async () => {
		auth.verifySessionCookie.mockResolvedValue({ uid: 'alice' });
		auth.revokeRefreshTokens.mockRejectedValue(failure('auth/internal-error'));

		const res = await signOutAs('so-2');

		expect(res.status).toBe(200);
		expect(res.headers.get('set-cookie')).toContain('Max-Age=0');
	});

	it('clears the cookie when it is already invalid', async () => {
		auth.verifySessionCookie.mockRejectedValue(failure('auth/session-cookie-revoked'));

		const res = await signOutAs('so-3');

		expect(res.status).toBe(200);
		expect(auth.revokeRefreshTokens).not.toHaveBeenCalled();
	});

	it('ends the open streams of the user', async () => {
		auth.verifySessionCookie.mockResolvedValue({ uid: 'carol' });
		const created = await json(
			await postProject(ev({ method: 'POST', path: '/api/projects', body: {} }))
		);
		const streamed = await getStream(
			ev({
				path: `/api/projects/${created.id}/stream`,
				headers: cookieOf('carol-stream'),
				params: { id: created.id }
			})
		);
		const reader = streamed.body!.getReader();
		await reader.read();

		await signOutAs('carol-signout');

		const seen: string[] = [];
		for (let i = 0; i < 5 && !seen.join('').includes('event: reset'); i++) {
			const { value, done } = await reader.read();
			if (done) break;
			seen.push(new TextDecoder().decode(value));
		}
		expect(seen.join('')).toContain('event: reset');
	});
});

describe('device login', () => {
	const start = async (ip = '10.0.0.1') =>
		json(
			await startDevice(
				ev({
					method: 'POST',
					path: '/api/auth/device',
					body: { label: 'laptop' },
					ip,
					headers: { 'user-agent': 'chronicle-cli/1' }
				})
			)
		);
	const approveAs = (uid: string, userCode: string) => {
		auth.verifySessionCookie.mockResolvedValue({ uid });
		return answerDevice(
			ev({
				method: 'POST',
				path: '/api/me/device',
				headers: cookieOf(`approve-${uid}-${userCode}`),
				body: { userCode, approve: true }
			})
		);
	};

	it('keeps the approval when Firebase fails to mint the token, and hands it over on the next poll', async () => {
		const device = await start();
		await approveAs('alice', device.userCode);
		auth.createCustomToken.mockRejectedValueOnce(failure());
		auth.createCustomToken.mockResolvedValueOnce('custom-token');

		await expect(pollDevice(device.deviceCode)).rejects.toMatchObject({ status: 503 });
		expect(await db.select().from(deviceCodes)).toHaveLength(1);
		const retry = await pollDevice(device.deviceCode);

		expect(retry).toEqual({ status: 'approved', customToken: 'custom-token' });
		expect(await db.select().from(deviceCodes)).toEqual([]);
	});

	it('answers a failed poll with 503 over HTTP', async () => {
		const device = await start();
		await approveAs('alice', device.userCode);
		auth.createCustomToken.mockRejectedValue(failure());

		const res = await pollRoute(
			ev({
				method: 'POST',
				path: '/api/auth/device/token',
				headers: { authorization: `Bearer ${device.deviceCode}` }
			})
		);

		expect(res.status).toBe(503);
	});

	it('records who asked and shows it, with the age, to the approver', async () => {
		const device = await start('203.0.113.9');
		const [row] = await db.select().from(deviceCodes);
		await db
			.update(deviceCodes)
			.set({ createdAt: new Date(Date.now() - 42_000) })
			.where(eq(deviceCodes.deviceHash, row.deviceHash));
		auth.verifySessionCookie.mockResolvedValue({ uid: 'bob' });

		const seen = await json(
			await lookupDevice(
				ev({
					path: `/api/me/device?code=${device.userCode}`,
					headers: cookieOf('lookup-ip')
				})
			)
		);

		expect([row.requesterIp, row.requesterAgent]).toEqual(['203.0.113.9', 'chronicle-cli/1']);
		expect(seen).toMatchObject({ label: 'laptop', requesterIp: '203.0.113.9' });
		expect(seen.startedSecondsAgo).toBeGreaterThanOrEqual(42);
	});

	it('does not put the code in the verification URL', async () => {
		const device = await start();

		expect(device.verificationUrl).toBe(`${ORIGIN}/device`);
	});

	it('limits lookups per signed-in user', async () => {
		auth.verifySessionCookie.mockResolvedValue({ uid: 'guesser' });
		const look = () =>
			lookupDevice(ev({ path: '/api/me/device?code=AAAA-AAAA', headers: cookieOf('guess') }));

		const statuses: number[] = [];
		for (let i = 0; i < 11; i++) statuses.push((await look()).status);

		expect(statuses.slice(0, 10)).toEqual(Array(10).fill(404));
		expect(statuses[10]).toBe(429);
	});

	it('limits polls per address, loosely', async () => {
		const poll = (ip: string) =>
			pollRoute(
				ev({
					method: 'POST',
					path: '/api/auth/device/token',
					headers: { authorization: 'Bearer nothing' },
					ip
				})
			);

		const statuses: number[] = [];
		for (let i = 0; i < 121; i++) statuses.push((await poll('198.51.100.7')).status);

		expect(new Set(statuses.slice(0, 120))).toEqual(new Set([410]));
		expect(statuses[120]).toBe(429);
		expect((await poll('198.51.100.8')).status).toBe(410);
	});
});
