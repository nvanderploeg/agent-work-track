import { beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '#lib/server/db/index.ts';
import { users } from '#lib/server/db/schema.ts';
import { resetDb } from '#lib/server/test/db.ts';
import { fakeJpeg } from '#lib/server/test/jpeg.ts';

const verify = vi.hoisted(() => vi.fn());

vi.mock('#lib/server/identity.ts', () => ({
	SESSION_MAX_AGE_SECONDS: 100,
	signInEnabled: true,
	webConfig: () => ({ apiKey: 'k', authDomain: 'd', projectId: 'p' }),
	createSession: async (token: string) => ({
		cookie: `uid-${token}`,
		viewer: { uid: token, email: null, name: null, picture: null }
	}),
	verifySession: async (cookie: string) => {
		verify(cookie);
		return cookie.startsWith('uid-')
			? { uid: cookie.slice(4), email: null, name: null, picture: null }
			: null;
	}
}));

const { createProjectStream } = await import('./stream.ts');
const { mintToken } = await import('./tokens.ts');
const { sessionCookieHeader } = await import('./viewer.ts');
const { POST: postProject } = await import('../../routes/api/projects/+server.ts');
const { GET: getProject, PATCH: patchProject } =
	await import('../../routes/api/projects/[id]/+server.ts');
const { GET: getStream } = await import('../../routes/api/projects/[id]/stream/+server.ts');
const { POST: postTask } = await import('../../routes/api/projects/[id]/tasks/+server.ts');
const { GET: getTask } = await import('../../routes/api/tasks/[taskId]/+server.ts');
const { GET: getEvents } = await import('../../routes/api/tasks/[taskId]/events/+server.ts');
const { POST: postImage } = await import('../../routes/api/tasks/[taskId]/images/+server.ts');
const { GET: getImage } = await import('../../routes/api/images/[imageId]/[file]/+server.ts');
const {
	GET: getSession,
	POST: postSession,
	DELETE: deleteSession
} = await import('../../routes/api/session/+server.ts');
const { GET: listMine, POST: createMine } = await import('../../routes/api/me/projects/+server.ts');
const { PATCH: patchMine } = await import('../../routes/api/me/projects/[id]/+server.ts');
const { PATCH: patchMyTask } = await import('../../routes/api/me/tasks/[taskId]/+server.ts');
const { load: loadProjectPage } = await import('../../routes/p/[id]/+page.server.ts');
const { load: loadTaskPage } = await import('../../routes/p/[id]/t/[taskId]/+page.server.ts');

const ORIGIN = 'http://localhost';

interface Call {
	method?: string;
	path: string;
	as?: string;
	body?: unknown;
	key?: string;
	params?: Record<string, string>;
	origin?: string | null;
}

function ev({ method = 'GET', path, as, body, key, params = {}, origin = ORIGIN }: Call) {
	const url = new URL(path, ORIGIN);
	const headers = new Headers();
	if (as) headers.set('cookie', `runestone_session=uid-${as}`);
	if (key) headers.set('authorization', `Bearer ${key}`);
	if (origin !== null) headers.set('origin', origin);
	if (body !== undefined) headers.set('content-type', 'application/json');
	return {
		request: new Request(url, {
			method,
			headers,
			body: body === undefined ? undefined : JSON.stringify(body)
		}),
		params,
		url,
		setHeaders: () => {},
		getClientAddress: () => '10.0.0.1'
	} as never;
}

const json = async (response: Response) => response.json() as Promise<Record<string, any>>;

// An owned Project is written with its owner's API token; `token` is for its writes.
async function ownedProject(owner = 'alice') {
	const res = await createMine(
		ev({ method: 'POST', path: '/api/me/projects', as: owner, body: {} })
	);
	const { id } = await json(res);
	return { id: id as string, token: await mintToken(owner, 'test') };
}

async function task(project: { id: string; token: string }, title = 'T') {
	const res = await postTask(
		ev({
			method: 'POST',
			path: `/api/projects/${project.id}/tasks`,
			key: project.token,
			params: { id: project.id },
			body: { title }
		})
	);
	return (await json(res)).taskId as string;
}

const read = (id: string, as?: string) =>
	getProject(ev({ path: `/api/projects/${id}`, as, params: { id } }));
const readTask = (taskId: string, as?: string) =>
	getTask(ev({ path: `/api/tasks/${taskId}`, as, params: { taskId } }));
const setTaskPublic = (taskId: string, value: boolean, as = 'alice') =>
	patchMyTask(
		ev({
			method: 'PATCH',
			path: `/api/me/tasks/${taskId}`,
			as,
			params: { taskId },
			body: { public: value }
		})
	);
const setProjectPublic = (id: string, value: boolean, as = 'alice') =>
	patchMine(
		ev({
			method: 'PATCH',
			path: `/api/me/projects/${id}`,
			as,
			params: { id },
			body: { public: value }
		})
	);

beforeEach(async () => {
	await resetDb();
	verify.mockClear();
});

describe('anonymous Projects', () => {
	it('stay public, writable by their key, and never reach Firebase', async () => {
		const created = await json(
			await postProject(ev({ method: 'POST', path: '/api/projects', body: {} }))
		);
		const id = created.id as string;

		const res = await read(id);
		const patched = await patchProject(
			ev({
				method: 'PATCH',
				path: `/api/projects/${id}`,
				key: created.writeKey,
				params: { id },
				body: { name: 'N' }
			})
		);

		expect(res.status).toBe(200);
		expect((await json(res)).project).toMatchObject({ owned: false, public: true });
		expect(patched.status).toBe(200);
		expect(verify).not.toHaveBeenCalled();
	});
});

describe('owned Projects', () => {
	it('are created private and listed for their owner only', async () => {
		const project = await ownedProject();

		const mine = await json(await listMine(ev({ path: '/api/me/projects', as: 'alice' })));
		const theirs = await json(await listMine(ev({ path: '/api/me/projects', as: 'bob' })));

		expect(mine.projects.map((p: any) => p.project.id)).toEqual([project.id]);
		expect(mine.projects[0].project).toMatchObject({ owned: true, public: false });
		expect(theirs.projects).toEqual([]);
	});

	it('are readable by the owner alone', async () => {
		const { id } = await ownedProject();

		expect((await read(id, 'alice')).status).toBe(200);
		expect((await read(id)).status).toBe(404);
		expect((await read(id, 'bob')).status).toBe(404);
		expect((await read(id, 'forged-cookie-owner')).status).toBe(404);
	});

	it('refuse the page load to everyone but the owner', async () => {
		const { id } = await ownedProject();
		const page = (as?: string) =>
			loadProjectPage(ev({ path: `/p/${id}`, as, params: { id } }) as never);

		await expect(page()).rejects.toMatchObject({ status: 404 });
		await expect(page('bob')).rejects.toMatchObject({ status: 404 });
		expect(((await page('alice')) as any).snapshot.project.id).toBe(id);
	});

	it("accept their owner's API token for writes", async () => {
		const project = await ownedProject();

		const res = await patchProject(
			ev({
				method: 'PATCH',
				path: `/api/projects/${project.id}`,
				key: project.token,
				params: { id: project.id },
				body: { name: 'Renamed' }
			})
		);

		expect(res.status).toBe(200);
	});

	it('open to anyone once the owner makes them public, and close again', async () => {
		const { id } = await ownedProject();

		expect((await setProjectPublic(id, true)).status).toBe(200);
		expect((await read(id)).status).toBe(200);
		await setProjectPublic(id, false);
		expect((await read(id)).status).toBe(404);
	});

	it('cannot be toggled by anyone else, or from another origin, or without a boolean', async () => {
		const { id } = await ownedProject();

		expect((await setProjectPublic(id, true, 'bob')).status).toBe(404);
		const crossOrigin = await patchMine(
			ev({
				method: 'PATCH',
				path: `/api/me/projects/${id}`,
				as: 'alice',
				params: { id },
				body: { public: true },
				origin: 'https://evil.test'
			})
		);
		const noBoolean = await patchMine(
			ev({
				method: 'PATCH',
				path: `/api/me/projects/${id}`,
				as: 'alice',
				params: { id },
				body: { public: 'yes' }
			})
		);
		expect(crossOrigin.status).toBe(403);
		expect(noBoolean.status).toBe(400);
		expect((await read(id)).status).toBe(404);
	});

	it('need a session to create, and a same-origin request', async () => {
		const anonymous = await createMine(ev({ method: 'POST', path: '/api/me/projects', body: {} }));
		const crossOrigin = await createMine(
			ev({ method: 'POST', path: '/api/me/projects', as: 'alice', body: {}, origin: null })
		);

		expect(anonymous.status).toBe(401);
		expect(crossOrigin.status).toBe(403);
	});
});

describe('a public Task in a private Project', () => {
	it('is readable by URL while the rest of the Project is not', async () => {
		const project = await ownedProject();
		const shown = await task(project, 'Shown');
		const hidden = await task(project, 'Hidden');
		await setTaskPublic(shown, true);

		expect((await readTask(shown)).status).toBe(200);
		expect((await readTask(hidden)).status).toBe(404);
		expect(
			(await getEvents(ev({ path: `/api/tasks/${shown}/events`, params: { taskId: shown } })))
				.status
		).toBe(200);
		expect(
			(await getEvents(ev({ path: `/api/tasks/${hidden}/events`, params: { taskId: hidden } })))
				.status
		).toBe(404);
		expect((await read(project.id)).status).toBe(404);
	});

	it('is a private Task again after the owner unflags it', async () => {
		const project = await ownedProject();
		const id = await task(project);
		await setTaskPublic(id, true);
		await setTaskPublic(id, false);

		expect((await readTask(id)).status).toBe(404);
	});

	it('cannot be flagged by a user who does not own the Project', async () => {
		const project = await ownedProject();
		const id = await task(project);

		expect((await setTaskPublic(id, true, 'bob')).status).toBe(404);
		expect((await readTask(id)).status).toBe(404);
	});

	it('renders a task page that names nothing of its Project', async () => {
		const project = await ownedProject();
		const id = await task(project, 'Shown');
		await patchProject(
			ev({
				method: 'PATCH',
				path: `/api/projects/${project.id}`,
				key: project.token,
				params: { id: project.id },
				body: { name: 'Secret name', notes: 'secret notes' }
			})
		);
		await setTaskPublic(id, true);
		const page = (as?: string) =>
			loadTaskPage(
				ev({
					path: `/p/${project.id}/t/${id}`,
					as,
					params: { id: project.id, taskId: id }
				}) as never
			) as Promise<any>;

		const stranger = await page();
		const owner = await page('alice');

		expect(stranger.backLink).toBe(false);
		expect(JSON.stringify(stranger.snapshot)).not.toContain('Secret name');
		expect(JSON.stringify(stranger.snapshot)).not.toContain('secret notes');
		expect(owner.backLink).toBe(true);
		expect(owner.snapshot.project.name).toBe('Secret name');
	});

	it('streams only that Task to a reader who may open just it', async () => {
		const project = await ownedProject();
		const shown = await task(project, 'Shown');
		await task(project, 'Hidden');
		await setTaskPublic(shown, true);

		const scoped = await getStream(
			ev({
				path: `/api/projects/${project.id}/stream?since=0&task=${shown}`,
				params: { id: project.id }
			})
		);
		const whole = await getStream(
			ev({ path: `/api/projects/${project.id}/stream?since=0`, params: { id: project.id } })
		);

		expect(scoped.status).toBe(200);
		expect(whole.status).toBe(404);
		await scoped.body!.cancel();
	});

	it('filters other Tasks and Project changes out of a scoped stream', async () => {
		const project = await ownedProject();
		const shown = await task(project, 'Shown');
		const hidden = await task(project, 'Hidden');
		await patchProject(
			ev({
				method: 'PATCH',
				path: `/api/projects/${project.id}`,
				key: project.token,
				params: { id: project.id },
				body: { name: 'Secret name' }
			})
		);
		const stream = (await createProjectStream(project.id, {
			since: 0,
			taskId: shown,
			heartbeatMs: 60_000
		}))!;
		const reader = stream.getReader();
		const decoder = new TextDecoder();
		let text = '';
		for (;;) {
			const next = await Promise.race([
				reader.read(),
				new Promise<null>((resolve) => setTimeout(resolve, 300, null))
			]);
			if (!next || next.done) break;
			text += decoder.decode(next.value);
		}
		await reader.cancel();

		expect(text).toContain(shown);
		expect(text).not.toContain(hidden);
		expect(text).not.toContain('Secret name');
	});

	it('serves its images but not those of private Tasks', async () => {
		const project = await ownedProject();
		const shown = await task(project, 'Shown');
		const hidden = await task(project, 'Hidden');
		await setTaskPublic(shown, true);
		const upload = async (taskId: string) =>
			(
				await json(
					await postImage(
						ev({
							method: 'POST',
							path: `/api/tasks/${taskId}/images`,
							key: project.token,
							params: { taskId },
							body: { thumb: fakeJpeg(8, 8).toString('base64') }
						})
					)
				)
			).image.id as string;
		const file = (imageId: string) =>
			getImage(
				ev({ path: `/api/images/${imageId}/thumb.jpg`, params: { imageId, file: 'thumb.jpg' } })
			);

		expect((await file(await upload(shown))).status).toBe(200);
		expect((await file(await upload(hidden))).status).toBe(404);
	});
});

describe('the shared session cookie', () => {
	const url = new URL(ORIGIN);

	it('is named runestone_session and host-only without a configured domain', () => {
		expect(sessionCookieHeader('v', 10, url, undefined)).toBe(
			'runestone_session=v; Path=/; HttpOnly; SameSite=Lax; Max-Age=10'
		);
	});

	it('carries the configured Domain when set, and when cleared', () => {
		expect(sessionCookieHeader('v', 10, url, '.nanzero.com')).toContain('; Domain=.nanzero.com');
		expect(sessionCookieHeader('', 0, url, '.nanzero.com')).toMatch(
			/Max-Age=0; Domain=\.nanzero\.com/
		);
	});

	it('records the signed-in user once, on the first verified request', async () => {
		expect(await db.select().from(users)).toEqual([]);

		await getSession(ev({ path: '/api/session', as: 'carol' }));
		await getSession(ev({ path: '/api/session', as: 'carol' }));
		await getSession(ev({ path: '/api/session' }));

		expect((await db.select().from(users)).map((u) => u.uid)).toEqual(['carol']);
	});
});

describe('session endpoints', () => {
	it('set an HttpOnly cookie on sign-in and clear it on sign-out', async () => {
		const signedIn = await postSession(
			ev({ method: 'POST', path: '/api/session', body: { idToken: 'alice' } })
		);
		const cookie = signedIn.headers.get('set-cookie')!;
		const signedOut = await deleteSession(ev({ method: 'DELETE', path: '/api/session' }));

		expect(cookie).toMatch(/^runestone_session=uid-alice;.*HttpOnly.*SameSite=Lax/);
		expect(signedOut.headers.get('set-cookie')).toMatch(/Max-Age=0/);
	});

	it('refuse a cross-origin sign-in or a missing token', async () => {
		const cross = await postSession(
			ev({
				method: 'POST',
				path: '/api/session',
				body: { idToken: 'x' },
				origin: 'https://evil.test'
			})
		);
		const empty = await postSession(ev({ method: 'POST', path: '/api/session', body: {} }));

		expect(cross.status).toBe(403);
		expect(empty.status).toBe(400);
	});

	it('report who is signed in and how the browser signs in', async () => {
		const body = await json(await getSession(ev({ path: '/api/session', as: 'alice' })));
		const anonymous = await json(await getSession(ev({ path: '/api/session' })));

		expect(body.user.uid).toBe('alice');
		expect(body.firebase).toEqual({ apiKey: 'k', authDomain: 'd', projectId: 'p' });
		expect(anonymous.user).toBeNull();
	});
});
