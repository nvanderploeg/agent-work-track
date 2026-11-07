import { describe, expect, it } from 'vitest';
import { createRateLimiter, limitWrites } from './ratelimit.ts';

function takeMany(limiter: ReturnType<typeof createRateLimiter>, key: string, n: number, now = 0) {
	return Array.from({ length: n }, () => limiter.take(key, now));
}

const FIVE_MIN = 300_000;

describe('createRateLimiter', () => {
	it('allows a burst of perWindow writes at once, then refuses the next', () => {
		const limiter = createRateLimiter(120, FIVE_MIN);

		expect(takeMany(limiter, 'a', 120).every((v) => v.ok)).toBe(true);
		expect(limiter.take('a', 0)).toEqual({ ok: false, retryAfterMs: 2500 });
	});

	it('refills one write every windowMs/perWindow ms after the burst is spent', () => {
		const limiter = createRateLimiter(120, FIVE_MIN);
		takeMany(limiter, 'a', 120);

		expect(limiter.take('a', 2499).ok).toBe(false);
		expect(limiter.take('a', 2500).ok).toBe(true);
		expect(limiter.take('a', 2500).ok).toBe(false);
	});

	it('sustains perWindow writes a window and no more', () => {
		const limiter = createRateLimiter(120, FIVE_MIN);
		takeMany(limiter, 'a', 120);

		const allowed = Array.from({ length: 300 }, (_, s) => limiter.take('a', (s + 1) * 1000)).filter(
			(v) => v.ok
		);

		expect(allowed).toHaveLength(120);
	});

	it('never refills above the burst size after a long idle', () => {
		const limiter = createRateLimiter(120, FIVE_MIN);
		limiter.take('a', 0);

		const later = 60 * 60 * 1000;
		expect(takeMany(limiter, 'a', 120, later).every((v) => v.ok)).toBe(true);
		expect(limiter.take('a', later).ok).toBe(false);
	});

	it('keeps a separate bucket per key', () => {
		const limiter = createRateLimiter(2, FIVE_MIN);
		takeMany(limiter, 'a', 2);

		expect(limiter.take('a', 0).ok).toBe(false);
		expect(limiter.take('b', 0).ok).toBe(true);
	});

	it('allows everything when perWindow is 0', () => {
		const limiter = createRateLimiter(0, FIVE_MIN);

		expect(takeMany(limiter, 'a', 1000).every((v) => v.ok)).toBe(true);
		expect(limiter.size).toBe(0);
	});

	it('drops fully refilled buckets once it tracks more than 10000 keys', () => {
		const limiter = createRateLimiter(120, FIVE_MIN);
		for (let i = 0; i <= 10_000; i++) limiter.take(`old-${i}`, 0);

		limiter.take('new', FIVE_MIN);

		expect(limiter.size).toBe(1);
	});
});

describe('limitWrites', () => {
	const event = (method: string, path: string, address = '10.0.0.1') => ({
		request: new Request(`http://x${path}`, { method }),
		url: new URL(`http://x${path}`),
		getClientAddress: () => address
	});

	it('answers 429 with Retry-After in whole seconds once an address spends its writes', async () => {
		const limiter = createRateLimiter(1, 60_000);

		expect(limitWrites(limiter, event('PUT', '/api/tasks/t/nodes/a'))).toBeUndefined();
		const refused = limitWrites(limiter, event('PATCH', '/api/tasks/t'));

		expect(refused?.status).toBe(429);
		expect(refused?.headers.get('retry-after')).toBe('60');
		expect(await refused?.json()).toEqual({
			error: 'too many writes from this address; retry later'
		});
	});

	it('counts project creation as a write', () => {
		const limiter = createRateLimiter(1, 60_000);
		limitWrites(limiter, event('POST', '/api/projects'));

		expect(limitWrites(limiter, event('POST', '/api/projects'))?.status).toBe(429);
	});

	it('never limits reads, streams or pages', () => {
		const limiter = createRateLimiter(1, 60_000);
		limitWrites(limiter, event('POST', '/api/projects'));

		expect(limitWrites(limiter, event('GET', '/api/tasks/t'))).toBeUndefined();
		expect(limitWrites(limiter, event('GET', '/api/projects/p/stream'))).toBeUndefined();
		expect(limitWrites(limiter, event('GET', '/p/p'))).toBeUndefined();
	});

	it('never limits the device poll, which repeats until a login is approved', () => {
		const limiter = createRateLimiter(1, 60_000);
		limitWrites(limiter, event('POST', '/api/projects'));

		expect(limitWrites(limiter, event('POST', '/api/auth/device/token'))).toBeUndefined();
	});

	it('limits each client address on its own', () => {
		const limiter = createRateLimiter(1, 60_000);
		limitWrites(limiter, event('POST', '/api/projects', '10.0.0.1'));

		expect(limitWrites(limiter, event('POST', '/api/projects', '10.0.0.2'))).toBeUndefined();
	});
});
