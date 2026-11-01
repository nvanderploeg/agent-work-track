import type { RequestHandler } from './$types';
import { parseId, readBody, route } from '#lib/server/api.ts';
import { authorizeTask } from '#lib/server/auth.ts';
import { addImage } from '#lib/server/store.ts';
import { parseImageBody } from '#lib/server/validate.ts';

export const POST: RequestHandler = route(async ({ request, params }) => {
	const taskId = parseId(params.taskId, 'task');
	const { project } = await authorizeTask(request, taskId);
	const image = await addImage(project.id, taskId, parseImageBody(await readBody(request)));
	return Response.json({ image }, { status: 201 });
});
