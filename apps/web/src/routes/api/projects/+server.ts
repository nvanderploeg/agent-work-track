import type { RequestHandler } from './$types';
import { ApiError, readBody, route } from '#lib/server/api.ts';
import { bearer, bearerUser } from '#lib/server/device.ts';
import { isIdToken } from '#lib/server/identity.ts';
import { createProject } from '#lib/server/projects.ts';

// A Firebase ID token bearer makes an owned Project; any other (or no) credential makes an anonymous one.
export const POST: RequestHandler = route(async ({ request, url, getClientAddress }) => {
	let ownerUid: string | null = null;
	if (isIdToken(bearer(request))) {
		const user = await bearerUser(request);
		if (!user) throw new ApiError(403, 'invalid token');
		ownerUid = user.uid;
	}
	return createProject(await readBody(request), url, getClientAddress(), ownerUid);
});
