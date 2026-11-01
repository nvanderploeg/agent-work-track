import { describe, it, expect } from 'vitest';
import {
	FALLBACK_COLOR,
	STALE_MS,
	allSettled,
	applyEvent,
	childrenOf,
	formatElapsed,
	isStale,
	justFinished,
	kindOf,
	needsReview,
	noticesOf,
	imagesOf,
	runtimeOf,
	stateOf,
	stepProgress,
	subtreeStates,
	taskBucket
} from './dashboard.ts';
import type { DashboardState } from './dashboard.ts';
import type {
	Image,
	Node,
	Notice,
	Project,
	ProjectConfig,
	Task,
	ChronicleEvent
} from '../types.ts';

const BUILD_IT: ProjectConfig = {
	theme: 'system',
	initialState: 'queued',
	states: [
		{
			key: 'queued',
			label: 'Not started',
			color: '#9ca3af',
			kind: 'pending',
			icon: '○',
			animation: 'none'
		},
		{
			key: 'planning',
			label: 'Planning',
			color: '#f97316',
			kind: 'active',
			icon: '◔',
			animation: 'shimmer'
		},
		{
			key: 'in_work',
			label: 'In work',
			color: '#eab308',
			kind: 'active',
			icon: '◑',
			animation: 'pulse'
		},
		{
			key: 'testing',
			label: 'Testing',
			color: '#a855f7',
			kind: 'active',
			icon: '◕',
			animation: 'pulse'
		},
		{
			key: 'review',
			label: 'In review',
			color: '#7dd3fc',
			kind: 'review',
			icon: '◎',
			animation: 'none'
		},
		{
			key: 'needs_input',
			label: 'Needs input',
			color: '#ef4444',
			kind: 'blocked',
			icon: '!',
			animation: 'blink'
		},
		{
			key: 'failed',
			label: 'Failed',
			color: '#ef4444',
			kind: 'failed',
			icon: '✕',
			animation: 'none'
		},
		{
			key: 'done',
			label: 'Completed',
			color: '#22c55e',
			kind: 'done',
			icon: '✓',
			animation: 'none'
		}
	]
};

const T0 = Date.UTC(2026, 9, 12, 12, 0, 0);
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const iso = (ms: number) => new Date(ms).toISOString();
const at = (min: number) => iso(T0 + min * MIN);

function task(over: Partial<Task> & { id: string }): Task {
	return {
		projectId: 'p1',
		title: 'Task',
		summary: '',
		state: 'queued',
		note: '',
		agent: null,
		links: [],
		repo: null,
		branch: null,
		createdAt: iso(T0),
		updatedAt: iso(T0),
		stateSince: iso(T0),
		finishedAt: null,
		...over
	};
}

function node(over: Partial<Node> & { taskId: string; path: string }): Node {
	const segments = over.path.split('/');
	const key = segments[segments.length - 1];
	return {
		parentPath: segments.length > 1 ? segments.slice(0, -1).join('/') : null,
		key,
		depth: segments.length,
		title: key,
		state: 'queued',
		note: '',
		tags: [],
		agent: null,
		links: [],
		position: 0,
		createdAt: iso(T0),
		updatedAt: iso(T0),
		stateSince: iso(T0),
		...over
	};
}

function project(over: Partial<Project> = {}): Project {
	return {
		id: 'p1',
		name: 'Demo',
		notes: '',
		links: [],
		config: BUILD_IT,
		createdAt: iso(T0),
		lastWriteAt: iso(T0),
		...over
	};
}

function dashboard(over: Partial<DashboardState> = {}): DashboardState {
	return { project: project(), tasks: [], nodes: [], notices: [], images: [], lastSeq: 0, ...over };
}

function taskEvent(seq: number, t: Task): ChronicleEvent {
	return { seq, type: 'task', taskId: t.id, path: null, payload: t, at: t.updatedAt };
}

function nodeEvent(seq: number, n: Node): ChronicleEvent {
	return { seq, type: 'node', taskId: n.taskId, path: n.path, payload: n, at: n.updatedAt };
}

function configEvent(seq: number, config: ProjectConfig): ChronicleEvent {
	return { seq, type: 'config', taskId: null, path: null, payload: { config }, at: iso(T0) };
}

