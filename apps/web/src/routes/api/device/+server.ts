import type { RequestHandler } from './$types';
import { ApiError, readBody, route } from '#lib/server/api.ts';
import { publicOrigin } from '#lib/server/origin.ts';
import {
	bearer,
	DEVICE_POLL_SECONDS,
	DEVICE_TTL_MS,
	pollDevice,
	startDevice
} from '#lib/server/tokens.ts';

const noStore = { 'cache-control': 'no-store' };

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
		{ status: 201, headers: noStore }
	);
});

// The poll is a GET so it stays outside the write limit; the device code travels as a bearer.
export const GET: RequestHandler = route(async ({ request }) => {
	const deviceCode = bearer(request);
	if (!deviceCode) throw new ApiError(401, 'missing device code');
	const result = await pollDevice(deviceCode);
	if (result.status === 'gone') {
		throw new ApiError(410, 'the login expired or was denied; start again');
	}
	if (result.status === 'pending') {
		return Response.json({ status: 'pending' }, { status: 202, headers: noStore });
	}
	return Response.json({ status: 'approved', token: result.token }, { headers: noStore });
});
