import type { RequestHandler } from './$types';
import { parseId, route } from '#lib/server/api.ts';
import { readableTask } from '#lib/server/access.ts';
import { taskEvents } from '#lib/server/store.ts';
import { parsePath } from '#lib/server/validate.ts';

export const GET: RequestHandler = route(async ({ request, params, url }) => {
	const taskId = parseId(params.taskId, 'task');
	const path = url.searchParams.get('path');
	const filter = path === null ? undefined : parsePath(path).join('/');
	await readableTask(request, taskId);
	return Response.json({ events: await taskEvents(taskId, filter) });
});
