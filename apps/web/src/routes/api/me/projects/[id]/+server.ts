import type { RequestHandler } from './$types';
import { ApiError, parseId, readBody, route } from '#lib/server/api.ts';
import { isOwner } from '#lib/server/access.ts';
import { endStreams } from '#lib/server/stream.ts';
import { getProjectRow, setProjectPublic } from '#lib/server/store.ts';
import { requireSameOrigin, requireViewer } from '#lib/server/viewer.ts';

export const PATCH: RequestHandler = route(async ({ request, params, url }) => {
	requireSameOrigin(request, url);
	const viewer = await requireViewer(request);
	const projectId = parseId(params.id, 'project');
	const row = await getProjectRow(projectId);
	if (!row || !isOwner(row, viewer)) throw new ApiError(404, 'project not found');
	const { public: value } = await readBody(request);
	if (typeof value !== 'boolean') throw new ApiError(400, 'public must be a boolean');
	const project = await setProjectPublic(projectId, value);
	if (!value) endStreams(projectId);
	return Response.json({ project });
});
