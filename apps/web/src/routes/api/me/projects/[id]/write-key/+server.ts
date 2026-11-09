import type { RequestHandler } from './$types';
import { ApiError, parseId, route } from '#lib/server/api.ts';
import { isOwner } from '#lib/server/access.ts';
import { generateWriteKey, hashWriteKey, unissuedKeyHash } from '#lib/server/auth.ts';
import { getProjectRow, setWriteKeyHash } from '#lib/server/store.ts';
import { requireSameOrigin, requireViewer } from '#lib/server/viewer.ts';

async function ownedBy(request: Request, url: URL, id: string | undefined): Promise<string> {
	requireSameOrigin(request, url);
	const viewer = await requireViewer(request);
	const projectId = parseId(id, 'project');
	const row = await getProjectRow(projectId);
	if (!row || !isOwner(row, viewer)) throw new ApiError(404, 'project not found');
	return projectId;
}

export const POST: RequestHandler = route(async ({ request, params, url }) => {
	const projectId = await ownedBy(request, url, params.id);
	const writeKey = generateWriteKey();
	await setWriteKeyHash(projectId, hashWriteKey(writeKey));
	return Response.json({ writeKey });
});

export const DELETE: RequestHandler = route(async ({ request, params, url }) => {
	const projectId = await ownedBy(request, url, params.id);
	await setWriteKeyHash(projectId, unissuedKeyHash());
	return Response.json({ ok: true });
});
