import type { RequestHandler } from './$types';
import { route } from '#lib/server/api.ts';
import { revokeTools } from '#lib/server/identity.ts';
import { requireSameOrigin, requireViewer } from '#lib/server/viewer.ts';

/** Disconnects every tool the signed-in user connected. */
export const DELETE: RequestHandler = route(async ({ request, url }) => {
	requireSameOrigin(request, url);
	await revokeTools((await requireViewer(request)).uid);
	return Response.json({ ok: true });
});
