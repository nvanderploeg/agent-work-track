import type { RequestHandler } from './$types';
import { readBody, route } from '#lib/server/api.ts';
import { createProject } from '#lib/server/projects.ts';
import { ownedProjects } from '#lib/server/store.ts';
import { toProject, toTask } from '#lib/server/serialize.ts';
import { requireSameOrigin, requireViewer } from '#lib/server/viewer.ts';

export const GET: RequestHandler = route(async ({ request }) => {
	const viewer = await requireViewer(request);
	const owned = await ownedProjects(viewer.uid);
	return Response.json(
		{
			projects: owned.map(({ project, tasks }) => ({
				project: toProject(project),
				tasks: tasks.map(toTask)
			}))
		},
		{ headers: { 'cache-control': 'no-store' } }
	);
});

export const POST: RequestHandler = route(async ({ request, url, getClientAddress }) => {
	requireSameOrigin(request, url);
	const viewer = await requireViewer(request);
	return createProject(await readBody(request), url, getClientAddress(), viewer.uid);
});