function notice(over: Partial<Notice> = {}): Notice {
	return {
		id: 'n1',
		taskId: 'a',
		path: null,
		kind: 'caveat',
		text: 'x',
		createdAt: iso(T0),
		...over
	};
}

function noticeEvent(seq: number, n: Notice): ChronicleEvent {
	return { seq, type: 'notice', taskId: n.taskId, path: n.path, payload: n, at: n.createdAt };
}

function image(over: Partial<Image> = {}): Image {
	return {
		id: 'i1',
		taskId: 'a',
		path: null,
		caption: '',
		review: false,
		width: 256,
		height: 144,
		createdAt: iso(T0),
		...over
	};
}

function imageEvent(seq: number, i: Image): ChronicleEvent {
	return { seq, type: 'image', taskId: i.taskId, path: i.path, payload: i, at: i.createdAt };
}

function deepFreeze<T>(value: T): T {
	if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
		Object.freeze(value);
		for (const v of Object.values(value as object)) deepFreeze(v);
	}
	return value;
}

describe('images', () => {
	it('applyEvent appends an image once, even when the same image arrives under a new seq', () => {
		const i = image();
		const once = applyEvent(dashboard(), imageEvent(1, i));
		expect(once.images).toEqual([i]);
		expect(once.nodes).toEqual([]);
		expect(applyEvent(once, imageEvent(2, i)).images).toEqual([i]);
	});

	it('imagesOf keeps the given task and node, in input order', () => {
		const taskLevel = image({ id: 'i1' });
		const onStep = image({ id: 'i2', path: 'step-1' });
		const onStepLater = image({ id: 'i3', path: 'step-1' });
		const other = image({ id: 'i4', taskId: 'b' });
		const all = [taskLevel, onStep, other, onStepLater];
		expect(imagesOf(all, 'a', null)).toEqual([taskLevel]);
		expect(imagesOf(all, 'a', 'step-1')).toEqual([onStep, onStepLater]);
		expect(imagesOf(all, 'a', 'step-2')).toEqual([]);
	});
});

describe('notices', () => {
	it('applyEvent appends a notice once, even when the same notice arrives under a new seq', () => {
		const n = notice();
		const once = applyEvent(dashboard(), noticeEvent(1, n));
		expect(once.notices).toEqual([n]);
		expect(applyEvent(once, noticeEvent(2, n)).notices).toEqual([n]);
	});

	it('noticesOf keeps only the given task', () => {
		const mine = notice({ id: 'n1', taskId: 'a' });
		expect(noticesOf([mine, notice({ id: 'n2', taskId: 'b' })], 'a')).toEqual([mine]);
	});

	it('needsReview is false only for approved', () => {
		expect(needsReview('unread')).toBe(true);
		expect(needsReview('flagged')).toBe(true);
		expect(needsReview('approved')).toBe(false);
	});
});

