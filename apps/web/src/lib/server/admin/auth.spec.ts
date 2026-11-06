import { describe, expect, it } from 'vitest';
import {
	createAdminAuth,
	COOKIE,
	CSRF_HEADER,
	guardWith,
	requireAdmin,
	type AdminRequest
} from './auth.ts';

const TOKEN = 'a-very-long-admin-token';
const ORIGIN = 'http://chronicle.test';

function req(
	path: string,
	{
		method = 'GET',
		headers = {},
		body,
		ip = '10.0.0.1'
	}: { method?: string; headers?: Record<string, string>; body?: unknown; ip?: string } = {}
): AdminRequest {
	return {
		request: new Request(new URL(ORIGIN + path), {
			method,
			headers,
			body: body === undefined ? undefined : JSON.stringify(body)
		}),
		url: new URL(ORIGIN + path),
		getClientAddress: () => ip,
		locals: {}
	};
}

async function loginCookie(auth: ReturnType<typeof createAdminAuth>) {
	const res = await auth.login(req('/api/admin/login', { method: 'POST', body: { token: TOKEN } }));
	expect(res.status).toBe(200);
	const cookie = res.headers.get('set-cookie')!;
	const csrf = (await res.json()).csrf as string;
	return { cookie, header: cookie.split(';')[0], csrf };
}

describe('admin gate', () => {
	it('answers 404 for every admin path when no token is set', async () => {
		const auth = createAdminAuth({ token: undefined });
		for (const path of ['/admin', '/api/admin/stats', '/api/admin/export', '/admin/x']) {
			expect(auth.gate(req(path))?.status).toBe(404);
		}
		expect((await auth.login(req('/api/admin/login', { method: 'POST' }))).status).toBe(404);
		expect(auth.gate(req('/api/health'))).toBeUndefined();
	});

	it('requires credentials on admin API routes once enabled', () => {
		const auth = createAdminAuth({ token: TOKEN });
		const res = auth.gate(req('/api/admin/stats'))!;
		expect(res.status).toBe(401);
		expect(auth.gate(req('/admin'))).toBeUndefined();
		const post = (origin: string) =>
			auth.gate(req('/api/admin/login', { method: 'POST', headers: { origin } }));
		expect(post(ORIGIN)).toBeUndefined();
		expect(post('http://evil.test')?.status).toBe(403);
		expect(auth.gate(req('/api/projects'))).toBeUndefined();
	});

	it('accepts the token as a Bearer header, with no CSRF token', () => {
		const auth = createAdminAuth({ token: TOKEN });
		const good = req('/api/admin/projects/x', {
			method: 'DELETE',
			headers: { authorization: `Bearer ${TOKEN}` }
		});
		expect(auth.gate(good)).toBeUndefined();
		expect(good.locals.admin?.via).toBe('bearer');
		const bad = req('/api/admin/stats', { headers: { authorization: 'Bearer nope' } });
		expect(auth.gate(bad)?.status).toBe(401);
	});

	it('sets an HttpOnly SameSite=Strict cookie on login and accepts it', async () => {
		const auth = createAdminAuth({ token: TOKEN });
		const { cookie, header } = await loginCookie(auth);
		expect(cookie).toMatch(/HttpOnly/);
		expect(cookie).toMatch(/SameSite=Strict/);
		const ok = req('/api/admin/stats', { headers: { cookie: header } });
		expect(auth.gate(ok)).toBeUndefined();
		expect(ok.locals.admin?.via).toBe('cookie');
	});

	it('marks the cookie Secure behind an https origin', async () => {
		const auth = createAdminAuth({ token: TOKEN });
		const event = req('/api/admin/login', { method: 'POST', body: { token: TOKEN } });
		event.url = new URL('https://chronicle.test/api/admin/login');
		const res = await auth.login(event);
		expect(res.headers.get('set-cookie')).toMatch(/; Secure/);
	});

	it('refuses a state change from a cookie without the CSRF token or a matching Origin', async () => {
		const auth = createAdminAuth({ token: TOKEN });
		const { header, csrf } = await loginCookie(auth);
		const send = (headers: Record<string, string>) =>
			auth.gate(
				req('/api/admin/projects/x', { method: 'DELETE', headers: { cookie: header, ...headers } })
			);

		expect(send({ origin: ORIGIN })?.status).toBe(403);
		expect(send({ origin: ORIGIN, [CSRF_HEADER]: 'wrong' })?.status).toBe(403);
		expect(send({ origin: 'http://evil.test', [CSRF_HEADER]: csrf })?.status).toBe(403);
		expect(send({ [CSRF_HEADER]: csrf })?.status).toBe(403);
		expect(send({ origin: ORIGIN, [CSRF_HEADER]: csrf })).toBeUndefined();
	});

	it('refuses a forged, tampered or expired cookie', async () => {
		let clock = 1_000_000;
		const auth = createAdminAuth({ token: TOKEN, now: () => clock });
		const { header } = await loginCookie(auth);
		const value = header.slice(COOKIE.length + 1);
		const status = (v: string) =>
			auth.gate(req('/api/admin/stats', { headers: { cookie: `${COOKIE}=${v}` } }))?.status;
		expect(status(value)).toBeUndefined();
		const [exp, nonce, sig] = value.split('.');
		expect(status(`${Number(exp) + 1}.${nonce}.${sig}`)).toBe(401);
		expect(status(`${exp}.${nonce}.${sig.slice(1)}x`)).toBe(401);
		expect(status('garbage')).toBe(401);
		expect(
			createAdminAuth({ token: 'another-long-admin-token' }).gate(
				req('/api/admin/stats', { headers: { cookie: header } })
			)?.status
		).toBe(401);
		clock += 9 * 3_600_000;
		expect(status(value)).toBe(401);
	});

	it('rejects a wrong token and rate-limits failed logins per address', async () => {
		let clock = 0;
		const auth = createAdminAuth({
			token: TOKEN,
			now: () => clock,
			maxFailures: 3,
			failureWindowMs: 60_000
		});
		const attempt = (token: string, ip = '1.1.1.1') =>
			auth.login(req('/api/admin/login', { method: 'POST', body: { token }, ip }));
		for (let i = 0; i < 3; i++) expect((await attempt('wrong')).status).toBe(401);
		const locked = await attempt(TOKEN);
		expect(locked.status).toBe(429);
		expect(Number(locked.headers.get('retry-after'))).toBeGreaterThan(0);
		expect((await attempt(TOKEN, '2.2.2.2')).status).toBe(200);
		clock += 61_000;
		expect((await attempt(TOKEN)).status).toBe(200);
	});

	it('counts failed Bearer attempts toward the same limit', () => {
		const auth = createAdminAuth({ token: TOKEN, maxFailures: 2 });
		const probe = (token: string) =>
			auth.gate(req('/api/admin/stats', { headers: { authorization: `Bearer ${token}` } }))?.status;
		expect(probe('x')).toBe(401);
		expect(probe('x')).toBe(401);
		expect(probe(TOKEN)).toBe(429);
	});
});

