import { Readable } from 'node:stream';
import type { RequestHandler } from './$types';
import { adminOnly } from '#lib/server/admin/auth.ts';
import { assertExportable, bundleName, exportBundle } from '#lib/server/admin/bundle.ts';
import { route } from '#lib/server/api.ts';
import { log } from '#lib/server/log.ts';

export const GET: RequestHandler = adminOnly(
	route(async () => {
		await assertExportable();
		log('admin.export');
		return new Response(Readable.toWeb(Readable.from(exportBundle())) as ReadableStream, {
			headers: {
				'content-type': 'application/zip',
				'content-disposition': `attachment; filename="${bundleName()}"`,
				'cache-control': 'no-store'
			}
		});
	})
);
