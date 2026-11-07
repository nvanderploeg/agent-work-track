import type { RequestHandler } from './$types';
import { ApiError, parseId, readBody, route } from '#lib/server/api.ts';
import { isOwner } from '#lib/server/access.ts';
import { endStreams } from '#lib/server/stream.ts';
import { getProjectRow, getTaskRow, setTaskPublic } from '#lib/server/store.ts';
import { requireSameOrigin, requireViewer } from '#lib/server/viewer.ts';

export const PATCH: RequestHandler = route(async ({ request, params, url }) => {
	requireSameOrigin(request, url);
	const viewer = await requireViewer(request);
	const taskId = parseId(params.taskId, 'task');
	const task = await getTaskRow(taskId);
	const project = task && (await getProjectRow(task.projectId));
	if (!task || !project || !isOwner(project, viewer)) throw new ApiError(404, 'task not found');
	const { public: value } = await readBody(request);
	if (typeof value !== 'boolean') throw new ApiError(400, 'public must be a boolean');
	const updated = await setTaskPublic(project.id, taskId, value);
	if (!value) endStreams(project.id);
	return Response.json({ task: updated });
});
