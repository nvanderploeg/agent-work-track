import type { RequestHandler } from './$types';
import { route } from '#lib/server/api.ts';
import { requireToken, revokeToken } from '#lib/server/tokens.ts';

/** A token revokes itself: what `chronicle logout` calls. */
export const DELETE: RequestHandler = route(async ({ request }) => {
	const owner = await requireToken(request);
	await revokeToken(owner.uid, owner.id);
	return Response.json({ ok: true });
});
