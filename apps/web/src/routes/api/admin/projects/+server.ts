import type { RequestHandler } from './$types';
import { adminOnly } from '#lib/server/admin/auth.ts';
import { listProjects } from '#lib/server/admin/portal.ts';
import { route } from '#lib/server/api.ts';

export const GET: RequestHandler = adminOnly(
	route(async () =>
		Response.json({ projects: await listProjects() }, { headers: { 'cache-control': 'no-store' } })
	)
);
