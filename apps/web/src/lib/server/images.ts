import {
	CHRONICLE_IMAGE_CACHE_BYTES,
	CHRONICLE_IMAGE_FINISHED_MS,
	CHRONICLE_IMAGE_IDLE_MS
} from '$app/env/private';
import { subscribeAll } from '#lib/server/bus.ts';
import { log } from '#lib/server/log.ts';
import type { ChronicleEvent, Task } from '#lib/types.ts';

export type ImageSize = 'thumb' | 'full';
export type EvictReason = 'finished' | 'idle' | 'budget';

interface Entry {
	id: string;
	projectId: string;
	taskId: string;
	thumb: Buffer;
	full: Buffer | null;
}

interface TaskClock {
	lastActivity: number;
	finishedAt: number | null;
	images: number;
}

export interface ImageCacheOptions {
	budgetBytes: number;
	finishedMs: number;
	idleMs: number;
	now?: () => number;
}

export interface ImageCache {
	put(entry: Entry, finishedAt: string | null): void;
	get(id: string, size: ImageSize): Buffer | null;
	drop(id: string): void;
	observe(event: ChronicleEvent): void;
	sweep(): void;
	readonly bytes: number;
	readonly size: number;
}

const sizeOf = (entry: Entry) => entry.thumb.length + (entry.full?.length ?? 0);

export function createImageCache(options: ImageCacheOptions): ImageCache {
	const now = options.now ?? Date.now;
	const entries = new Map<string, Entry>();
	const clocks = new Map<string, TaskClock>();
	let bytes = 0;

	function expiresAt(clock: TaskClock): number {
		return clock.finishedAt !== null
			? clock.finishedAt + options.finishedMs
			: clock.lastActivity + options.idleMs;
	}

	function remove(entry: Entry, reason: EvictReason | null): void {
		if (!entries.delete(entry.id)) return;
		bytes -= sizeOf(entry);
		const clock = clocks.get(entry.taskId);
		if (clock && --clock.images === 0) clocks.delete(entry.taskId);
		if (reason) {
			log('image.evict', {
				project: entry.projectId,
				task: entry.taskId,
				image: entry.id,
				reason
			});
		}
	}

	function expireTask(taskId: string, clock: TaskClock): void {
		const reason = clock.finishedAt !== null ? 'finished' : 'idle';
		for (const entry of [...entries.values()]) {
			if (entry.taskId === taskId) remove(entry, reason);
		}
	}

	function expired(clock: TaskClock): boolean {
		return now() >= expiresAt(clock);
	}

	return {
		put(entry, finishedAt) {
			const clock = clocks.get(entry.taskId) ?? {
				lastActivity: now(),
				finishedAt: null,
				images: 0
			};
			clock.lastActivity = now();
			clock.finishedAt = finishedAt === null ? null : Date.parse(finishedAt);
			clock.images++;
			clocks.set(entry.taskId, clock);
			entries.set(entry.id, entry);
			bytes += sizeOf(entry);
			for (const oldest of entries.values()) {
				if (bytes <= options.budgetBytes) break;
				remove(oldest, 'budget');
			}
		},
		get(id, size) {
			const entry = entries.get(id);
			if (!entry) return null;
			const clock = clocks.get(entry.taskId);
			if (clock && expired(clock)) {
				expireTask(entry.taskId, clock);
				return null;
			}
			return size === 'thumb' ? entry.thumb : entry.full;
		},
		drop(id) {
			const entry = entries.get(id);
			if (entry) remove(entry, null);
		},
		observe(event) {
			if (event.taskId === null) return;
			const clock = clocks.get(event.taskId);
			if (!clock) return;
			clock.lastActivity = now();
			if (event.type === 'task') {
				const finishedAt = (event.payload as Task).finishedAt;
				clock.finishedAt = finishedAt === null ? null : Date.parse(finishedAt);
			}
		},
		sweep() {
			for (const [taskId, clock] of [...clocks]) {
				if (expired(clock)) expireTask(taskId, clock);
			}
		},
		get bytes() {
			return bytes;
		},
		get size() {
			return entries.size;
		}
	};
}

const SWEEP_MS = 60_000;

export const imageCache = createImageCache({
	budgetBytes: CHRONICLE_IMAGE_CACHE_BYTES,
	finishedMs: CHRONICLE_IMAGE_FINISHED_MS,
	idleMs: CHRONICLE_IMAGE_IDLE_MS
});

subscribeAll((event) => imageCache.observe(event));
setInterval(() => imageCache.sweep(), SWEEP_MS).unref();
