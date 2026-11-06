import type { RequestHandler } from './$types';
import { adminOnly } from '#lib/server/admin/auth.ts';
import { stats } from '#lib/server/admin/portal.ts';
import { route } from '#lib/server/api.ts';

export const GET: RequestHandler = adminOnly(
	route(async () => Response.json(await stats(), { headers: { 'cache-control': 'no-store' } }))
);
