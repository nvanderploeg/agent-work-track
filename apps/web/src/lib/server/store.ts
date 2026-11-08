import { and, asc, desc, eq, gt, inArray, isNull, max, notInArray } from 'drizzle-orm';
import { ApiError } from '#lib/server/api.ts';
import { publish } from '#lib/server/bus.ts';
import { db } from '#lib/server/db/index.ts';
import { log } from '#lib/server/log.ts';
import { events, images, nodes, notices, projects, tasks } from '#lib/server/db/schema.ts';
import { imageCache } from '#lib/server/images.ts';
import {
	toEvent,
	toImage,
	toNode,
	toNotice,
	toProject,
	toTask,
	type NodeRow,
	type ProjectRow,
	type TaskRow
} from '#lib/server/serialize.ts';
import type {
	NodeInput,
	NoticeInput,
	ImageInput,
	ProjectPatch,
	StepInput,
	TaskInput,
	TaskPatch
} from '#lib/server/validate.ts';
import type {
	AgentInfo,
	Image,
	Node,
	Notice,
	Project,
	ProjectConfig,
	Snapshot,
	Task,
	ChronicleEvent
} from '#lib/types.ts';

export type { ProjectRow, TaskRow, NodeRow };

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

export async function getProjectRow(id: string): Promise<ProjectRow | undefined> {
	const [row] = await db.select().from(projects).where(eq(projects.id, id));
	return row;
}

export async function getTaskRow(id: string): Promise<TaskRow | undefined> {
	const [row] = await db.select().from(tasks).where(eq(tasks.id, id));
	return row;
}

export async function lastWriteAt(projectId: string): Promise<Date | null> {
	const [row] = await db
		.select({ at: projects.lastWriteAt })
		.from(projects)
		.where(eq(projects.id, projectId));
	return row?.at ?? null;
}

export async function eventsSince(projectId: string, seq: number): Promise<ChronicleEvent[]> {
	const rows = await db
		.select()
		.from(events)
		.where(and(eq(events.projectId, projectId), gt(events.seq, seq)))
		.orderBy(asc(events.seq));
	return rows.map(toEvent);
}

export async function taskEvents(taskId: string, path?: string): Promise<ChronicleEvent[]> {
	const rows = await db
		.select()
		.from(events)
		.where(
			and(
				eq(events.taskId, taskId),
				notInArray(events.type, ['notice', 'image']),
				path === undefined ? undefined : eq(events.path, path)
			)
		)
		.orderBy(asc(events.seq));
	return rows.map(toEvent);
}

export async function snapshot(projectId: string): Promise<Snapshot | undefined> {
	// lastSeq is read before the rows so replaying from it can only repeat events, never skip one.
	const [seqRow] = await db
		.select({ seq: max(events.seq) })
		.from(events)
		.where(eq(events.projectId, projectId));
	const project = await getProjectRow(projectId);
	if (!project) return undefined;
	const taskRows = await db
		.select()
		.from(tasks)
		.where(eq(tasks.projectId, projectId))
		.orderBy(desc(tasks.createdAt), desc(tasks.id));
	const nodeRows = taskRows.length
		? await db
				.select()
				.from(nodes)
				.where(
					inArray(
						nodes.taskId,
						taskRows.map((task) => task.id)
					)
				)
				.orderBy(asc(nodes.taskId), asc(nodes.depth), asc(nodes.position), asc(nodes.path))
		: [];
	const noticeRows = taskRows.length
		? await db
				.select()
				.from(notices)
				.where(
					inArray(
						notices.taskId,
						taskRows.map((task) => task.id)
					)
				)
				.orderBy(asc(notices.createdAt), asc(notices.id))
		: [];
	const imageRows = taskRows.length
		? await db
				.select()
				.from(images)
				.where(
					inArray(
						images.taskId,
						taskRows.map((task) => task.id)
					)
				)
				.orderBy(asc(images.createdAt), asc(images.id))
		: [];
	return {
		project: toProject(project),
		tasks: taskRows.map(toTask),
		nodes: nodeRows.map(toNode),
		notices: noticeRows.map(toNotice),
		images: imageRows.map(toImage),
		lastSeq: Number(seqRow?.seq ?? 0)
	};
}

