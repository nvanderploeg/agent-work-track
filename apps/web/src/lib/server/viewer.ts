import { AUTH_COOKIE_DOMAIN } from '$app/env/private';
import { ApiError } from '#lib/server/api.ts';
import { revokeTools, verifySession, type Viewer } from '#lib/server/identity.ts';
import { log } from '#lib/server/log.ts';
import { publicOrigin } from '#lib/server/origin.ts';
import { endUserStreams } from '#lib/server/stream.ts';
import { recordUser } from '#lib/server/users.ts';

// Same name and Domain in sagas, chronicle and beryl: one sign-in covers all three.
export const SESSION_COOKIE = 'runestone_session';

function cookieValue(request: Request, name: string): string | undefined {
	for (const part of (request.headers.get('cookie') ?? '').split(';')) {
		const at = part.indexOf('=');
		if (at > 0 && part.slice(0, at).trim() === name) return part.slice(at + 1).trim();
	}
	return undefined;
}

export function hasSessionCookie(request: Request): boolean {
	return cookieValue(request, SESSION_COOKIE) !== undefined;
}

// Clearing must repeat the Domain the cookie was set with, or the browser keeps it.
export function sessionCookieHeader(
	value: string,
	maxAge: number,
	url: URL,
	domain: string | undefined = AUTH_COOKIE_DOMAIN
): string {
	const secure = publicOrigin(url).startsWith('https:');
	return `${SESSION_COOKIE}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${domain ? `; Domain=${domain}` : ''}${secure ? '; Secure' : ''}`;
}

/** The signed-in user behind the request's session cookie, or null. */
export async function viewerOf(request: Request): Promise<Viewer | null> {
	const cookie = cookieValue(request, SESSION_COOKIE);
	const viewer = cookie ? await verifySession(cookie) : null;
	if (viewer) await recordUser(viewer);
	return viewer;
}

/** For endpoints that act as the signed-in user: 401 without a session. */
export async function requireViewer(request: Request): Promise<Viewer> {
	const viewer = await viewerOf(request);
	if (!viewer) throw new ApiError(401, 'sign in required');
	return viewer;
}

/** A state-changing request on a cookie session must come from this site's own pages. */
export function requireSameOrigin(request: Request, url: URL): void {
	if (request.headers.get('origin') !== publicOrigin(url)) {
		throw new ApiError(403, 'cross-origin request refused');
	}
}

/** Signs the user out everywhere: every session and tool must authenticate again, and open streams end. */
export async function signOutEverywhere(uid: string): Promise<void> {
	try {
		await revokeTools(uid);
	} finally {
		endUserStreams(uid);
	}
}

/** Signs out the session cookie's user everywhere. Never throws: the caller clears the cookie regardless. */
export async function endSession(request: Request): Promise<void> {
	const cookie = cookieValue(request, SESSION_COOKIE);
	if (!cookie) return;
	try {
		const viewer = await verifySession(cookie);
		if (viewer) await signOutEverywhere(viewer.uid);
	} catch (error) {
		log('session.revoke_failed', { error: (error as Error).message });
	}
}
