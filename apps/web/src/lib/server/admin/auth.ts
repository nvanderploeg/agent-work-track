import { createHmac, randomBytes, timingSafeEqual, createHash } from 'node:crypto';
import { ADMIN_TOKEN } from '$app/env/private';
import { isImporting } from '#lib/server/admin/bundle.ts';
import { readText } from '#lib/server/api.ts';
import { publicOrigin } from '#lib/server/origin.ts';
import { isUnder, pathVariants } from '#lib/server/path.ts';

export const COOKIE = 'chronicle_admin';
export const CSRF_HEADER = 'x-csrf-token';
const LOGIN_BODY_MAX_BYTES = 1024;
const SESSION_MS = 8 * 3_600_000;
const UNSAFE = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

export interface AdminRequest {
	request: Request;
	url: URL;
	getClientAddress: () => string;
	locals: App.Locals;
}

export interface AdminAuthOptions {
	token: string | undefined;
	now?: () => number;
	maxFailures?: number;
	failureWindowMs?: number;
	maxTracked?: number;
	importing?: () => boolean;
}

const notFound = () => new Response('Not Found', { status: 404 });
const deny = (status: number, error: string, headers?: HeadersInit) =>
	Response.json({ error }, { status, headers });

const tooMany = (waitMs: number) =>
	deny(429, 'too many failed attempts; retry later', {
		'retry-after': String(Math.ceil(waitMs / 1000))
	});

function digest(value: string): Buffer {
	return createHash('sha256').update(value).digest();
}

function equal(a: Buffer, b: Buffer): boolean {
	return a.length === b.length && timingSafeEqual(a, b);
}

export function isAdminPath(pathname: string): boolean {
	return isUnder(pathname, '/admin') || isUnder(pathname, '/api/admin');
}

const OPEN_DURING_IMPORT = new Set(['/api/admin/import', '/api/admin/login', '/api/admin/logout']);

function duringImport(pathname: string): boolean {
	return pathVariants(pathname).every((v) => OPEN_DURING_IMPORT.has(v));
}

