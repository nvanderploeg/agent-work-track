import type { RequestHandler } from './$types';
import { route } from '#lib/server/api.ts';
import { bearer, requireBearerUser } from '#lib/server/device.ts';
import { revokeTools } from '#lib/server/identity.ts';
import { requireSameOrigin, requireViewer } from '#lib/server/viewer.ts';

/** Signs out every agent of the user: by ID token bearer from a tool, else by session cookie. */
export const DELETE: RequestHandler = route(async ({ request, url }) => {
	if (bearer(request)) {
		await revokeTools((await requireBearerUser(request)).uid);
	} else {
		requireSameOrigin(request, url);
		await revokeTools((await requireViewer(request)).uid);
	}
	return Response.json({ ok: true });
});
