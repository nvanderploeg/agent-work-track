import { ApiError } from '#lib/server/api.ts';
import { verifySession, type Viewer } from '#lib/server/identity.ts';
import { publicOrigin } from '#lib/server/origin.ts';

export const SESSION_COOKIE = 'chronicle_session';

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

export function sessionCookieHeader(value: string, maxAge: number, url: URL): string {
	const secure = publicOrigin(url).startsWith('https:');
	return `${SESSION_COOKIE}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure ? '; Secure' : ''}`;
}

/** The signed-in user behind the request's session cookie, or null. */
export async function viewerOf(request: Request): Promise<Viewer | null> {
	const cookie = cookieValue(request, SESSION_COOKIE);
	return cookie ? verifySession(cookie) : null;
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
