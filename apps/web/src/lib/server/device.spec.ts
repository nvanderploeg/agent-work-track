import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '#lib/server/db/index.ts';
import { apiTokens, deviceCodes } from '#lib/server/db/schema.ts';
import { resetDb } from '#lib/server/test/db.ts';

vi.mock('#lib/server/identity.ts', () => ({
	SESSION_MAX_AGE_SECONDS: 100,
	signInEnabled: true,
	webConfig: () => null,
	createSession: async () => {
		throw new Error('unused');
	},
	verifySession: async (cookie: string) =>
		cookie.startsWith('uid-')
			? { uid: cookie.slice(4), email: null, name: null, picture: null }
			: null
}));

const { POST: startDevice, GET: pollDevice } = await import('../../routes/api/device/+server.ts');
const { GET: lookupDevice, POST: answerDevice } =
	await import('../../routes/api/me/device/+server.ts');
const { POST: postProject } = await import('../../routes/api/projects/+server.ts');
const { PATCH: patchProject } = await import('../../routes/api/projects/[id]/+server.ts');
const { POST: postTask } = await import('../../routes/api/projects/[id]/tasks/+server.ts');
const { DELETE: revokeSelf } = await import('../../routes/api/token/+server.ts');
const { GET: listTokens } = await import('../../routes/api/me/tokens/+server.ts');
const { DELETE: revokeOne } = await import('../../routes/api/me/tokens/[id]/+server.ts');
const { GET: getProject } = await import('../../routes/api/projects/[id]/+server.ts');

const ORIGIN = 'http://localhost';

interface Call {
	method?: string;
	path: string;
	as?: string;
	body?: unknown;
	key?: string;
	params?: Record<string, string>;
}

function ev({ method = 'GET', path, as, body, key, params = {} }: Call) {
	const url = new URL(path, ORIGIN);
	const headers = new Headers({ origin: ORIGIN });
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
	json(await startDevice(ev({ method: 'POST', path: '/api/device', body: { label } })));
const poll = (deviceCode: string) => pollDevice(ev({ path: '/api/device', key: deviceCode }));
const approve = (userCode: string, as?: string, approved = true) =>
	answerDevice(
		ev({ method: 'POST', path: '/api/me/device', as, body: { userCode, approve: approved } })
	);

async function login(uid = 'alice'): Promise<string> {
	const device = await start();
	await approve(device.userCode, uid);
	return (await json(await poll(device.deviceCode))).token;
}

beforeEach(resetDb);

describe('device login', () => {
	it('hands a token to the poller once the user approves while signed in', async () => {
		const device = await start();

		const waiting = await poll(device.deviceCode);
		const anonymous = await approve(device.userCode);
		const approved = await approve(device.userCode, 'alice');
		const done = await poll(device.deviceCode);
		const again = await poll(device.deviceCode);

		expect(device.verificationUrl).toBe(`${ORIGIN}/device?code=${device.userCode}`);
		expect(waiting.status).toBe(202);
		expect(anonymous.status).toBe(401);
		expect(approved.status).toBe(200);
		const body = await json(done);
		expect(body.token).toMatch(/^cht_/);
		expect(again.status).toBe(410);
	});

	it('stores only the token hash, bound to the approving uid', async () => {
		const token = await login('alice');

		const [row] = await db.select().from(apiTokens);

		expect(row.ownerUid).toBe('alice');
		expect(row.label).toBe('my laptop');
		expect(row.tokenHash).not.toContain(token);
		expect(JSON.stringify(row)).not.toContain(token);
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
		expect((await pollDevice(ev({ path: '/api/device' }))).status).toBe(401);
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

describe('API tokens', () => {
	it('create an owned, private Project with no write key', async () => {
		const token = await login('alice');

		const res = await postProject(
			ev({ method: 'POST', path: '/api/projects', key: token, body: { name: 'Mine' } })
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
		const alice = await login('alice');
		const bob = await login('bob');
		const { id } = await json(
			await postProject(ev({ method: 'POST', path: '/api/projects', key: alice, body: {} }))
		);
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

		expect((await write(alice)).status).toBe(201);
		expect((await write(bob)).status).toBe(403);
		expect((await write()).status).toBe(401);
		expect((await write('ws_made-up-write-key')).status).toBe(401);
	});

	it('are refused outright when invalid, never downgraded to an anonymous Project', async () => {
		const res = await postProject(
			ev({ method: 'POST', path: '/api/projects', key: 'cht_not-a-real-token', body: {} })
		);

		expect(res.status).toBe(403);
	});

	it('leave anonymous Projects on their write key', async () => {
		const token = await login('alice');
		const created = await json(
			await postProject(ev({ method: 'POST', path: '/api/projects', body: {} }))
		);
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
		expect((await rename(token)).status).toBe(403);
	});

	it('stop working once revoked by the owner, the token itself, or neither twice', async () => {
		const first = await login('alice');
		const second = await login('alice');
		const open = (key: string) =>
			postProject(ev({ method: 'POST', path: '/api/projects', key, body: {} }));

		const self = await revokeSelf(ev({ method: 'DELETE', path: '/api/token', key: first }));
		const listed = await json(await listTokens(ev({ path: '/api/me/tokens', as: 'alice' })));
		const byOwner = await revokeOne(
			ev({
				method: 'DELETE',
				path: `/api/me/tokens/${listed.tokens[0].id}`,
				as: 'alice',
				params: { id: listed.tokens[0].id }
			})
		);
		const repeat = await revokeOne(
			ev({
				method: 'DELETE',
				path: `/api/me/tokens/${listed.tokens[0].id}`,
				as: 'alice',
				params: { id: listed.tokens[0].id }
			})
		);

		expect(self.status).toBe(200);
		expect(listed.tokens).toHaveLength(1);
		expect(byOwner.status).toBe(200);
		expect(repeat.status).toBe(404);
		expect((await open(first)).status).toBe(403);
		expect((await open(second)).status).toBe(403);
	});

	it('cannot be revoked by another user', async () => {
		await login('alice');
		const [row] = await db.select().from(apiTokens);

		const res = await revokeOne(
			ev({ method: 'DELETE', path: `/api/me/tokens/${row.id}`, as: 'bob', params: { id: row.id } })
		);

		expect(res.status).toBe(404);
		const [after] = await db.select().from(apiTokens).where(eq(apiTokens.id, row.id));
		expect(after.revokedAt).toBeNull();
	});
});
