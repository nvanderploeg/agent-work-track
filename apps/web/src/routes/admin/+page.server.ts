import { error } from '@sveltejs/kit';
import { adminAuth } from '#lib/server/admin/auth.ts';
import { listProjects, stats } from '#lib/server/admin/portal.ts';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals, setHeaders }) => {
	if (!adminAuth.enabled) error(404, 'Not Found');
	setHeaders({ 'cache-control': 'no-store' });
	if (!locals.admin) return { authed: false as const };
	return {
		authed: true as const,
		csrf: locals.admin.csrf,
		stats: await stats(),
		projects: await listProjects()
	};
};
