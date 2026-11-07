import type { RequestHandler } from './$types';
import { route } from '#lib/server/api.ts';
import { viewerOf } from '#lib/server/viewer.ts';

export const GET: RequestHandler = route(async ({ request }) =>
	Response.json({ user: await viewerOf(request) }, { headers: { 'cache-control': 'no-store' } })
);