describe('applyEvent', () => {
	it('takes name, notes and links from a project event and keeps the config', () => {
		const s = dashboard({ lastSeq: 1 });
		const payload = {
			...s.project,
			name: 'Renamed',
			notes: 'goals',
			links: [{ url: 'https://trello.com/b/x' }],
			config: { ...s.project.config, theme: 'dark' as const }
		};
		const next = applyEvent(s, {
			seq: 2,
			type: 'project',
			taskId: null,
			path: null,
			payload,
			at: iso(T0)
		});
		expect(next.project).toMatchObject({ name: 'Renamed', notes: 'goals', links: payload.links });
		expect(next.project.config).toBe(s.project.config);
	});

	it('returns the same state reference when event.seq equals lastSeq', () => {
		const s = dashboard({ tasks: [task({ id: 'a', createdAt: at(1) })], lastSeq: 5 });
		const ev = taskEvent(5, { ...s.tasks[0], title: 'changed' });
		expect(applyEvent(s, ev)).toBe(s);
	});

	it('returns the same state reference when event.seq is below lastSeq, leaving the task untouched', () => {
		const s = dashboard({ tasks: [task({ id: 'a', createdAt: at(1) })], lastSeq: 5 });
		const ev = taskEvent(4, { ...s.tasks[0], title: 'changed', state: 'done' });
		const next = applyEvent(s, ev);
		expect(next).toBe(s);
		expect(next.tasks[0].title).toBe('Task');
		expect(next.tasks[0].state).toBe('queued');
	});

	it('returns the same state reference for a stale config or node event', () => {
		const n = node({ taskId: 'a', path: 'step' });
		const s = dashboard({ nodes: [n], lastSeq: 9 });
		expect(applyEvent(s, configEvent(3, BUILD_IT))).toBe(s);
		expect(applyEvent(s, nodeEvent(9, { ...n, title: 'x' }))).toBe(s);
	});

	it('ignores a duplicate event on replay and returns the same reference the second time', () => {
		const s = dashboard({ lastSeq: 5 });
		const ev = taskEvent(6, task({ id: 'a', createdAt: at(1) }));
		const once = applyEvent(s, ev);
		expect(once).not.toBe(s);
		expect(applyEvent(once, ev)).toBe(once);
		expect(applyEvent(once, ev).tasks).toHaveLength(1);
	});

	it('sets lastSeq to event.seq and returns a new state for an accepted event', () => {
		const s = dashboard({ lastSeq: 5 });
		const next = applyEvent(s, taskEvent(9, task({ id: 'a' })));
		expect(next).not.toBe(s);
		expect(next.lastSeq).toBe(9);
	});

	it('does not mutate the input state or the event', () => {
		const a = task({ id: 'a', createdAt: at(30) });
		const c = task({ id: 'c', createdAt: at(10) });
		const n = node({ taskId: 'a', path: 'chunk-1', title: 'one' });
		const s = deepFreeze(dashboard({ tasks: [a, c], nodes: [n], lastSeq: 1 }));
		const before = JSON.stringify(s);

		const b = task({ id: 'b', createdAt: at(20) });
		const withTask = applyEvent(s, deepFreeze(taskEvent(2, b)));
		expect(JSON.stringify(s)).toBe(before);
		expect(withTask.tasks.map((t) => t.id)).toEqual(['a', 'b', 'c']);

		const withNode = applyEvent(s, deepFreeze(nodeEvent(3, { ...n, title: 'two' })));
		expect(JSON.stringify(s)).toBe(before);
		expect(withNode.nodes[0].title).toBe('two');

		const withConfig = applyEvent(s, deepFreeze(configEvent(4, { ...BUILD_IT, theme: 'dark' })));
		expect(JSON.stringify(s)).toBe(before);
		expect(withConfig.project.config.theme).toBe('dark');
	});

	it('inserts a new task at its createdAt-desc position', () => {
		const s = dashboard({
			tasks: [task({ id: 'a', createdAt: at(30) }), task({ id: 'c', createdAt: at(10) })]
		});
		const withB = applyEvent(s, taskEvent(1, task({ id: 'b', createdAt: at(20) })));
		expect(withB.tasks.map((t) => t.id)).toEqual(['a', 'b', 'c']);

		const withD = applyEvent(withB, taskEvent(2, task({ id: 'd', createdAt: at(40) })));
		expect(withD.tasks.map((t) => t.id)).toEqual(['d', 'a', 'b', 'c']);

		const withE = applyEvent(withD, taskEvent(3, task({ id: 'e', createdAt: at(0) })));
		expect(withE.tasks.map((t) => t.id)).toEqual(['d', 'a', 'b', 'c', 'e']);
	});

	it('breaks createdAt ties by id descending when inserting', () => {
		const s = dashboard({
			tasks: [task({ id: 'y', createdAt: at(5) }), task({ id: 'x', createdAt: at(5) })]
		});
		const withZ = applyEvent(s, taskEvent(1, task({ id: 'z', createdAt: at(5) })));
		expect(withZ.tasks.map((t) => t.id)).toEqual(['z', 'y', 'x']);

		const withM = applyEvent(withZ, taskEvent(2, task({ id: 'm', createdAt: at(5) })));
		expect(withM.tasks.map((t) => t.id)).toEqual(['z', 'y', 'x', 'm']);
	});

	it('updates an existing task in place without moving or duplicating it', () => {
		const s = dashboard({
			tasks: [
				task({ id: 'd', createdAt: at(40) }),
				task({ id: 'a', createdAt: at(30) }),
				task({ id: 'b', createdAt: at(20) }),
				task({ id: 'c', createdAt: at(10) })
			]
		});
		const updated = task({
			id: 'b',
			createdAt: at(20),
			state: 'done',
			updatedAt: at(50),
			stateSince: at(50),
			finishedAt: at(50)
		});
		const next = applyEvent(s, taskEvent(1, updated));
		expect(next.tasks.map((t) => t.id)).toEqual(['d', 'a', 'b', 'c']);
		expect(next.tasks[2].state).toBe('done');
		expect(next.tasks[2].updatedAt).toBe(at(50));
	});

	it('keeps tasks sorted by createdAt desc when an upserted task carries a later createdAt', () => {
		const s = dashboard({
			tasks: [
				task({ id: 'a', createdAt: at(30) }),
				task({ id: 'b', createdAt: at(20) }),
				task({ id: 'c', createdAt: at(10) })
			]
		});
		const next = applyEvent(s, taskEvent(1, task({ id: 'c', createdAt: at(40) })));
		expect(next.tasks.map((t) => t.id)).toEqual(['c', 'a', 'b']);
	});

	it('upserts nodes by (taskId, path) so two tasks may share a path', () => {
		const s = dashboard({
			nodes: [
				node({ taskId: 't1', path: 'chunk-1', title: 'A' }),
				node({ taskId: 't2', path: 'chunk-1', title: 'B' })
			]
		});
		const next = applyEvent(
			s,
			nodeEvent(1, node({ taskId: 't1', path: 'chunk-1', title: 'A2', state: 'done' }))
		);
		expect(next.nodes).toHaveLength(2);
		const t1 = next.nodes.filter((n) => n.taskId === 't1' && n.path === 'chunk-1');
		const t2 = next.nodes.filter((n) => n.taskId === 't2' && n.path === 'chunk-1');
		expect(t1).toHaveLength(1);
		expect(t1[0].title).toBe('A2');
		expect(t1[0].state).toBe('done');
		expect(t2).toHaveLength(1);
		expect(t2[0].title).toBe('B');
	});

	it('appends a node event for an unseen (taskId, path) pair', () => {
		const s = dashboard({ nodes: [node({ taskId: 't1', path: 'chunk-1' })] });
		const next = applyEvent(s, nodeEvent(1, node({ taskId: 't2', path: 'chunk-1' })));
		expect(next.nodes).toHaveLength(2);
		expect(next.nodes.some((n) => n.taskId === 't2' && n.path === 'chunk-1')).toBe(true);
	});

	it('replaces project.config on a config event and keeps the rest of the project', () => {
		const s = dashboard({
			tasks: [task({ id: 'a' })],
			nodes: [node({ taskId: 'a', path: 'x' })],
			lastSeq: 2
		});
		const newConfig: ProjectConfig = {
			theme: 'dark',
			initialState: 'planning',
			states: [{ key: 'planning', label: 'Planning', color: '#f97316', kind: 'active' }]
		};
		const next = applyEvent(s, configEvent(3, newConfig));
		expect(next.project.config).toEqual(newConfig);
		expect(next.project.name).toBe('Demo');
		expect(next.project.id).toBe('p1');
		expect(next.tasks).toEqual(s.tasks);
		expect(next.nodes).toEqual(s.nodes);
		expect(next.lastSeq).toBe(3);
	});
});

