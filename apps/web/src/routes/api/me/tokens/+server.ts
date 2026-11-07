import type { RequestHandler } from './$types';
import { route } from '#lib/server/api.ts';
import { listTokens } from '#lib/server/tokens.ts';
import { requireViewer } from '#lib/server/viewer.ts';

export const GET: RequestHandler = route(async ({ request }) => {
	const viewer = await requireViewer(request);
	return Response.json(
		{ tokens: await listTokens(viewer.uid) },
		{ headers: { 'cache-control': 'no-store' } }
	);
});
