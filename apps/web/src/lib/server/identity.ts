import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { cert, getApps, initializeApp, type App } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import {
	FIREBASE_WEB_API_KEY,
	FIREBASE_APP_ID,
	FIREBASE_AUTH_DOMAIN,
	FIREBASE_PROJECT_ID,
	FIREBASE_SERVICE_ACCOUNT,
	FIREBASE_SERVICE_ACCOUNT_FILE
} from '$app/env/private';
import { ApiError } from '#lib/server/api.ts';
import { log } from '#lib/server/log.ts';

export interface Viewer {
	uid: string;
	email: string | null;
	name: string | null;
	picture: string | null;
}

export interface WebConfig {
	apiKey: string;
	authDomain: string;
	projectId: string;
	appId?: string;
}

export const SESSION_MAX_AGE_SECONDS = 5 * 24 * 60 * 60;
// An ID token older than this is refused for a session: it may have been replayed.
const FRESH_SECONDS = 5 * 60;

export const signInEnabled = Boolean(
	FIREBASE_WEB_API_KEY && (FIREBASE_SERVICE_ACCOUNT_FILE || FIREBASE_SERVICE_ACCOUNT)
);

export function webConfig(): WebConfig | null {
	if (!signInEnabled) return null;
	return {
		apiKey: FIREBASE_WEB_API_KEY!,
		authDomain: FIREBASE_AUTH_DOMAIN,
		projectId: FIREBASE_PROJECT_ID,
		...(FIREBASE_APP_ID && { appId: FIREBASE_APP_ID })
	};
}

let app: App | undefined;

function admin(): App {
	if (app) return app;
	const json = FIREBASE_SERVICE_ACCOUNT_FILE
		? readFileSync(FIREBASE_SERVICE_ACCOUNT_FILE, 'utf8')
		: FIREBASE_SERVICE_ACCOUNT;
	if (!json?.trim()) throw new ApiError(503, 'sign-in is not configured');
	app =
		getApps()[0] ??
		initializeApp({ credential: cert(JSON.parse(json)), projectId: FIREBASE_PROJECT_ID });
	return app;
}

function toViewer(claims: {
	uid: string;
	email?: string;
	name?: string;
	picture?: string;
}): Viewer {
	return {
		uid: claims.uid,
		email: claims.email ?? null,
		name: claims.name ?? null,
		picture: claims.picture ?? null
	};
}

// Codes that say the token itself is bad; any other failure is Firebase being unreachable or broken.
const TOKEN_INVALID_CODES = new Set([
	'auth/id-token-expired',
	'auth/id-token-revoked',
	'auth/session-cookie-expired',
	'auth/session-cookie-revoked',
	'auth/argument-error',
	'auth/invalid-id-token',
	'auth/invalid-session-cookie',
	'auth/user-disabled'
]);

function failVerification(error: unknown): null {
	const code = (error as { code?: unknown } | null)?.code;
	if (typeof code === 'string' && TOKEN_INVALID_CODES.has(code)) return null;
	log('identity.error', { error: (error as Error)?.message });
	throw new ApiError(503, 'sign-in is unavailable; retry shortly');
}

// A verified token is trusted for a few seconds, so a burst of requests costs one revocation check.
const VERIFY_CACHE_MS = 5000;
const CACHE_PRUNE_ABOVE = 5000;
const verified = new Map<string, { viewer: Viewer; until: number }>();

const cacheKey = (kind: string, token: string) =>
	`${kind}:${createHash('sha256').update(token).digest('hex')}`;

function cached(key: string): Viewer | undefined {
	const hit = verified.get(key);
	if (!hit) return undefined;
	if (hit.until > Date.now()) return hit.viewer;
	verified.delete(key);
	return undefined;
}

// Bumped by every forget(); a verify that began before its user's last forget() must not cache.
let epoch = 0;
const forgotten = new Map<string, number>();

function remember(key: string, viewer: Viewer, startedAt: number): void {
	if ((forgotten.get(viewer.uid) ?? 0) > startedAt) return;
	if (verified.size > CACHE_PRUNE_ABOVE) {
		for (const [k, v] of verified) if (v.until <= Date.now()) verified.delete(k);
	}
	verified.set(key, { viewer, until: Date.now() + VERIFY_CACHE_MS });
}

function forget(uid: string): void {
	forgotten.set(uid, ++epoch);
	for (const [key, hit] of verified) if (hit.viewer.uid === uid) verified.delete(key);
}

/** Exchanges a freshly issued Firebase ID token for a session cookie value. */
export async function createSession(idToken: string): Promise<{ cookie: string; viewer: Viewer }> {
	if (!signInEnabled) throw new ApiError(503, 'sign-in is not configured');
	const auth = getAuth(admin());
	let claims;
	try {
		claims = await auth.verifyIdToken(idToken, true);
	} catch (error) {
		failVerification(error);
		throw new ApiError(401, 'invalid ID token');
	}
	if (claims.firebase?.sign_in_provider === 'custom') {
		throw new ApiError(403, 'a tool login cannot start a browser session');
	}
	if (Date.now() / 1000 - claims.auth_time > FRESH_SECONDS) {
		throw new ApiError(401, 'sign in again: the ID token is too old');
	}
	const cookie = await auth.createSessionCookie(idToken, {
		expiresIn: SESSION_MAX_AGE_SECONDS * 1000
	});
	return { cookie, viewer: toViewer(claims) };
}

/** The signed-in user a session cookie names, or null when it is forged, expired or revoked. Throws 503 when Firebase cannot answer. */
export async function verifySession(cookie: string): Promise<Viewer | null> {
	if (!signInEnabled) return null;
	const key = cacheKey('session', cookie);
	const hit = cached(key);
	if (hit) return hit;
	const startedAt = epoch;
	try {
		const viewer = toViewer(await getAuth(admin()).verifySessionCookie(cookie, true));
		remember(key, viewer, startedAt);
		return viewer;
	} catch (error) {
		return failVerification(error);
	}
}

const ID_TOKEN = /^eyJ[\w-]*\.[\w-]+\.[\w-]*$/;

/** True for a Firebase ID token, which is how a tool authenticates; a write key never has this shape. */
export const isIdToken = (value: string | undefined): value is string =>
	value !== undefined && ID_TOKEN.test(value);

/** The user an ID token names, or null when it is forged, expired or its refresh tokens were revoked. Throws 503 when Firebase cannot answer. */
export async function verifyBearer(idToken: string): Promise<Viewer | null> {
	if (!signInEnabled) return null;
	const key = cacheKey('bearer', idToken);
	const hit = cached(key);
	if (hit) return hit;
	const startedAt = epoch;
	try {
		const viewer = toViewer(await getAuth(admin()).verifyIdToken(idToken, true));
		remember(key, viewer, startedAt);
		return viewer;
	} catch (error) {
		return failVerification(error);
	}
}

/** A one-hour token the tool trades for a refresh token at Firebase. */
export async function customTokenFor(uid: string): Promise<string> {
	if (!signInEnabled) throw new ApiError(503, 'sign-in is not configured');
	return getAuth(admin()).createCustomToken(uid);
}

/** Invalidates every refresh token of the user: every browser session and connected tool must sign in again. */
export async function revokeTools(uid: string): Promise<void> {
	if (!signInEnabled) throw new ApiError(503, 'sign-in is not configured');
	await getAuth(admin()).revokeRefreshTokens(uid);
	forget(uid);
}
