import type { RequestHandler } from './$types';
import { ApiError, readBody, route } from '#lib/server/api.ts';
import { createSession, SESSION_MAX_AGE_SECONDS, webConfig } from '#lib/server/identity.ts';
import { sessionCookieHeader, requireSameOrigin, viewerOf } from '#lib/server/viewer.ts';

const noStore = { 'cache-control': 'no-store' };

export const GET: RequestHandler = route(async ({ request }) =>
	Response.json({ user: await viewerOf(request), firebase: webConfig() }, { headers: noStore })
);

export const POST: RequestHandler = route(async ({ request, url }) => {
	requireSameOrigin(request, url);
	const { idToken } = await readBody(request);
	if (typeof idToken !== 'string' || !idToken) throw new ApiError(400, 'idToken is required');
	const { cookie, viewer } = await createSession(idToken);
	return Response.json(
		{ user: viewer },
		{
			headers: {
				...noStore,
				'set-cookie': sessionCookieHeader(cookie, SESSION_MAX_AGE_SECONDS, url)
			}
		}
	);
});

export const DELETE: RequestHandler = route(async ({ request, url }) => {
	requireSameOrigin(request, url);
	return Response.json(
		{ ok: true },
		{ headers: { ...noStore, 'set-cookie': sessionCookieHeader('', 0, url) } }
	);
});
