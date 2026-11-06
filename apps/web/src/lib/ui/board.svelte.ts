import { getContext, setContext } from 'svelte';
import { SvelteDate, SvelteMap, SvelteSet } from 'svelte/reactivity';
import type { Image, Node, Notice, ProjectConfig, Task, ChronicleEvent } from '../types.ts';
import {
	allSettled,
	applyEvent,
	imagesOf,
	justFinished,
	kindOf,
	needsReview,
	noticesOf,
	taskBucket,
	type DashboardState,
	type NoticeStatus
} from './dashboard.ts';

export const FLASH_MS = 1800;
export const TICK_MS = 30_000;

export interface Timeline {
	status: 'loading' | 'ready' | 'error';
	events: ChronicleEvent[];
}

export type Connection = 'connecting' | 'live' | 'retrying' | 'idle';

const BOARD = Symbol('board');

export function provideBoard(board: Board): void {
	setContext(BOARD, board);
}

export function useBoard(): Board {
	return getContext<Board>(BOARD);
}

export function nodeKey(taskId: string, path: string): string {
	return `${taskId}:${path}`;
}

function mergeEvents(a: ChronicleEvent[], b: ChronicleEvent[]): ChronicleEvent[] {
	const merged: ChronicleEvent[] = [];
	for (const e of [...a, ...b]) {
		const at = merged.findIndex((m) => m.seq === e.seq);
		if (at === -1) merged.push(e);
		else merged[at] = e;
	}
	return merged.sort((x, y) => x.seq - y.seq);
}

export class Board {
	state: DashboardState;
	now: number;
	reduced = $state(false);
	connection: Connection = $state('connecting');
	frameFlashing = $state(false);
	finishing = new SvelteSet<string>();
	open = new SvelteSet<string>();
	timelineOpen = new SvelteSet<string>();
	timelines = new SvelteMap<string, Timeline>();
	noticeStatus = new SvelteMap<string, Exclude<NoticeStatus, 'unread'>>();
	expired = new SvelteSet<string>();
	viewing: Image | null = $state(null);

	readonly only: string | null;

	config: ProjectConfig;
	tasks: Task[];
	cards: Task[];
	badges: Task[];
	opened: Task[];
	notices: Notice[];
	blocked: number;
	flashColor: string;

	private timers: ReturnType<typeof setTimeout>[] = [];

	constructor(initial: DashboardState, now: number, only: string | null = null) {
		this.state = $state.raw(initial);
		this.now = $state(now);
		this.only = only;

		this.config = $derived(this.state.project.config);
		this.tasks = $derived(
			this.only ? this.state.tasks.filter((t) => t.id === this.only) : this.state.tasks
		);
		this.cards = $derived(
			this.only
				? this.tasks
				: this.tasks.filter(
						(t) => taskBucket(t, this.config) === 'card' || this.finishing.has(t.id)
					)
		);
		this.badges = $derived(
			this.only
				? []
				: this.tasks.filter(
						(t) => taskBucket(t, this.config) === 'badge' && !this.finishing.has(t.id)
					)
		);
		this.opened = $derived(this.badges.filter((t) => this.open.has(t.id)));
		this.notices = $derived(
			this.only ? this.state.notices.filter((n) => n.taskId === this.only) : this.state.notices
		);
		this.blocked = $derived(
			this.tasks.filter((t) => kindOf(this.config, t.state) === 'blocked').length
		);
		this.flashColor = $derived(
			this.config.states.find((s) => s.kind === 'done')?.color ?? '#22c55e'
		);
	}

	nodesOf(taskId: string): Node[] {
		return this.state.nodes.filter((n) => n.taskId === taskId);
	}

	noticesOf(taskId: string): Notice[] {
		return noticesOf(this.state.notices, taskId);
	}

	imagesOf(taskId: string, path: string | null): Image[] {
		return imagesOf(this.state.images, taskId, path);
	}