describe('stateOf and kindOf', () => {
	it('exports the fallback color and the 4 hour stale threshold', () => {
		expect(FALLBACK_COLOR).toBe('#9ca3af');
		expect(STALE_MS).toBe(4 * 60 * 60 * 1000);
	});

	it('returns the config StateDef for a known key', () => {
		expect(stateOf(BUILD_IT, 'testing')).toEqual({
			key: 'testing',
			label: 'Testing',
			color: '#a855f7',
			kind: 'active',
			icon: '◕',
			animation: 'pulse'
		});
	});

	it('returns the exact fallback object for an unknown key', () => {
		expect(stateOf(BUILD_IT, 'nope')).toStrictEqual({
			key: 'nope',
			label: 'nope',
			color: FALLBACK_COLOR,
			kind: 'pending',
			icon: '?',
			animation: 'none'
		});
	});

	it('kindOf returns the StateDef kind for a known key', () => {
		expect(kindOf(BUILD_IT, 'needs_input')).toBe('blocked');
		expect(kindOf(BUILD_IT, 'done')).toBe('done');
	});

	it('kindOf returns pending for an unknown key', () => {
		expect(kindOf(BUILD_IT, 'nope')).toBe('pending');
	});
});

describe('taskBucket', () => {
	it.each([
		['queued', 'card'],
		['planning', 'card'],
		['in_work', 'card'],
		['testing', 'card'],
		['needs_input', 'card'],
		['failed', 'badge'],
		['done', 'badge']
	])('state %s (kind of preset) buckets to %s', (key, bucket) => {
		expect(taskBucket(task({ id: 't1', state: key }), BUILD_IT)).toBe(bucket);
	});

	it('buckets an unknown state key as a card (pending fallback)', () => {
		expect(taskBucket(task({ id: 't1', state: 'nope' }), BUILD_IT)).toBe('card');
	});
});

