import type { RequestHandler } from './$types';
import { readBody, route } from '#lib/server/api.ts';
import { createProject } from '#lib/server/projects.ts';

export const POST: RequestHandler = route(async ({ request, url, getClientAddress }) =>
	createProject(await readBody(request), url, getClientAddress(), null)
);
