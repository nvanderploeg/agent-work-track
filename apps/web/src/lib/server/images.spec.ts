import { describe, it, expect } from 'vitest';
import { createImageCache } from '#lib/server/images.ts';
import { jpegSize } from '#lib/server/jpeg.ts';
import { fakeJpeg } from '#lib/server/test/jpeg.ts';
import type { ChronicleEvent } from '#lib/types.ts';

const MIN = 60_000;

function setup(budgetBytes = 1_000_000) {
	let clock = 0;
	const cache = createImageCache({
		budgetBytes,
		finishedMs: 10 * MIN,
		idleMs: 30 * MIN,
		now: () => clock
	});
	const put = (id: string, taskId = 'task-a', size = 100, finishedAt: string | null = null) =>
		cache.put({ id, projectId: 'p', taskId, thumb: Buffer.alloc(size), full: null }, finishedAt);
	const advance = (ms: number) => (clock += ms);
	const at = () => new Date(clock).toISOString();
	return { cache, put, advance, at };
}

function taskEvent(taskId: string, finishedAt: string | null): ChronicleEvent {
	return {
		seq: 1,
		type: 'task',
		taskId,
		path: null,
		payload: { id: taskId, finishedAt } as never,
		at: ''
	};
}

function nodeEvent(taskId: string): ChronicleEvent {
	return { seq: 1, type: 'node', taskId, path: 'a', payload: {} as never, at: '' };
}

describe('image cache expiry', () => {
	it('drops an unfinished task’s images 30 minutes after its last event', () => {
		const { cache, put, advance } = setup();
		put('i1');
		advance(29 * MIN);
		cache.observe(nodeEvent('task-a'));
		advance(29 * MIN);
		expect(cache.get('i1', 'thumb')).not.toBeNull();
		advance(MIN);
		expect(cache.get('i1', 'thumb')).toBeNull();
	});

	it('drops a finished task’s images 10 minutes after finishedAt', () => {
		const { cache, put, advance, at } = setup();
		put('i1');
		advance(MIN);
		cache.observe(taskEvent('task-a', at()));
		advance(10 * MIN - 1);
		expect(cache.get('i1', 'thumb')).not.toBeNull();
		advance(1);
		expect(cache.get('i1', 'thumb')).toBeNull();
	});

	it('uses the finished rule for an image uploaded to an already finished task', () => {
		const { cache, put, advance, at } = setup();
		const finishedAt = at();
		advance(5 * MIN);
		put('i1', 'task-a', 100, finishedAt);
		advance(5 * MIN);
		expect(cache.get('i1', 'thumb')).toBeNull();
	});

	it('falls back to the idle rule when a task leaves its final state', () => {
		const { cache, put, advance, at } = setup();
		put('i1');
		cache.observe(taskEvent('task-a', at()));
		advance(5 * MIN);
		cache.observe(taskEvent('task-a', null));
		advance(20 * MIN);
		expect(cache.get('i1', 'thumb')).not.toBeNull();
	});

	it('sweeps every image of an expired task and frees its bytes', () => {
		const { cache, put, advance } = setup();
		put('i1');
		put('i2');
		put('i3', 'task-b');
		advance(20 * MIN);
		cache.observe(nodeEvent('task-b'));
		advance(10 * MIN);
		cache.sweep();
		expect(cache.size).toBe(1);
		expect(cache.bytes).toBe(100);
		expect(cache.get('i3', 'thumb')).not.toBeNull();
	});
});

describe('image cache budget', () => {
	it('evicts the oldest images once the budget is exceeded', () => {
		const { cache, put } = setup(250);
		put('i1');
		put('i2', 'task-b');
		put('i3');
		expect(cache.get('i1', 'thumb')).toBeNull();
		expect(cache.get('i2', 'thumb')).not.toBeNull();
		expect(cache.get('i3', 'thumb')).not.toBeNull();
		expect(cache.bytes).toBe(200);
	});

	it('counts the full view against the budget', () => {
		const { cache } = setup();
		cache.put(
			{ id: 'i1', projectId: 'p', taskId: 't', thumb: Buffer.alloc(10), full: Buffer.alloc(30) },
			null
		);
		expect(cache.bytes).toBe(40);
		expect(cache.get('i1', 'full')?.length).toBe(30);
		cache.drop('i1');
		expect(cache.bytes).toBe(0);
	});
});

describe('jpegSize', () => {
	it('reads width and height from the frame header past other segments', () => {
		expect(jpegSize(fakeJpeg(320, 200, 40))).toEqual({ width: 320, height: 200 });
	});

	it.each([
		['not a JPEG', Buffer.from('GIF89a')],
		['a truncated header', fakeJpeg(10, 10).subarray(0, 10)],
		['a zero width', fakeJpeg(0, 10)]
	])('rejects %s', (_, data) => {
		expect(jpegSize(data)).toBeNull();
	});
});