describe('isStale', () => {
	const active = task({ id: 't1', state: 'in_work', updatedAt: iso(T0), createdAt: iso(T0) });

	it('is false at exactly STALE_MS since the last activity', () => {
		expect(isStale(active, [], BUILD_IT, T0 + STALE_MS)).toBe(false);
	});

	it('is true at STALE_MS + 1 ms since the last activity', () => {
		expect(isStale(active, [], BUILD_IT, T0 + STALE_MS + 1)).toBe(true);
	});

	it('is never true for a task in review: it waits on people, not the agent', () => {
		const inReview = { ...active, state: 'review' };
		expect(isStale(inReview, [], BUILD_IT, T0 + 30 * DAY)).toBe(false);
	});

	it('keeps a task in review on the board as a card', () => {
		expect(taskBucket({ ...active, state: 'review' }, BUILD_IT)).toBe('card');
	});

	it('uses STALE_MS when no staleMs is given', () => {
		expect(isStale(active, [], BUILD_IT, T0 + STALE_MS)).toBe(
			isStale(active, [], BUILD_IT, T0 + STALE_MS, STALE_MS)
		);
		expect(isStale(active, [], BUILD_IT, T0 + STALE_MS + 1)).toBe(
			isStale(active, [], BUILD_IT, T0 + STALE_MS + 1, STALE_MS)
		);
	});

	it('keeps a task fresh while its newest own node is recent, even if the task itself is old', () => {
		const n = node({ taskId: 't1', path: 'chunk-1', updatedAt: iso(T0 + 2 * HOUR) });
		expect(isStale(active, [n], BUILD_IT, T0 + 2 * HOUR + STALE_MS)).toBe(false);
		expect(isStale(active, [n], BUILD_IT, T0 + 2 * HOUR + STALE_MS + 1)).toBe(true);
	});

	it('uses the newest timestamp when the task is newer than an old node', () => {
		const fresh = task({
			id: 't1',
			state: 'in_work',
			updatedAt: iso(T0 + 2 * HOUR),
			createdAt: iso(T0)
		});
		const oldNode = node({ taskId: 't1', path: 'chunk-1', updatedAt: iso(T0) });
		expect(isStale(fresh, [oldNode], BUILD_IT, T0 + 2 * HOUR + STALE_MS)).toBe(false);
		expect(isStale(fresh, [oldNode], BUILD_IT, T0 + 2 * HOUR + STALE_MS + 1)).toBe(true);
	});

	it('ignores nodes that belong to another task', () => {
		const other = node({ taskId: 't2', path: 'chunk-1', updatedAt: iso(T0 + STALE_MS + 1) });
		expect(isStale(active, [other], BUILD_IT, T0 + STALE_MS + 1)).toBe(true);
	});

	it.each(['done', 'failed'])('never reports a %s task as stale', (key) => {
		const settled = task({ id: 't1', state: key, updatedAt: iso(T0), createdAt: iso(T0) });
		expect(isStale(settled, [], BUILD_IT, T0 + 10 * STALE_MS)).toBe(false);
		expect(isStale(settled, [], BUILD_IT, T0 + 1000, 1)).toBe(false);
	});

	it.each(['queued', 'planning', 'needs_input'])(
		'reports a non-settled %s task as stale after STALE_MS',
		(key) => {
			const t = task({ id: 't1', state: key, updatedAt: iso(T0), createdAt: iso(T0) });
			expect(isStale(t, [], BUILD_IT, T0 + STALE_MS + 1)).toBe(true);
		}
	);

	it('honours a custom staleMs at its exact boundary', () => {
		expect(isStale(active, [], BUILD_IT, T0 + 60_000, 60_000)).toBe(false);
		expect(isStale(active, [], BUILD_IT, T0 + 60_001, 60_000)).toBe(true);
	});

	it('does not use STALE_MS when a larger custom staleMs is given', () => {
		expect(isStale(active, [], BUILD_IT, T0 + STALE_MS + 1, 24 * HOUR)).toBe(false);
	});
});

