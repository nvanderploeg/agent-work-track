import type { RequestHandler } from './$types';
import { ApiError, route } from '#lib/server/api.ts';
import { webConfig } from '#lib/server/identity.ts';

export const GET: RequestHandler = route(async () => {
	const config = webConfig();
	if (!config) throw new ApiError(503, 'sign-in is not configured');
	return Response.json(config, { headers: { 'cache-control': 'no-store' } });
});
