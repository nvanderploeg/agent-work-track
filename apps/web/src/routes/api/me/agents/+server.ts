import type { RequestHandler } from './$types';
import { route } from '#lib/server/api.ts';
import { bearer, requireBearerUser } from '#lib/server/device.ts';
import { requireSameOrigin, requireViewer, signOutEverywhere } from '#lib/server/viewer.ts';

/** Signs out every agent of the user: by ID token bearer from a tool, else by session cookie. */
export const DELETE: RequestHandler = route(async ({ request, url }) => {
	if (bearer(request)) {
		await signOutEverywhere((await requireBearerUser(request)).uid);
	} else {
		requireSameOrigin(request, url);
		await signOutEverywhere((await requireViewer(request)).uid);
	}
	return Response.json({ ok: true });
});
