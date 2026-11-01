import type {
	Image,
	Node,
	Notice,
	Project,
	ProjectConfig,
	StateDef,
	StateKind,
	Task,
	ChronicleEvent
} from '../types.ts';

export interface DashboardState {
	project: Project;
	tasks: Task[];
	nodes: Node[];
	notices: Notice[];
	images: Image[];
	lastSeq: number;
}

// Held per browser only; a notice with no entry is unread.
export type NoticeStatus = 'unread' | 'approved' | 'flagged';

export const FALLBACK_COLOR = '#9ca3af';
export const STALE_MS = 4 * 60 * 60 * 1000;

function compareTasks(a: Task, b: Task): number {
	if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? 1 : -1;
	if (a.id === b.id) return 0;
	return a.id < b.id ? 1 : -1;
}

function upsertTask(tasks: Task[], task: Task): Task[] {
	const rest = tasks.filter((t) => t.id !== task.id);
	const at = rest.findIndex((t) => compareTasks(task, t) < 0);
	rest.splice(at === -1 ? rest.length : at, 0, task);
	return rest;
}

function upsertNode(nodes: Node[], node: Node): Node[] {
	const at = nodes.findIndex((n) => n.taskId === node.taskId && n.path === node.path);
	if (at === -1) return [...nodes, node];
	const next = nodes.slice();
	next[at] = node;
	return next;
}

export function applyEvent(state: DashboardState, event: ChronicleEvent): DashboardState {
	if (event.seq <= state.lastSeq) return state;
	const next = { ...state, lastSeq: event.seq };
	if (event.type === 'config') {
		const { config } = event.payload as { config: ProjectConfig };
		next.project = { ...state.project, config };
	} else if (event.type === 'project') {
		const { name, notes, links } = event.payload as Project;
		next.project = { ...state.project, name, notes, links };
	} else if (event.type === 'task') {
		next.tasks = upsertTask(state.tasks, event.payload as Task);
	} else if (event.type === 'notice') {
		const notice = event.payload as Notice;
		if (!state.notices.some((n) => n.id === notice.id)) {
			next.notices = [...state.notices, notice];
		}
	} else if (event.type === 'image') {
		const image = event.payload as Image;
		if (!state.images.some((i) => i.id === image.id)) {
			next.images = [...state.images, image];
		}
	} else {
		next.nodes = upsertNode(state.nodes, event.payload as Node);
	}
	return next;
}

export function stateOf(config: ProjectConfig, key: string): StateDef {
	return (
		config.states.find((s) => s.key === key) ?? {
			key,
			label: key,
			color: FALLBACK_COLOR,
			kind: 'pending',
			icon: '?',
			animation: 'none'
		}
	);
}

export function kindOf(config: ProjectConfig, key: string): StateKind {
	return stateOf(config, key).kind;
}

function isFinishedKind(kind: StateKind): boolean {
	return kind === 'done' || kind === 'failed';
}

export function taskBucket(task: Task, config: ProjectConfig): 'badge' | 'card' {
	return isFinishedKind(kindOf(config, task.state)) ? 'badge' : 'card';
}

export function latestActivity(task: Task, nodes: Node[]): number {
	let latest = Date.parse(task.updatedAt);
	for (const n of nodes) {
		if (n.taskId !== task.id) continue;
		const t = Date.parse(n.updatedAt);
		if (t > latest) latest = t;
	}
	return latest;
}

export function isStale(
	task: Task,
	nodes: Node[],
	config: ProjectConfig,
	now: number,
	staleMs: number = STALE_MS
): boolean {
	const kind = kindOf(config, task.state);
	if (isFinishedKind(kind) || kind === 'review') return false;
	return now - latestActivity(task, nodes) > staleMs;
}

function byPositionThenPath(a: Node, b: Node): number {
	return a.position - b.position || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
}

export function childrenOf(nodes: Node[], taskId: string, parentPath: string | null): Node[] {
	return nodes
		.filter((n) => n.taskId === taskId && n.parentPath === parentPath)
		.sort(byPositionThenPath);
}

export function subtreeStates(nodes: Node[], taskId: string, path: string): string[] {
	const prefix = `${path}/`;
	return nodes
		.filter((n) => n.taskId === taskId && n.path.startsWith(prefix))
		.sort((a, b) => a.depth - b.depth || byPositionThenPath(a, b))
		.map((n) => n.state);
}

export function noticesOf(notices: Notice[], taskId: string): Notice[] {
	return notices.filter((n) => n.taskId === taskId);
}

export function imagesOf(images: Image[], taskId: string, path: string | null): Image[] {
	return images.filter((i) => i.taskId === taskId && i.path === path);
}

// Approved notices stop raising the alert; unread and flagged ones keep it.
export function needsReview(status: NoticeStatus): boolean {
	return status !== 'approved';
}

export function justFinished(prev: Task | undefined, next: Task, config: ProjectConfig): boolean {
	if (kindOf(config, next.state) !== 'done') return false;
	return prev === undefined || kindOf(config, prev.state) !== 'done';
}

export function allSettled(tasks: Task[], config: ProjectConfig): boolean {
	return tasks.length > 0 && tasks.every((t) => isFinishedKind(kindOf(config, t.state)));
}

export function formatElapsed(fromIso: string, now: number): string {
	const ms = Math.max(0, now - Date.parse(fromIso));
	const s = Math.floor(ms / 1000);
	if (s < 60) return `${s}s`;
	const m = Math.floor(s / 60);
	if (m < 60) return `${m}m`;
	const h = Math.floor(m / 60);
	if (h < 24) return m % 60 ? `${h}h ${m % 60}m` : `${h}h`;
	const d = Math.floor(h / 24);
	return h % 24 ? `${d}d ${h % 24}h` : `${d}d`;
}

export function runtimeOf(task: Task, now: number): string {
	const end = task.finishedAt ? Date.parse(task.finishedAt) : now;
	return formatElapsed(task.createdAt, end);
}

export interface StepProgress {
	done: number;
	total: number;
}

export function stepProgress(nodes: Node[], taskId: string, config: ProjectConfig): StepProgress {
	const steps = childrenOf(nodes, taskId, null);
	return {
		done: steps.filter((s) => kindOf(config, s.state) === 'done').length,
		total: steps.length
	};
}
