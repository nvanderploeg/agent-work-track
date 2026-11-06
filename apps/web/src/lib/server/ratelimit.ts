import { isUnder } from '#lib/server/path.ts';

export type Verdict = { ok: true } | { ok: false; retryAfterMs: number };

interface Bucket {
	tokens: number;
	at: number;
}

const PRUNE_ABOVE = 10_000;

// A token bucket per key: `perWindow` writes at once, refilled at `perWindow` every `windowMs`.
// 0 disables it.
export function createRateLimiter(perWindow: number, windowMs: number) {
	const buckets = new Map<string, Bucket>();
	const perMs = perWindow / windowMs;

	function refilled(bucket: Bucket, now: number): number {
		return Math.min(perWindow, bucket.tokens + (now - bucket.at) * perMs);
	}

	function prune(now: number): void {
		for (const [key, bucket] of buckets) {
			if (refilled(bucket, now) >= perWindow) buckets.delete(key);
		}
	}

	return {
		take(key: string, now = Date.now()): Verdict {
			if (perWindow <= 0) return { ok: true };
			const bucket = buckets.get(key);
			const tokens = bucket ? refilled(bucket, now) : perWindow;
			if (tokens < 1) {
				return { ok: false, retryAfterMs: Math.ceil((1 - tokens) / perMs) };
			}
			buckets.set(key, { tokens: tokens - 1, at: now });
			if (buckets.size > PRUNE_ABOVE) prune(now);
			return { ok: true };
		},
		get size() {
			return buckets.size;
		}
	};
}

const WRITE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

export function limitWrites(
	limiter: ReturnType<typeof createRateLimiter>,
	event: { request: Request; url: URL; getClientAddress: () => string }
): Response | undefined {
	if (!WRITE_METHODS.has(event.request.method) || !isUnder(event.url.pathname, '/api')) {
		return undefined;
	}
	const verdict = limiter.take(event.getClientAddress());
	if (verdict.ok) return undefined;
	return Response.json(
		{ error: 'too many writes from this address; retry later' },
		{ status: 429, headers: { 'retry-after': String(Math.ceil(verdict.retryAfterMs / 1000)) } }
	);
}
