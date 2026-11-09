import { CHRONICLE_HEARTBEAT_MS, CHRONICLE_IDLE_MS } from '$app/env/private';
import { subscribe } from '#lib/server/bus.ts';
import { eventsSince, getProjectRow, lastWriteAt } from '#lib/server/store.ts';
import type { ChronicleEvent } from '#lib/types.ts';

export interface StreamOptions {
	since?: number;
	idleMs?: number;
	heartbeatMs?: number;
	now?: () => number;
	/** Only this Task's events: for a viewer who may read just that Task. */
	taskId?: string;
	/** Forward Config changes to a Task-scoped stream; set only for a reader of the whole Project. */
	wholeProject?: boolean;
	/** The signed-in reader, so `endUserStreams` can end this stream. */
	uid?: string;
	onClose?: (reason: 'idle' | 'client' | 'error') => void;
}

const encoder = new TextEncoder();
const open = new Map<string, Set<(event: 'idle' | 'reset') => void>>();

/** Ends open streams, of one Project or all, with `event: reset`: a stream's `seq` means nothing once the rows beneath it were replaced. */
export function endStreams(projectId?: string): void {
	for (const [id, ends] of [...open]) {
		if (projectId === undefined || id === projectId) for (const end of [...ends]) end('reset');
	}
}

const openByUser = new Map<string, Set<(event: 'idle' | 'reset') => void>>();

/** Ends every open stream of one signed-in reader, after their sessions were revoked. */
export function endUserStreams(uid: string): void {
	for (const end of [...(openByUser.get(uid) ?? [])]) end('reset');
}

function frame(event: ChronicleEvent): string {
	return `id: ${event.seq}\nevent: ${event.type}\ndata: ${JSON.stringify(event.payload)}\n\n`;
}

export async function createProjectStream(
	projectId: string,
	options: StreamOptions = {}
): Promise<ReadableStream<Uint8Array> | null> {
	const now = options.now ?? Date.now;
	const idleMs = options.idleMs ?? CHRONICLE_IDLE_MS;
	const heartbeatMs = options.heartbeatMs ?? CHRONICLE_HEARTBEAT_MS;
	const { since } = options;

	if (!(await getProjectRow(projectId))) return null;

	const openedAt = now();
	const lastWrite = (await lastWriteAt(projectId))?.getTime() ?? 0;
	let deadline = Math.max(lastWrite, openedAt) + idleMs;

	let controller!: ReadableStreamDefaultController<Uint8Array>;
	let closed = false;
	let replaying = since !== undefined;
	let lastSeq = since ?? -1;
	const buffered: ChronicleEvent[] = [];
	let unsubscribe: (() => void) | undefined;
	let idleTimer: ReturnType<typeof setTimeout> | undefined;
	let heartbeatTimer: ReturnType<typeof setInterval> | undefined;

	function send(text: string): void {
		if (closed) return;
		try {
			controller.enqueue(encoder.encode(text));
		} catch {
			cleanup();
		}
	}

	function cleanup(reason: 'idle' | 'client' | 'error' = 'client'): void {
		if (!closed) options.onClose?.(reason);
		closed = true;
		open.get(projectId)?.delete(end);
		if (open.get(projectId)?.size === 0) open.delete(projectId);
		if (options.uid) {
			openByUser.get(options.uid)?.delete(end);
			if (openByUser.get(options.uid)?.size === 0) openByUser.delete(options.uid);
		}
		unsubscribe?.();
		unsubscribe = undefined;
		clearTimeout(idleTimer);
		clearInterval(heartbeatTimer);
	}

	function end(event: 'idle' | 'reset' = 'idle'): void {
		if (closed) return;
		send(`event: ${event}\ndata: {}\n\n`);
		cleanup('idle');
		try {
			controller.close();
		} catch {
			// already errored or cancelled
		}
	}

	function armIdle(): void {
		clearTimeout(idleTimer);
		idleTimer = setTimeout(() => end(), Math.max(0, deadline - now()));
	}

	function emit(event: ChronicleEvent): void {
		if (options.taskId !== undefined) {
			if (event.type === 'config' ? !options.wholeProject : event.taskId !== options.taskId) return;
		}
		if (event.seq <= lastSeq) return;
		lastSeq = event.seq;
		send(frame(event));
	}

	function onLive(event: ChronicleEvent): void {
		if (closed) return;
		deadline = now() + idleMs;
		armIdle();
		if (replaying) buffered.push(event);
		else emit(event);
	}

	return new ReadableStream<Uint8Array>({
		async start(c) {
			controller = c;
			if (!open.has(projectId)) open.set(projectId, new Set());
			open.get(projectId)!.add(end);
			if (options.uid) {
				if (!openByUser.has(options.uid)) openByUser.set(options.uid, new Set());
				openByUser.get(options.uid)!.add(end);
			}
			unsubscribe = subscribe(projectId, onLive);
			armIdle();
			send(': ok\n\n');
			try {
				if (since !== undefined) {
					for (const event of await eventsSince(projectId, since)) {
						if (closed) return;
						emit(event);
					}
				}
			} catch (error) {
				cleanup('error');
				controller.error(error);
				return;
			}
			replaying = false;
			for (const event of buffered.splice(0)) emit(event);
			if (closed) return;
			heartbeatTimer = setInterval(() => send(': ping\n\n'), heartbeatMs);
		},
		cancel() {
			cleanup();
		}
	});
}
