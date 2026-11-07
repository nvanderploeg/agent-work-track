import type { RequestHandler } from './$types';
import { route } from '#lib/server/api.ts';
import { requireBearerUser } from '#lib/server/device.ts';
import { revokeTools } from '#lib/server/identity.ts';

/** Signs every tool of this user out: what `chronicle logout` calls. */
export const DELETE: RequestHandler = route(async ({ request }) => {
	await revokeTools((await requireBearerUser(request)).uid);
	return Response.json({ ok: true });
});