const API_VARIANTS = [
	'/api/admin/stats',
	'/%61pi/admin/stats',
	'/api/%61dmin/stats',
	'/%2561pi/admin/stats',
	'//api/admin/stats',
	'/api//admin/stats',
	'/api/admin/stats/'
];
const PAGE_VARIANTS = ['/%41dmin', '/admin/', '//admin', '/%61dmin'];
const VARIANTS = [...API_VARIANTS, ...PAGE_VARIANTS];

describe('encoded and odd paths', () => {
	it.each(VARIANTS)('answers 404 for %s while the portal is off', (path) => {
		const auth = createAdminAuth({ token: undefined });
		expect(auth.gate(req(path))?.status).toBe(404);
	});

	it.each(API_VARIANTS)('answers 401 for %s without credentials once a token is set', (path) => {
		const auth = createAdminAuth({ token: TOKEN });
		expect(auth.gate(req(path))?.status).toBe(401);
	});

	it.each(PAGE_VARIANTS)('hands %s to the page, which shows only the login form', (path) => {
		const auth = createAdminAuth({ token: TOKEN });
		const event = req(path);
		expect(auth.gate(event)).toBeUndefined();
		expect(event.locals.admin).toBeUndefined();
	});

	it.each(API_VARIANTS.slice(0, 3))('lets %s through with the token', (path) => {
		const auth = createAdminAuth({ token: TOKEN });
		const event = req(path, { headers: { authorization: `Bearer ${TOKEN}` } });
		expect(auth.gate(event)).toBeUndefined();
		expect(event.locals.admin?.via).toBe('bearer');
	});

	it('refuses a malformed escape outright', () => {
		expect(createAdminAuth({ token: TOKEN }).gate(req('/%E0%A4%A'))?.status).toBe(400);
	});

	it('leaves ordinary paths to the router', () => {
		expect(createAdminAuth({ token: TOKEN }).gate(req('/api/projects'))).toBeUndefined();
		expect(createAdminAuth({ token: undefined }).gate(req('/api/projects'))).toBeUndefined();
	});
});

describe('handlers guard themselves', () => {
	it('404s with no token configured and 401s with no verdict, whatever the gate did', async () => {
		const off = guardWith(createAdminAuth({ token: undefined }));
		const on = guardWith(createAdminAuth({ token: TOKEN }));
		const handler = async () => Response.json({ secret: true });

		expect((await off(handler)({ locals: { admin: { via: 'bearer', csrf: '' } } })).status).toBe(
			404
		);
		expect((await on(handler)({ locals: {} })).status).toBe(401);
		expect((await on(handler)({ locals: { admin: { via: 'bearer', csrf: '' } } })).status).toBe(
			200
		);
		expect(requireAdmin(createAdminAuth({ token: undefined }), {})?.status).toBe(404);
	});
});

describe('during an import', () => {
	it('answers 503 on admin routes except import, login and logout', () => {
		const auth = createAdminAuth({ token: TOKEN, importing: () => true });
		const bearer = { authorization: `Bearer ${TOKEN}` };

		expect(auth.gate(req('/api/admin/stats', { headers: bearer }))?.status).toBe(503);
		expect(auth.gate(req('/admin', { headers: bearer }))?.status).toBe(503);
		expect(auth.gate(req('/%61pi/admin/stats', { headers: bearer }))?.status).toBe(503);
		expect(
			auth.gate(req('/api/admin/import', { method: 'POST', headers: bearer }))
		).toBeUndefined();
		expect(
			auth.gate(req('/api/admin/logout', { method: 'POST', headers: bearer }))
		).toBeUndefined();
	});
});

describe('login limits', () => {
	it('caps how many addresses the lockout map tracks', async () => {
		const auth = createAdminAuth({ token: TOKEN, maxTracked: 5 });
		for (let i = 0; i < 50; i++) {
			await auth.login(
				req('/api/admin/login', { method: 'POST', body: { token: 'x' }, ip: `10.1.0.${i}` })
			);
		}
		const first = await auth.login(
			req('/api/admin/login', { method: 'POST', body: { token: TOKEN }, ip: '10.1.0.0' })
		);
		expect(first.status).toBe(200);
	});

	it('refuses a login body past 1 KiB without reading it all', async () => {
		const auth = createAdminAuth({ token: TOKEN });
		const big = { token: 'x'.repeat(5000) };
		const res = await auth.login(req('/api/admin/login', { method: 'POST', body: big }));
		expect(res.status).toBe(401);
	});
});
