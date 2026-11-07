import type { RequestHandler } from './$types';
import { ApiError, readBody, route } from '#lib/server/api.ts';
import { answerDevice, deviceByUserCode } from '#lib/server/tokens.ts';
import { requireSameOrigin, requireViewer } from '#lib/server/viewer.ts';

export const GET: RequestHandler = route(async ({ request, url }) => {
	await requireViewer(request);
	const row = await deviceByUserCode(url.searchParams.get('code') ?? '');
	if (!row || row.ownerUid) throw new ApiError(404, 'no pending login for that code');
	return Response.json(
		{ label: row.label, expiresAt: row.expiresAt.toISOString() },
		{ headers: { 'cache-control': 'no-store' } }
	);
});

export const POST: RequestHandler = route(async ({ request, url }) => {
	requireSameOrigin(request, url);
	const viewer = await requireViewer(request);
	const { userCode, approve } = await readBody(request);
	if (typeof userCode !== 'string' || typeof approve !== 'boolean') {
		throw new ApiError(400, 'userCode and approve are required');
	}
	if (!(await answerDevice(userCode, approve ? viewer.uid : null))) {
		throw new ApiError(404, 'no pending login for that code');
	}
	return Response.json({ ok: true });
});
