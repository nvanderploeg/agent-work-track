import type { RequestHandler } from './$types';
import { ApiError, parseId, route } from '#lib/server/api.ts';
import { revokeToken } from '#lib/server/tokens.ts';
import { requireSameOrigin, requireViewer } from '#lib/server/viewer.ts';

export const DELETE: RequestHandler = route(async ({ request, params, url }) => {
	requireSameOrigin(request, url);
	const viewer = await requireViewer(request);
	if (!(await revokeToken(viewer.uid, parseId(params.id, 'token')))) {
		throw new ApiError(404, 'token not found');
	}
	return Response.json({ ok: true });
});
