import type { RequestHandler } from './$types';
import { ApiError, route } from '#lib/server/api.ts';
import { bearer, limitPoll, pollDevice } from '#lib/server/device.ts';
import { webConfig } from '#lib/server/identity.ts';

const noStore = { 'cache-control': 'no-store' };

export const POST: RequestHandler = route(async ({ request, getClientAddress }) => {
	limitPoll(getClientAddress());
	const deviceCode = bearer(request);
	if (!deviceCode) throw new ApiError(401, 'missing device code');
	const result = await pollDevice(deviceCode);
	if (result.status === 'gone') {
		throw new ApiError(410, 'the login expired or was denied; start again');
	}
	if (result.status === 'pending') {
		return Response.json({ status: 'pending' }, { status: 202, headers: noStore });
	}
	return Response.json(
		{ status: 'approved', customToken: result.customToken, apiKey: webConfig()?.apiKey },
		{ headers: noStore }
	);
});
