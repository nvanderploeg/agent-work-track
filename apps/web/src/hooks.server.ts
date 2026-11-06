import type { Handle, HandleServerError, ServerInit } from '@sveltejs/kit/hooks';
import { building } from '$app/env';
import { CHRONICLE_WRITE_WINDOW_MS, CHRONICLE_WRITES_PER_WINDOW } from '$app/env/private';
import { bootstrap } from '#lib/server/bootstrap.ts';
import { log } from '#lib/server/log.ts';
import { adminAuth } from '#lib/server/admin/auth.ts';
import { isImporting } from '#lib/server/admin/bundle.ts';
import { trackRequest } from '#lib/server/inflight.ts';
import { isUnder, pathVariants } from '#lib/server/path.ts';
import { createRateLimiter, limitWrites } from '#lib/server/ratelimit.ts';

const writes = createRateLimiter(CHRONICLE_WRITES_PER_WINDOW, CHRONICLE_WRITE_WINDOW_MS);

export const init: ServerInit = async () => {
	if (building) return;
	await bootstrap();
};

export const handle: Handle = async ({ event, resolve }) => {
	const gated = adminAuth.gate(event);
	if (gated) return gated;
	const refused = limitWrites(writes, event);
	if (refused) {
		log('ratelimit', {
			ip: event.getClientAddress(),
			method: event.request.method,
			path: event.url.pathname,
			retry_after: refused.headers.get('retry-after')
		});
		return refused;
	}
	if (
		isImporting() &&
		!event.locals.admin &&
		isUnder(event.url.pathname, '/api') &&
		!pathVariants(event.url.pathname).includes('/api/health')
	) {
		return Response.json(
			{ error: 'the server is importing a bundle; retry shortly' },
			{ status: 503, headers: { 'retry-after': '30' } }
		);
	}
	const finished =
		isUnder(event.url.pathname, '/api') && !event.locals.admin ? trackRequest() : () => {};
	let response: Response;
	try {
		response = await resolve(event);
	} finally {
		finished();
	}
	if (response.status >= 400 && event.url.pathname.startsWith('/api/')) {
		const body = await response
			.clone()
			.json()
			.catch(() => null);
		log('api.fail', {
			ip: event.getClientAddress(),
			method: event.request.method,
			path: event.url.pathname,
			status: response.status,
			error: typeof body?.error === 'string' ? body.error : undefined
		});
	}
	return response;
};

export const handleError: HandleServerError = ({ kind, error, event }) => {
	if (kind !== 'unknown') return;
	log('error', {
		method: event.request.method,
		path: event.url.pathname,
		error: error instanceof Error ? (error.stack ?? error.message) : String(error)
	});
};