export async function getTaskWithNodes(
	taskId: string
): Promise<{ task: Task; nodes: Node[]; notices: Notice[]; images: Image[] } | undefined> {
	const row = await getTaskRow(taskId);
	if (!row) return undefined;
	const nodeRows = await db
		.select()
		.from(nodes)
		.where(eq(nodes.taskId, taskId))
		.orderBy(asc(nodes.depth), asc(nodes.position), asc(nodes.path));
	const noticeRows = await db
		.select()
		.from(notices)
		.where(eq(notices.taskId, taskId))
		.orderBy(asc(notices.createdAt), asc(notices.id));
	const imageRows = await db
		.select()
		.from(images)
		.where(eq(images.taskId, taskId))
		.orderBy(asc(images.createdAt), asc(images.id));
	return {
		task: toTask(row),
		nodes: nodeRows.map(toNode),
		notices: noticeRows.map(toNotice),
		images: imageRows.map(toImage)
	};
}

export async function insertProject(row: typeof projects.$inferInsert): Promise<void> {
	await db.insert(projects).values(row);
}

interface Ctx {
	tx: Tx;
	projectId: string;
	config: ProjectConfig;
	now: Date;
	emit(
		type: ChronicleEvent['type'],
		taskId: string | null,
		path: string | null,
		payload: ChronicleEvent['payload']
	): Promise<void>;
}

const chains = new Map<string, Promise<void>>();

// Serialises writes per project so events publish in seq order.
async function exclusive<T>(key: string, work: () => Promise<T>): Promise<T> {
	const run = (chains.get(key) ?? Promise.resolve()).then(work);
	const tail = run.then(
		() => undefined,
		() => undefined
	);
	chains.set(key, tail);
	try {
		return await run;
	} finally {
		if (chains.get(key) === tail) chains.delete(key);
	}
}

async function mutate<T>(projectId: string, work: (ctx: Ctx) => Promise<T>): Promise<T> {
	return exclusive(projectId, async () => {
		const stored: ChronicleEvent[] = [];
		const value = await db.transaction(async (tx) => {
			const [project] = await tx
				.select()
				.from(projects)
				.where(eq(projects.id, projectId))
				.for('update');
			if (!project) throw new ApiError(404, 'project not found');
			const now = new Date();
			const ctx: Ctx = {
				tx,
				projectId,
				config: project.config as ProjectConfig,
				now,
				async emit(type, taskId, path, payload) {
					const [{ seq }] = await tx
						.insert(events)
						.values({ projectId, taskId, path, type, payload, at: now })
						.returning({ seq: events.seq });
					stored.push({
						seq,
						type,
						taskId,
						path,
						payload,
						at: now.toISOString()
					});
				}
			};
			const result = await work(ctx);
			await tx.update(projects).set({ lastWriteAt: now }).where(eq(projects.id, projectId));
			return result;
		});
		for (const event of stored) publish(projectId, event);
		return value;
	});
}

function assertState(config: ProjectConfig, state: string): void {
	if (!config.states.some((def) => def.key === state)) {
		throw new ApiError(400, `unknown state "${state}"`, {
			validStates: config.states.map((def) => def.key)
		});
	}
}

function isFinal(config: ProjectConfig, state: string): boolean {
	const kind = config.states.find((def) => def.key === state)?.kind;
	return kind === 'done' || kind === 'failed';
}

// Fields merge so a later write can add tokens without restating the model.
function mergeAgent(old: unknown, input: AgentInfo | undefined): AgentInfo | null {
	const base = (old as AgentInfo | null) ?? null;
	if (input === undefined) return base;
	return { ...base, ...input };
}

const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