	view(image: Image | null): void {
		this.viewing = image;
	}

	markExpired(id: string): void {
		this.expired.add(id);
	}

	statusOf(id: string): NoticeStatus {
		return this.noticeStatus.get(id) ?? 'unread';
	}

	pendingNotices(taskId: string): number {
		return this.noticesOf(taskId).filter((n) => needsReview(this.statusOf(n.id))).length;
	}

	// Setting the status a notice already has clears it back to unread.
	setNoticeStatus(id: string, status: Exclude<NoticeStatus, 'unread'>): void {
		if (this.noticeStatus.get(id) === status) this.noticeStatus.delete(id);
		else this.noticeStatus.set(id, status);
		this.saveNoticeStatus();
	}

	ms(value: number): number {
		return this.reduced ? 0 : value;
	}

	start(): () => void {
		this.now = Date.now();
		this.loadOpen();
		this.loadNoticeStatus();

		const media = window.matchMedia('(prefers-reduced-motion: reduce)');
		this.reduced = media.matches;
		const onMedia = () => (this.reduced = media.matches);
		media.addEventListener('change', onMedia);

		const tick = setInterval(() => (this.now = Date.now()), TICK_MS);
		const closeStream = this.connect();

		return () => {
			closeStream();
			clearInterval(tick);
			media.removeEventListener('change', onMedia);
			for (const t of this.timers) clearTimeout(t);
			this.timers = [];
		};
	}

	private connect(): () => void {
		const url = `/api/projects/${this.state.project.id}/stream?since=${this.state.lastSeq}`;
		const es = new EventSource(url);
		es.onopen = () => (this.connection = 'live');
		es.onerror = () => {
			if (es.readyState !== EventSource.CLOSED) this.connection = 'retrying';
		};
		for (const type of ['task', 'node', 'notice', 'image', 'config', 'project'] as const) {
			es.addEventListener(type, (e) => this.onFrame(type, e as MessageEvent));
		}
		es.addEventListener('reset', () => location.reload());
		es.addEventListener('idle', () => {
			es.close();
			this.connection = 'idle';
		});
		return () => es.close();
	}

	private onFrame(type: ChronicleEvent['type'], e: MessageEvent): void {
		const seq = Number(e.lastEventId);
		if (!Number.isFinite(seq)) return;
		let payload: ChronicleEvent['payload'];
		try {
			payload = JSON.parse(e.data);
		} catch {
			return;
		}
		let taskId: string | null = null;
		let path: string | null = null;
		// Stamp with the row's write time, never receipt time: replayed frames would all read as just now.
		let at = new SvelteDate().toISOString();
		if (type === 'task') {
			taskId = (payload as Task).id;
			at = (payload as Task).updatedAt;
		}
		if (type === 'node') {
			taskId = (payload as Node).taskId;
			path = (payload as Node).path;
			at = (payload as Node).updatedAt;
		}
		if (type === 'notice') {
			taskId = (payload as Notice).taskId;
			path = (payload as Notice).path;
			at = (payload as Notice).createdAt;
		}
		if (type === 'image') {
			taskId = (payload as Image).taskId;
			path = (payload as Image).path;
			at = (payload as Image).createdAt;
		}
		this.receive({ seq, type, taskId, path, payload, at });
	}

	receive(event: ChronicleEvent): void {
		const prev = this.state;
		const next = applyEvent(prev, event);
		if (next === prev) return;
		const prevVisible = this.visible(prev.tasks);
		this.state = next;

		if (event.type === 'node') this.appendTimeline(event);
		if (event.type !== 'task') return;

		const task = event.payload as Task;
		if (this.only && task.id !== this.only) return;
		const before = prev.tasks.find((t) => t.id === task.id);
		const config = next.project.config;
		let delay = 0;
		if (justFinished(before, task, config)) {
			this.finishing.add(task.id);
			this.later(() => this.finishing.delete(task.id), FLASH_MS);
			delay = FLASH_MS + 100;
		} else if (kindOf(config, task.state) !== 'done') {
			this.finishing.delete(task.id);
		}

		const nextVisible = this.visible(next.tasks);
		const settledNow =
			prevVisible.length > 0 &&
			!allSettled(prevVisible, prev.project.config) &&
			allSettled(nextVisible, config) &&
			nextVisible.some((t) => kindOf(config, t.state) === 'done');
		if (settledNow) {
			this.later(() => {
				this.frameFlashing = true;
				this.later(() => (this.frameFlashing = false), FLASH_MS);
			}, delay);
		}
	}

