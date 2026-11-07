import { readFileSync } from 'node:fs';
import { cert, getApps, initializeApp, type App } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import {
	FIREBASE_API_KEY,
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
}

export const SESSION_MAX_AGE_SECONDS = 5 * 24 * 60 * 60;
// An ID token older than this is refused for a session: it may have been replayed.
const FRESH_SECONDS = 5 * 60;

export const signInEnabled = Boolean(
	FIREBASE_API_KEY && (FIREBASE_SERVICE_ACCOUNT_FILE || FIREBASE_SERVICE_ACCOUNT)
);

export function webConfig(): WebConfig | null {
	if (!signInEnabled) return null;
	return {
		apiKey: FIREBASE_API_KEY!,
		authDomain: FIREBASE_AUTH_DOMAIN ?? `${FIREBASE_PROJECT_ID}.firebaseapp.com`,
		projectId: FIREBASE_PROJECT_ID
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

/** Exchanges a freshly issued Firebase ID token for a session cookie value. */
export async function createSession(idToken: string): Promise<{ cookie: string; viewer: Viewer }> {
	if (!signInEnabled) throw new ApiError(503, 'sign-in is not configured');
	const auth = getAuth(admin());
	let claims;
	try {
		claims = await auth.verifyIdToken(idToken);
	} catch {
		throw new ApiError(401, 'invalid ID token');
	}
	if (Date.now() / 1000 - claims.auth_time > FRESH_SECONDS) {
		throw new ApiError(401, 'sign in again: the ID token is too old');
	}
	const cookie = await auth.createSessionCookie(idToken, {
		expiresIn: SESSION_MAX_AGE_SECONDS * 1000
	});
	return { cookie, viewer: toViewer(claims) };
}

/** The signed-in user a session cookie names, or null when it is forged, expired or unconfigured. */
export async function verifySession(cookie: string): Promise<Viewer | null> {
	if (!signInEnabled) return null;
	try {
		return toViewer(await getAuth(admin()).verifySessionCookie(cookie));
	} catch (error) {
		const code = (error as { code?: unknown }).code;
		if (typeof code !== 'string' || !code.startsWith('auth/')) {
			log('identity.error', { error: (error as Error).message });
		}
		return null;
	}
}