export async function patchProject(projectId: string, patch: ProjectPatch): Promise<Project> {
	return mutate(projectId, async (ctx) => {
		const [old] = await ctx.tx.select().from(projects).where(eq(projects.id, projectId));
		const next = {
			name: patch.name ?? old.name,
			notes: patch.notes ?? old.notes ?? '',
			links: patch.links ?? old.links ?? []
		};
		const project = toProject({ ...old, ...next });
		if (
			next.name === old.name &&
			same(next.notes, old.notes ?? '') &&
			same(next.links, old.links ?? [])
		) {
			return project;
		}
		await ctx.tx.update(projects).set(next).where(eq(projects.id, projectId));
		await ctx.emit('project', null, null, project);
		return project;
	});
}

export async function replaceConfig(projectId: string, config: ProjectConfig) {
	return mutate(projectId, async (ctx) => {
		await ctx.tx.update(projects).set({ config }).where(eq(projects.id, projectId));
		await ctx.emit('config', null, null, { config });
		return config;
	});
}

export async function patchConfig(
	projectId: string,
	apply: (
		current: ProjectConfig
	) => { ok: true; config: ProjectConfig } | { ok: false; error: string }
) {
	return mutate(projectId, async (ctx) => {
		const result = apply(ctx.config);
		if (!result.ok) throw new ApiError(400, result.error);
		await ctx.tx.update(projects).set({ config: result.config }).where(eq(projects.id, projectId));
		await ctx.emit('config', null, null, { config: result.config });
		return result.config;
	});
}

async function nextPosition(ctx: Ctx, taskId: string, parentPath: string | null): Promise<number> {
	const [row] = await ctx.tx
		.select({ top: max(nodes.position) })
		.from(nodes)
		.where(
			and(
				eq(nodes.taskId, taskId),
				parentPath === null ? isNull(nodes.parentPath) : eq(nodes.parentPath, parentPath)
			)
		);
	return row?.top === null || row?.top === undefined ? 0 : Number(row.top) + 1;
}

async function createNode(
	ctx: Ctx,
	taskId: string,
	segments: string[],
	input: NodeInput
): Promise<Node> {
	const path = segments.join('/');
	const parentPath = segments.length > 1 ? segments.slice(0, -1).join('/') : null;
	const key = segments[segments.length - 1];
	const state = input.state ?? ctx.config.initialState;
	assertState(ctx.config, state);
	const row: NodeRow = {
		taskId,
		path,
		parentPath,
		key,
		depth: segments.length,
		title: input.title ?? key,
		state,
		note: input.note ?? '',
		tags: input.tags ?? [],
		agent: input.agent ?? null,
		links: input.links ?? [],
		position: input.position ?? (await nextPosition(ctx, taskId, parentPath)),
		createdAt: ctx.now,
		updatedAt: ctx.now,
		stateSince: ctx.now
	};
	await ctx.tx.insert(nodes).values(row);
	const node = toNode(row);
	await ctx.emit('node', taskId, path, node);
	return node;
}

async function updateNode(ctx: Ctx, old: NodeRow, input: NodeInput): Promise<Node> {
	if (input.state !== undefined) assertState(ctx.config, input.state);
	const stateChanged = input.state !== undefined && input.state !== old.state;
	const next = {
		title: input.title ?? old.title,
		state: input.state ?? old.state,
		note: input.note ?? (stateChanged ? '' : old.note),
		tags: input.tags ?? old.tags,
		agent: mergeAgent(old.agent, input.agent),
		links: input.links ?? old.links ?? [],
		position: input.position ?? old.position
	};
	const changed =
		next.title !== old.title ||
		next.state !== old.state ||
		next.note !== old.note ||
		next.position !== old.position ||
		!same(next.tags, old.tags) ||
		!same(next.agent, old.agent) ||
		!same(next.links, old.links ?? []);
	if (!changed) return toNode(old);
	const row: NodeRow = {
		...old,
		...next,
		updatedAt: ctx.now,
		stateSince: stateChanged ? ctx.now : old.stateSince
	};
	await ctx.tx
		.update(nodes)
		.set({ ...next, updatedAt: row.updatedAt, stateSince: row.stateSince })
		.where(and(eq(nodes.taskId, old.taskId), eq(nodes.path, old.path)));
	const node = toNode(row);
	await ctx.emit('node', old.taskId, old.path, node);
	return node;
}

