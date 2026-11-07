import { beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '#lib/server/db/index.ts';
import { deviceCodes } from '#lib/server/db/schema.ts';
import { resetDb } from '#lib/server/test/db.ts';

const revoked = vi.hoisted(() => [] as string[]);

vi.mock('#lib/server/identity.ts', () => ({
	SESSION_MAX_AGE_SECONDS: 100,
	signInEnabled: true,
	webConfig: () => ({ apiKey: 'web-key', authDomain: 'd', projectId: 'p' }),
	createSession: async () => {
		throw new Error('unused');
	},
	isIdToken: (value: string | undefined) => value?.startsWith('eyJ.') === true,
	verifyBearer: async (token: string) =>
		revoked.includes(token.split('.')[1])
			? null
			: { uid: token.split('.')[1], email: null, name: null, picture: null },
	customTokenFor: async (uid: string) => `custom-for-${uid}`,
	revokeTools: async (uid: string) => void revoked.push(uid),
	verifySession: async (cookie: string) =>
		cookie.startsWith('uid-')
			? { uid: cookie.slice(4), email: null, name: null, picture: null }
			: null
}));

const { POST: startDevice } = await import('../../routes/api/auth/device/+server.ts');
const { POST: pollDevice } = await import('../../routes/api/auth/device/token/+server.ts');
const { GET: lookupDevice, POST: answerDevice } =
	await import('../../routes/api/me/device/+server.ts');
const { POST: postProject } = await import('../../routes/api/projects/+server.ts');
const { PATCH: patchProject } = await import('../../routes/api/projects/[id]/+server.ts');
const { POST: postTask } = await import('../../routes/api/projects/[id]/tasks/+server.ts');
const { DELETE: revokeTools } = await import('../../routes/api/me/agents/+server.ts');
const { GET: getProject } = await import('../../routes/api/projects/[id]/+server.ts');

const ORIGIN = 'http://localhost';

interface Call {
	method?: string;
	path: string;
	as?: string;
	body?: unknown;
	key?: string;
	params?: Record<string, string>;
	origin?: string;
}

function ev({ method = 'GET', path, as, body, key, params = {}, origin = ORIGIN }: Call) {
	const url = new URL(path, ORIGIN);
	const headers = new Headers({ origin });
	if (as) headers.set('cookie', `runestone_session=uid-${as}`);
	if (key) headers.set('authorization', `Bearer ${key}`);
	if (body !== undefined) headers.set('content-type', 'application/json');
	return {
		request: new Request(url, {
			method,
			headers,
			body: body === undefined ? undefined : JSON.stringify(body)
		}),
		params,
		url,
		getClientAddress: () => '10.0.0.1'
	} as never;
}

const json = async (response: Response) => response.json() as Promise<Record<string, any>>;

const start = async (label = 'my laptop') =>
	json(await startDevice(ev({ method: 'POST', path: '/api/auth/device', body: { label } })));
const poll = (deviceCode: string) =>
	pollDevice(ev({ method: 'POST', path: '/api/auth/device/token', key: deviceCode }));
const approve = (userCode: string, as?: string, approved = true) =>
	answerDevice(
		ev({ method: 'POST', path: '/api/me/device', as, body: { userCode, approve: approved } })
	);

// What a tool holds after trading the custom token at Firebase: an ID token naming the user.
const idTokenFor = (uid: string) => `eyJ.${uid}.sig`;

beforeEach(async () => {
	revoked.length = 0;
	await resetDb();
});

describe('device login', () => {
	it('hands a Firebase custom token to the poller once the user approves while signed in', async () => {
		const device = await start();

		const waiting = await poll(device.deviceCode);
		const anonymous = await approve(device.userCode);
		const approved = await approve(device.userCode, 'alice');
		const done = await poll(device.deviceCode);
		const again = await poll(device.deviceCode);

		expect(device.verificationUrl).toBe(`${ORIGIN}/device`);
		expect(waiting.status).toBe(202);
		expect(anonymous.status).toBe(401);
		expect(approved.status).toBe(200);
		expect(await json(done)).toEqual({
			status: 'approved',
			customToken: 'custom-for-alice',
			apiKey: 'web-key'
		});
		expect(again.status).toBe(410);
	});

	it('stores no credential: the code row is gone once spent', async () => {
		const device = await start();
		await approve(device.userCode, 'alice');
		await poll(device.deviceCode);

		expect(await db.select().from(deviceCodes)).toEqual([]);
	});

	it('accepts the code as typed, in any case without the dash', async () => {
		const device = await start();

		const res = await approve(device.userCode.replace('-', '').toLowerCase(), 'alice');

		expect(res.status).toBe(200);
	});

	it('ends in 410 for the poller when the user denies', async () => {
		const device = await start();

		await approve(device.userCode, 'alice', false);

		expect((await poll(device.deviceCode)).status).toBe(410);
	});

	it('ends in 410 once the code has expired, and cannot be approved late', async () => {
		const device = await start();
		await db.update(deviceCodes).set({ expiresAt: new Date(Date.now() - 1000) });

		expect((await poll(device.deviceCode)).status).toBe(410);
		expect((await approve(device.userCode, 'alice')).status).toBe(404);
	});

	it('rejects an unknown device code and a missing one', async () => {
		expect((await poll('nope')).status).toBe(410);
		expect((await pollDevice(ev({ method: 'POST', path: '/api/auth/device/token' }))).status).toBe(
			401
		);
	});

	it('shows the approver which tool is asking', async () => {
		const device = await start('chronicle on build-box');

		const shown = await lookupDevice(
			ev({ path: `/api/me/device?code=${device.userCode}`, as: 'alice' })
		);

		expect((await json(shown)).label).toBe('chronicle on build-box');
		const signedOut = await lookupDevice(ev({ path: `/api/me/device?code=${device.userCode}` }));
		expect(signedOut.status).toBe(401);
	});
});

describe('ID token bearers', () => {
	const create = (key?: string) =>
		postProject(ev({ method: 'POST', path: '/api/projects', key, body: {} }));

	it('create an owned, private Project with no write key', async () => {
		const res = await postProject(
			ev({
				method: 'POST',
				path: '/api/projects',
				key: idTokenFor('alice'),
				body: { name: 'Mine' }
			})
		);
		const created = await json(res);

		expect(res.status).toBe(201);
		expect(created.writeKey).toBeUndefined();
		const anonymousRead = await getProject(
			ev({ path: `/api/projects/${created.id}`, params: { id: created.id } })
		);
		const ownerRead = await getProject(
			ev({ path: `/api/projects/${created.id}`, as: 'alice', params: { id: created.id } })
		);
		expect(anonymousRead.status).toBe(404);
		expect((await json(ownerRead)).project).toMatchObject({ owned: true, public: false });
	});

	it("write to their owner's Projects only", async () => {
		const { id } = await json(await create(idTokenFor('alice')));
		const write = (key?: string) =>
			postTask(
				ev({
					method: 'POST',
					path: `/api/projects/${id}/tasks`,
					key,
					params: { id },
					body: { title: 'T' }
				})
			);

		expect((await write(idTokenFor('alice'))).status).toBe(201);
		expect((await write(idTokenFor('bob'))).status).toBe(403);
		expect((await write()).status).toBe(401);
		expect((await write('ws_made-up-write-key')).status).toBe(401);
	});

	it('are refused outright when invalid, never downgraded to an anonymous Project', async () => {
		revoked.push('alice');

		expect((await create(idTokenFor('alice'))).status).toBe(403);
	});

	it('leave anonymous Projects on their write key', async () => {
		const created = await json(await create());
		const rename = (key: string) =>
			patchProject(
				ev({
					method: 'PATCH',
					path: `/api/projects/${created.id}`,
					key,
					params: { id: created.id },
					body: { name: 'X' }
				})
			);

		expect((await rename(created.writeKey)).status).toBe(200);
		expect((await rename(idTokenFor('alice'))).status).toBe(403);
	});

	it('stop working once the user revokes their tools, by token or from the profile', async () => {
		const byTool = await revokeTools(
			ev({ method: 'DELETE', path: '/api/me/agents', key: idTokenFor('alice') })
		);
		const byProfile = await revokeTools(
			ev({ method: 'DELETE', path: '/api/me/agents', as: 'bob' })
		);

		expect([byTool.status, byProfile.status]).toEqual([200, 200]);
		expect(revoked).toEqual(['alice', 'bob']);
		expect((await create(idTokenFor('alice'))).status).toBe(403);
	});

	it('cannot revoke tools without a session or from another origin', async () => {
		const anonymous = await revokeTools(ev({ method: 'DELETE', path: '/api/me/agents' }));
		const cross = await revokeTools(
			ev({ method: 'DELETE', path: '/api/me/agents', as: 'bob', origin: 'https://evil.test' })
		);

		expect([anonymous.status, cross.status]).toEqual([401, 403]);
		expect(revoked).toEqual([]);
	});
});
