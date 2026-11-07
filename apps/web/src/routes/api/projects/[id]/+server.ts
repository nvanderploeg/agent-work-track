import type { RequestHandler } from './$types';
import { ApiError, parseId, readBody, route } from '#lib/server/api.ts';
import { readableProject } from '#lib/server/access.ts';
import { authorizeProject } from '#lib/server/auth.ts';
import { patchProject, snapshot } from '#lib/server/store.ts';
import { parseProjectPatch } from '#lib/server/validate.ts';

export const GET: RequestHandler = route(async ({ request, params }) => {
	const projectId = parseId(params.id, 'project');
	await readableProject(request, projectId);
	const result = await snapshot(projectId);
	if (!result) throw new ApiError(404, 'project not found');
	return Response.json(result);
});

export const PATCH: RequestHandler = route(async ({ request, params }) => {
	const projectId = parseId(params.id, 'project');
	await authorizeProject(request, projectId);
	const project = await patchProject(projectId, parseProjectPatch(await readBody(request)));
	return Response.json({ project });
});