export async function upsertNode(
	projectId: string,
	taskId: string,
	segments: string[],
	input: NodeInput
): Promise<Node> {
	return mutate(projectId, async (ctx) => {
		if (!(await taskInProject(ctx, taskId))) throw new ApiError(404, 'task not found');
		for (let depth = 1; depth < segments.length; depth++) {
			const ancestor = segments.slice(0, depth);
			const [existing] = await ctx.tx
				.select()
				.from(nodes)
				.where(and(eq(nodes.taskId, taskId), eq(nodes.path, ancestor.join('/'))));
			if (!existing) await createNode(ctx, taskId, ancestor, {});
		}
		const [existing] = await ctx.tx
			.select()
			.from(nodes)
			.where(and(eq(nodes.taskId, taskId), eq(nodes.path, segments.join('/'))));
		const node = existing
			? await updateNode(ctx, existing, input)
			: await createNode(ctx, taskId, segments, input);
		if (node.state !== existing?.state) await startTaskIfActive(ctx, taskId, node);
		return node;
	});
}

// A Task still in a pending Kind moves to the first active State once any of its Nodes is active.
async function startTaskIfActive(ctx: Ctx, taskId: string, node: Node): Promise<void> {
	const kindOf = (key: string) => ctx.config.states.find((def) => def.key === key)?.kind;
	if (kindOf(node.state) !== 'active') return;
	const task = await taskInProject(ctx, taskId);
	if (!task || kindOf(task.state) !== 'pending') return;
	const active = ctx.config.states.find((def) => def.kind === 'active');
	if (active) await applyTaskPatch(ctx, task, { state: active.key, note: task.note });
}

async function taskInProject(ctx: Ctx, taskId: string): Promise<TaskRow | undefined> {
	const [row] = await ctx.tx
		.select()
		.from(tasks)
		.where(and(eq(tasks.id, taskId), eq(tasks.projectId, ctx.projectId)));
	return row;
}

export async function addNotice(
	projectId: string,
	taskId: string,
	input: NoticeInput
): Promise<Notice> {
	return mutate(projectId, async (ctx) => {
		if (!(await taskInProject(ctx, taskId))) throw new ApiError(404, 'task not found');
		const row = {
			id: crypto.randomUUID(),
			taskId,
			path: input.path,
			kind: input.kind,
			text: input.text,
			createdAt: ctx.now
		};
		await ctx.tx.insert(notices).values(row);
		const notice = toNotice(row);
		await ctx.emit('notice', taskId, input.path, notice);
		return notice;
	});
}

// Bytes enter the cache before the event publishes, so a viewer reacting to it can fetch them.
export async function addImage(
	projectId: string,
	taskId: string,
	input: ImageInput
): Promise<Image> {
	const id = crypto.randomUUID();
	try {
		return await mutate(projectId, async (ctx) => {
			const task = await taskInProject(ctx, taskId);
			if (!task) throw new ApiError(404, 'task not found');
			const row = {
				id,
				taskId,
				path: input.path,
				caption: input.caption,
				review: input.full !== null,
				width: input.width,
				height: input.height,
				createdAt: ctx.now
			};
			await ctx.tx.insert(images).values(row);
			const image = toImage(row);
			imageCache.put(
				{ id, projectId, taskId, thumb: input.thumb, full: input.full },
				task.finishedAt?.toISOString() ?? null
			);
			await ctx.emit('image', taskId, input.path, image);
			return image;
		});
	} catch (error) {
		imageCache.drop(id);
		throw error;
	}
}

