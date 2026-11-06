import type { RequestHandler } from './$types';
import { adminOnly } from '#lib/server/admin/auth.ts';
import { deleteProject } from '#lib/server/admin/portal.ts';
import { parseId, readBody, route } from '#lib/server/api.ts';

export const DELETE: RequestHandler = adminOnly(
	route(async ({ request, params }) => {
		const body = await readBody(request);
		return Response.json(await deleteProject(parseId(params.id, 'project'), body.confirm));
	})
);
