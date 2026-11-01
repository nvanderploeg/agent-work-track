import type { RequestHandler } from './$types';
import { ApiError, parseId, route } from '#lib/server/api.ts';
import { imageCache, type ImageSize } from '#lib/server/images.ts';

const FILES: Record<string, ImageSize> = { 'thumb.jpg': 'thumb', 'full.jpg': 'full' };

export const GET: RequestHandler = route(async ({ params }) => {
	const id = parseId(params.imageId, 'image');
	const size = Object.hasOwn(FILES, params.file) ? FILES[params.file] : undefined;
	if (!size) throw new ApiError(404, 'not found');
	const data = imageCache.get(id, size);
	if (!data) throw new ApiError(404, 'image expired');
	return new Response(new Uint8Array(data), {
		headers: {
			'content-type': 'image/jpeg',
			'cache-control': 'private, max-age=604800, immutable'
		}
	});
});
