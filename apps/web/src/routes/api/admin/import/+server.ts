import { rm } from 'node:fs/promises';
import type { RequestHandler } from './$types';
import { ADMIN_MAX_BUNDLE_MB } from '$app/env/private';
import { adminOnly } from '#lib/server/admin/auth.ts';
import { importBundle, receiveUpload } from '#lib/server/admin/bundle.ts';
import { ApiError, route } from '#lib/server/api.ts';

const CONFIRM = 'replace-everything';

export const POST: RequestHandler = adminOnly(
	route(async ({ request, url }) => {
		if (url.searchParams.get('confirm') !== CONFIRM) {
			throw new ApiError(400, `add ?confirm=${CONFIRM} to replace the whole database`);
		}
		const { dir, path } = await receiveUpload(request, ADMIN_MAX_BUNDLE_MB * 1024 * 1024);
		try {
			return Response.json(
				await importBundle(path, { allowEmpty: url.searchParams.get('allow-empty') === '1' })
			);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	})
);