describe('childrenOf', () => {
	const nodes: Node[] = [
		node({ taskId: 't1', path: 'b', position: 2 }),
		node({ taskId: 't1', path: 'c', position: 1 }),
		node({ taskId: 't1', path: 'a', position: 1 }),
		node({ taskId: 't1', path: 'a/y', position: 5 }),
		node({ taskId: 't1', path: 'a/z', position: 10 }),
		node({ taskId: 't1', path: 'a/x', position: 2 }),
		node({ taskId: 't1', path: 'a/x/deep', position: 0 }),
		node({ taskId: 't1', path: 'p' }),
		node({ taskId: 't1', path: 'p/q', position: 0 }),
		node({ taskId: 't1', path: 'p/o', position: 0 }),
		node({ taskId: 't2', path: 'd', position: 0 }),
		node({ taskId: 't2', path: 'a/w', position: 0 })
	];

	it('returns steps (parentPath null) sorted by position then path', () => {
		expect(childrenOf(nodes, 't1', null).map((n) => n.path)).toEqual(['p', 'a', 'c', 'b']);
	});

	it('sorts position numerically, so 2 comes before 10', () => {
		expect(childrenOf(nodes, 't1', 'a').map((n) => n.path)).toEqual(['a/x', 'a/y', 'a/z']);
	});

	it('breaks position ties by path ascending', () => {
		expect(childrenOf(nodes, 't1', 'p').map((n) => n.path)).toEqual(['p/o', 'p/q']);
	});

	it('returns only direct children, not deeper descendants', () => {
		expect(childrenOf(nodes, 't1', 'a/x').map((n) => n.path)).toEqual(['a/x/deep']);
	});

	it('filters by task, excluding same-path nodes of other tasks', () => {
		expect(childrenOf(nodes, 't2', null).map((n) => n.path)).toEqual(['d']);
		expect(childrenOf(nodes, 't2', 'a').map((n) => n.path)).toEqual(['a/w']);
	});

	it('returns an empty array when the parent has no children', () => {
		expect(childrenOf(nodes, 't1', 'c')).toEqual([]);
	});
});

describe('subtreeStates', () => {
	const nodes: Node[] = [
		node({ taskId: 't1', path: 'a', state: 'in_work', position: 0 }),
		node({ taskId: 't1', path: 'a/x', state: 'testing', position: 1 }),
		node({ taskId: 't1', path: 'a/y', state: 'done', position: 0 }),
		node({ taskId: 't1', path: 'a/w', state: 'planning', position: 1 }),
		node({ taskId: 't1', path: 'a/x/deep', state: 'failed', position: 0 }),
		node({ taskId: 't1', path: 'ab', state: 'queued', position: 1 }),
		node({ taskId: 't1', path: 'ab/child', state: 'needs_input', position: 0 }),
		node({ taskId: 't1', path: 'b', state: 'queued', position: 2 }),
		node({ taskId: 't2', path: 'a/x', state: 'needs_input', position: 0 })
	];

	it('lists descendants by depth, then position, then path, excluding the node itself', () => {
		expect(subtreeStates(nodes, 't1', 'a')).toEqual(['done', 'planning', 'testing', 'failed']);
	});

	it('does not include a sibling whose path starts with the same characters (a vs ab)', () => {
		expect(subtreeStates(nodes, 't1', 'ab')).toEqual(['needs_input']);
	});

	it('ignores nodes of other tasks with the same path', () => {
		expect(subtreeStates(nodes, 't1', 'a')).not.toContain('needs_input');
	});

	it('returns an empty array for a leaf', () => {
		expect(subtreeStates(nodes, 't1', 'b')).toEqual([]);
	});
});

describe('justFinished', () => {
	it.each<[string | undefined, string, boolean]>([
		[undefined, 'done', true],
		[undefined, 'failed', false],
		[undefined, 'in_work', false],
		['queued', 'done', true],
		['in_work', 'done', true],
		['needs_input', 'done', true],
		['failed', 'done', true],
		['done', 'done', false],
		['done', 'in_work', false],
		['in_work', 'failed', false]
	])('prev=%s next=%s -> %s', (prevKey, nextKey, expected) => {
		const prev = prevKey === undefined ? undefined : task({ id: 't1', state: prevKey });
		const next = task({ id: 't1', state: nextKey });
		expect(justFinished(prev, next, BUILD_IT)).toBe(expected);
	});

	it('returns false for a task first seen already done when the caller passes it as prev', () => {
		const done = task({ id: 't1', state: 'done' });
		expect(justFinished(done, done, BUILD_IT)).toBe(false);
	});
});

