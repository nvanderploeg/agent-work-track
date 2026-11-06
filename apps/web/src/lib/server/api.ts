import { isObject } from '#lib/server/config.ts';

export class ApiError extends Error {
	readonly status: number;
	readonly body: Record<string, unknown>;

	constructor(status: number, error: string, extra: Record<string, unknown> = {}) {
		super(error);
		this.status = status;
		this.body = { error, ...extra };
	}
}

// Client errors are returned, never thrown, so handlers stay callable with a bare event object.
export function route<E>(
	handler: (event: E) => Promise<Response>
): (event: E) => Promise<Response> {
	return async (event) => {
		try {
			return await handler(event);
		} catch (error) {
			if (error instanceof ApiError) return Response.json(error.body, { status: error.status });
			throw error;
		}
	};
}

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function parseId(value: string | undefined, what: string): string {
	if (value === undefined || !UUID_V4.test(value)) throw new ApiError(400, `malformed ${what} id`);
	return value.toLowerCase();
}

const BODY_MAX_BYTES = 4 * 1024 * 1024;

/** Reads the body as text, refusing past `max` bytes however it arrives (Content-Length or chunked). */
export async function readText(request: Request, max = BODY_MAX_BYTES): Promise<string> {
	if (Number(request.headers.get('content-length') ?? 0) > max) {
		throw new ApiError(413, 'request body too large');
	}
	if (!request.body) return '';
	const reader = request.body.getReader();
	const parts: Uint8Array[] = [];
	let total = 0;
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		total += value.length;
		if (total > max) {
			await reader.cancel().catch(() => {});
			throw new ApiError(413, 'request body too large');
		}
		parts.push(value);
	}
	return Buffer.concat(parts).toString('utf8');
}

export async function readBody(request: Request): Promise<Record<string, unknown>> {
	const text = await readText(request);
	if (text.trim() === '') return {};
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		throw new ApiError(400, 'malformed JSON body');
	}
	if (!isObject(parsed)) throw new ApiError(400, 'body must be a JSON object');
	return parsed;
}