export async function createTask(
	projectId: string,
	input: TaskInput
): Promise<{ task: Task; nodes: Node[] }> {
	return mutate(projectId, async (ctx) => {
		const state = input.state ?? ctx.config.initialState;
		assertState(ctx.config, state);
		const row: TaskRow = {
			id: crypto.randomUUID(),
			projectId,
			title: input.title,
			summary: input.summary ?? '',
			state,
			note: input.note ?? '',
			agent: input.agent ?? null,
			links: input.links ?? [],
			prs: input.prs ?? [],
			repo: input.repo ?? null,
			branch: input.branch ?? null,
			createdAt: ctx.now,
			updatedAt: ctx.now,
			stateSince: ctx.now,
			finishedAt: isFinal(ctx.config, state) ? ctx.now : null
		};
		await ctx.tx.insert(tasks).values(row);
		const task = toTask(row);
		await ctx.emit('task', row.id, null, task);
		const created: Node[] = [];
		await createSteps(ctx, row.id, [], input.steps ?? [], created);
		if (row.finishedAt) logFinish(ctx.projectId, task);
		return { task, nodes: created };
	});
}

async function createSteps(
	ctx: Ctx,
	taskId: string,
	parent: string[],
	steps: StepInput[],
	created: Node[]
): Promise<void> {
	for (const [index, step] of steps.entries()) {
		const segments = [...parent, step.key];
		created.push(await createNode(ctx, taskId, segments, stepInput(step, index)));
		await createSteps(ctx, taskId, segments, step.subtasks ?? [], created);
	}
}

function stepInput(step: StepInput, index: number): NodeInput {
	return {
		title: step.title,
		state: step.state,
		note: step.note,
		tags: step.tags,
		agent: step.agent,
		links: step.links,
		position: index
	};
}

function logFinish(projectId: string, task: Task): void {
	log('task.finish', {
		project: projectId,
		task: task.id,
		state: task.state,
		seconds: Math.round((Date.parse(task.updatedAt) - Date.parse(task.createdAt)) / 1000),
		tool: task.agent?.tool,
		model: task.agent?.model,
		tokens: task.agent?.tokens
	});
}

export async function patchTask(
	projectId: string,
	taskId: string,
	patch: TaskPatch
): Promise<Task> {
	return mutate(projectId, async (ctx) => {
		const old = await taskInProject(ctx, taskId);
		if (!old) throw new ApiError(404, 'task not found');
		return applyTaskPatch(ctx, old, patch);
	});
}

async function applyTaskPatch(ctx: Ctx, old: TaskRow, patch: TaskPatch): Promise<Task> {
	const taskId = old.id;
	if (patch.state !== undefined) assertState(ctx.config, patch.state);
	const stateChanged = patch.state !== undefined && patch.state !== old.state;
	const next = {
		title: patch.title ?? old.title,
		summary: patch.summary ?? old.summary,
		state: patch.state ?? old.state,
		note: patch.note ?? (stateChanged ? '' : old.note),
		agent: mergeAgent(old.agent, patch.agent),
		links: patch.links ?? old.links ?? [],
		prs: patch.prs ?? old.prs ?? [],
		repo: patch.repo ?? old.repo,
		branch: patch.branch ?? old.branch
	};
	const changed =
		next.title !== old.title ||
		next.summary !== old.summary ||
		next.state !== old.state ||
		next.note !== old.note ||
		next.repo !== old.repo ||
		next.branch !== old.branch ||
		!same(next.agent, old.agent) ||
		!same(next.links, old.links ?? []) ||
		!same(next.prs, old.prs ?? []);
	if (!changed) return toTask(old);
	const row: TaskRow = {
		...old,
		...next,
		updatedAt: ctx.now,
		stateSince: stateChanged ? ctx.now : old.stateSince,
		finishedAt: stateChanged ? (isFinal(ctx.config, next.state) ? ctx.now : null) : old.finishedAt
	};
	await ctx.tx
		.update(tasks)
		.set({
			...next,
			updatedAt: row.updatedAt,
			stateSince: row.stateSince,
			finishedAt: row.finishedAt
		})
		.where(eq(tasks.id, taskId));
	const task = toTask(row);
	await ctx.emit('task', taskId, null, task);
	if (stateChanged && row.finishedAt) logFinish(ctx.projectId, task);
	return task;
}