	private visible(tasks: Task[]): Task[] {
		return this.only ? tasks.filter((t) => t.id === this.only) : tasks;
	}

	private later(fn: () => void, ms: number): void {
		const handle = setTimeout(() => {
			this.timers = this.timers.filter((t) => t !== handle);
			fn();
		}, ms);
		this.timers.push(handle);
	}

	private get storageKey(): string {
		return `chronicle:${this.state.project.id}:open`;
	}

	private loadOpen(): void {
		try {
			const raw = localStorage.getItem(this.storageKey);
			const parsed: unknown = raw ? JSON.parse(raw) : [];
			if (Array.isArray(parsed)) {
				for (const id of parsed) if (typeof id === 'string') this.open.add(id);
			}
		} catch {
			// storage unavailable or corrupt: start collapsed
		}
	}

	private saveOpen(): void {
		try {
			localStorage.setItem(this.storageKey, JSON.stringify([...this.open]));
		} catch {
			// storage unavailable: expansion stays per page load
		}
	}

	private get noticeKey(): string {
		return `chronicle:${this.state.project.id}:notices`;
	}

	private loadNoticeStatus(): void {
		try {
			const raw = localStorage.getItem(this.noticeKey);
			const parsed: unknown = raw ? JSON.parse(raw) : {};
			if (parsed && typeof parsed === 'object') {
				for (const [id, status] of Object.entries(parsed)) {
					if (status === 'approved' || status === 'flagged') this.noticeStatus.set(id, status);
				}
			}
		} catch {
			// storage unavailable or corrupt: every notice reads as unread
		}
	}

	private saveNoticeStatus(): void {
		try {
			localStorage.setItem(this.noticeKey, JSON.stringify(Object.fromEntries(this.noticeStatus)));
		} catch {
			// storage unavailable: review marks last for this page load
		}
	}

	toggle(id: string): void {
		if (this.open.has(id)) this.open.delete(id);
		else this.open.add(id);
		this.saveOpen();
	}

	async toggleTimeline(taskId: string, path: string): Promise<void> {
		const key = nodeKey(taskId, path);
		if (this.timelineOpen.has(key)) {
			this.timelineOpen.delete(key);
			return;
		}
		this.timelineOpen.add(key);
		if (
			this.timelines.get(key)?.status === 'ready' ||
			this.timelines.get(key)?.status === 'loading'
		)
			return;
		this.timelines.set(key, { status: 'loading', events: [] });
		try {
			const res = await fetch(`/api/tasks/${taskId}/events?path=${encodeURIComponent(path)}`);
			if (!res.ok) throw new Error(String(res.status));
			const body = (await res.json()) as { events: ChronicleEvent[] };
			const current = this.timelines.get(key);
			this.timelines.set(key, {
				status: 'ready',
				events: mergeEvents(body.events, current?.events ?? [])
			});
		} catch {
			const current = this.timelines.get(key);
			this.timelines.set(key, { status: 'error', events: current?.events ?? [] });
		}
	}

	private appendTimeline(event: ChronicleEvent): void {
		if (event.taskId === null || event.path === null) return;
		const key = nodeKey(event.taskId, event.path);
		const current = this.timelines.get(key);
		if (!current) return;
		this.timelines.set(key, {
			...current,
			events: mergeEvents(current.events, [event])
		});
	}
}
