import type { RequestHandler } from './$types';
import { ApiError, readBody, route } from '#lib/server/api.ts';
import { publicOrigin } from '#lib/server/origin.ts';
import { DEVICE_POLL_SECONDS, DEVICE_TTL_MS, startDevice } from '#lib/server/device.ts';

export const POST: RequestHandler = route(async ({ request, url }) => {
	const { label } = await readBody(request);
	if (label !== undefined && (typeof label !== 'string' || label.length > 100)) {
		throw new ApiError(400, 'label must be a string of at most 100 characters');
	}
	const { deviceCode, userCode } = await startDevice(label?.trim() || 'chronicle');
	return Response.json(
		{
			deviceCode,
			userCode,
			verificationUrl: `${publicOrigin(url)}/device?code=${userCode}`,
			expiresIn: DEVICE_TTL_MS / 1000,
			interval: DEVICE_POLL_SECONDS
		},
		{ status: 201, headers: { 'cache-control': 'no-store' } }
	);
});