describe('allSettled', () => {
	it('is false for an empty list', () => {
		expect(allSettled([], BUILD_IT)).toBe(false);
	});

	it('is true when every task is done', () => {
		expect(
			allSettled([task({ id: 'a', state: 'done' }), task({ id: 'b', state: 'done' })], BUILD_IT)
		).toBe(true);
	});

	it('is true when every task is failed', () => {
		expect(
			allSettled([task({ id: 'a', state: 'failed' }), task({ id: 'b', state: 'failed' })], BUILD_IT)
		).toBe(true);
	});

	it('is true for a mix of done and failed', () => {
		expect(
			allSettled([task({ id: 'a', state: 'done' }), task({ id: 'b', state: 'failed' })], BUILD_IT)
		).toBe(true);
	});

	it('is false when any task is still active', () => {
		expect(
			allSettled([task({ id: 'a', state: 'done' }), task({ id: 'b', state: 'in_work' })], BUILD_IT)
		).toBe(false);
	});

	it('is false when any task is pending', () => {
		expect(
			allSettled([task({ id: 'a', state: 'failed' }), task({ id: 'b', state: 'queued' })], BUILD_IT)
		).toBe(false);
	});

	it('is false when any task is blocked', () => {
		expect(
			allSettled(
				[task({ id: 'a', state: 'done' }), task({ id: 'b', state: 'needs_input' })],
				BUILD_IT
			)
		).toBe(false);
	});
});

describe('formatElapsed', () => {
	it.each<[number, string]>([
		[0, '0s'],
		[1_999, '1s'],
		[59_000, '59s'],
		[59_999, '59s'],
		[60_000, '1m'],
		[119_999, '1m'],
		[3_540_000, '59m'],
		[3_599_999, '59m'],
		[3_600_000, '1h'],
		[3_900_000, '1h 5m'],
		[7_199_000, '1h 59m'],
		[82_800_000, '23h'],
		[86_340_000, '23h 59m'],
		[86_399_999, '23h 59m'],
		[86_400_000, '1d'],
		[88_200_000, '1d'],
		[90_000_000, '1d 1h'],
		[255_600_000, '2d 23h']
	])('%i ms elapsed -> %s', (ms, expected) => {
		expect(formatElapsed(iso(T0 - ms), T0)).toBe(expected);
	});

	it('treats a start time in the future as 0s', () => {
		expect(formatElapsed(iso(T0 + 5_000), T0)).toBe('0s');
		expect(formatElapsed(iso(T0 + 3 * DAY), T0)).toBe('0s');
	});

	it('parses fromIso with Date.parse semantics, so offsets are honoured', () => {
		expect(formatElapsed('2026-10-12T10:00:00+02:00', Date.UTC(2026, 9, 12, 9, 0, 0))).toBe('1h');
	});
});

describe('runtimeOf', () => {
	it('counts a running task up to now', () => {
		expect(runtimeOf(task({ id: 't' }), T0 + 12 * MIN)).toBe('12m');
	});

	it('stops at finishedAt once the task finished', () => {
		expect(runtimeOf(task({ id: 't', finishedAt: at(5) }), T0 + 90 * MIN)).toBe('5m');
	});
});

describe('stepProgress', () => {
	it('counts done-kind steps over all steps, ignoring subtasks and other tasks', () => {
		const nodes = [
			node({ taskId: 't', path: 'a', state: 'done' }),
			node({ taskId: 't', path: 'b', state: 'in_work' }),
			node({ taskId: 't', path: 'b/x', state: 'done' }),
			node({ taskId: 'other', path: 'a', state: 'done' })
		];
		expect(stepProgress(nodes, 't', BUILD_IT)).toEqual({ done: 1, total: 2 });
	});

	it('is 0 of 0 for a task with no steps', () => {
		expect(stepProgress([], 't', BUILD_IT)).toEqual({ done: 0, total: 0 });
	});
});