export function createAdminAuth({
	token,
	now = Date.now,
	maxFailures = 5,
	failureWindowMs = 900_000,
	maxTracked = 10_000,
	importing = () => false
}: AdminAuthOptions) {
	const enabled = token !== undefined && token !== '';
	const key = enabled
		? createHmac('sha256', token!).update('chronicle-admin-v1').digest()
		: Buffer.alloc(0);
	const failures = new Map<string, { count: number; since: number }>();

	const sign = (purpose: string, value: string) =>
		createHmac('sha256', key).update(`${purpose}|${value}`).digest('base64url');

	function mint(): { value: string; maxAge: number } {
		const expires = now() + SESSION_MS;
		const body = `${expires}.${randomBytes(12).toString('hex')}`;
		return { value: `${body}.${sign('session', body)}`, maxAge: SESSION_MS / 1000 };
	}

	function cookieValue(request: Request): string | undefined {
		for (const part of (request.headers.get('cookie') ?? '').split(';')) {
			const at = part.indexOf('=');
			if (at > 0 && part.slice(0, at).trim() === COOKIE) return part.slice(at + 1).trim();
		}
		return undefined;
	}

	function csrfFor(session: string): string {
		return sign('csrf', session);
	}

	function authenticate(request: Request): { via: 'bearer' | 'cookie'; csrf: string } | null {
		if (!enabled) return null;
		const match = /^Bearer\s+(\S+)\s*$/i.exec(request.headers.get('authorization') ?? '');
		if (match) {
			return equal(digest(match[1]), digest(token!)) ? { via: 'bearer', csrf: '' } : null;
		}
		const session = cookieValue(request);
		if (!session) return null;
		const parts = session.split('.');
		if (parts.length !== 3) return null;
		const body = `${parts[0]}.${parts[1]}`;
		const good = Buffer.from(sign('session', body));
		const given = Buffer.from(parts[2]);
		if (!equal(good, given) || Number(parts[0]) <= now()) return null;
		return { via: 'cookie', csrf: csrfFor(session) };
	}

	function blocked(ip: string): number {
		const entry = failures.get(ip);
		if (!entry) return 0;
		const left = entry.since + failureWindowMs - now();
		if (left <= 0) {
			failures.delete(ip);
			return 0;
		}
		return entry.count >= maxFailures ? left : 0;
	}

	function fail(ip: string): void {
		const entry = failures.get(ip);
		if (!entry || entry.since + failureWindowMs <= now()) {
			failures.delete(ip);
			failures.set(ip, { count: 1, since: now() });
		} else {
			entry.count++;
		}
		if (failures.size > maxTracked) {
			for (const [address, e] of failures) {
				if (e.since + failureWindowMs <= now()) failures.delete(address);
			}
			for (const address of failures.keys()) {
				if (failures.size <= maxTracked) break;
				failures.delete(address);
			}
		}
	}

	function cookieHeader(value: string, maxAge: number, secure: boolean): string {
		return `${COOKIE}=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${secure ? '; Secure' : ''}`;
	}

	function sameOrigin(request: Request, url: URL): boolean {
		return request.headers.get('origin') === publicOrigin(url);
	}

	// Runs before routing. Returns a response to short-circuit, else leaves the verdict in locals.
	function gate(event: AdminRequest): Response | undefined {
		const { pathname } = event.url;
		try {
			pathVariants(pathname);
		} catch {
			return deny(400, 'malformed path');
		}
		if (!isAdminPath(pathname)) return undefined;
		if (!enabled) return notFound();

		const ip = event.getClientAddress();
		const presented = /^Bearer\s/i.test(event.request.headers.get('authorization') ?? '');
		if (presented) {
			const wait = blocked(ip);
			if (wait > 0) return tooMany(wait);
		}
		const who = authenticate(event.request);
		if (who) event.locals.admin = who;
		else if (presented) fail(ip);

		const isApi = isUnder(pathname, '/api/admin');
		const unsafe = UNSAFE.has(event.request.method);
		if (importing() && !duringImport(pathname)) {
			return deny(503, 'the server is importing a bundle; retry shortly', { 'retry-after': '30' });
		}
		if (isApi && !pathVariants(pathname).includes('/api/admin/login') && !who) {
			return deny(401, 'admin token required', { 'www-authenticate': 'Bearer' });
		}
		if (isApi && unsafe && who?.via !== 'bearer') {
			if (!sameOrigin(event.request, event.url)) return deny(403, 'cross-origin request refused');
			if (who && event.request.headers.get(CSRF_HEADER) !== who.csrf) {
				return deny(403, 'missing or wrong CSRF token');
			}
		}
		return undefined;
	}

	async function login(event: AdminRequest): Promise<Response> {
		if (!enabled) return notFound();
		const ip = event.getClientAddress();
		const wait = blocked(ip);
		if (wait > 0) {
			return tooMany(wait);
		}
		let given = '';
		try {
			const body = JSON.parse(await readText(event.request, LOGIN_BODY_MAX_BYTES));
			if (typeof body?.token === 'string') given = body.token;
		} catch {
			// an unreadable body is a failed login
		}
		if (!equal(digest(given), digest(token!))) {
			fail(ip);
			return deny(401, 'wrong admin token');
		}
		failures.delete(ip);
		const { value, maxAge } = mint();
		const secure = publicOrigin(event.url).startsWith('https:');
		return Response.json(
			{ ok: true, csrf: csrfFor(value) },
			{ headers: { 'set-cookie': cookieHeader(value, maxAge, secure) } }
		);
	}

	function logout(event: AdminRequest): Response {
		if (!enabled) return notFound();
		const secure = publicOrigin(event.url).startsWith('https:');
		return Response.json({ ok: true }, { headers: { 'set-cookie': cookieHeader('', 0, secure) } });
	}

	return { enabled, gate, login, logout, authenticate };
}

export type AdminAuth = ReturnType<typeof createAdminAuth>;

/** Every admin handler runs behind this: 404 while the portal is off, 401 without a verdict from the gate. */
export function requireAdmin(auth: AdminAuth, locals: App.Locals): Response | undefined {
	if (!auth.enabled) return notFound();
	if (!locals.admin) return deny(401, 'admin token required', { 'www-authenticate': 'Bearer' });
	return undefined;
}

export function guardWith(auth: AdminAuth) {
	return <E extends { locals: App.Locals }>(handler: (event: E) => Response | Promise<Response>) =>
		async (event: E): Promise<Response> =>
			requireAdmin(auth, event.locals) ?? handler(event);
}

export const adminAuth = createAdminAuth({ token: ADMIN_TOKEN, importing: isImporting });
export const adminOnly = guardWith(adminAuth);
