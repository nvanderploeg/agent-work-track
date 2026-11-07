import type { RequestHandler } from './$types';
import { ApiError, readBody, route } from '#lib/server/api.ts';
import { createProject } from '#lib/server/projects.ts';
import { bearer, isApiToken, ownerOfToken } from '#lib/server/tokens.ts';

// An API token makes an owned Project; any other (or no) credential makes an anonymous one.
export const POST: RequestHandler = route(async ({ request, url, getClientAddress }) => {
	const token = bearer(request);
	let ownerUid: string | null = null;
	if (isApiToken(token)) {
		const owner = await ownerOfToken(token);
		if (!owner) throw new ApiError(403, 'invalid token');
		ownerUid = owner.uid;
	}
	return createProject(await readBody(request), url, getClientAddress(), ownerUid);
});
