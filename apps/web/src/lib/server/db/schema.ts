import {
	bigserial,
	boolean,
	char,
	index,
	integer,
	json,
	pgTable,
	primaryKey,
	text,
	timestamp,
	varchar
} from 'drizzle-orm/pg-core';

const instant = (name: string) => timestamp(name, { precision: 3, withTimezone: true });
const now = (name: string) => instant(name).notNull().defaultNow();

export const projects = pgTable('projects', {
	id: varchar('id', { length: 36 }).primaryKey(),
	name: varchar('name', { length: 255 }).notNull(),
	notes: text('notes'),
	links: json('links'),
	writeKeyHash: char('write_key_hash', { length: 64 }).notNull(),
	config: json('config').notNull(),
	createdAt: now('created_at'),
	lastWriteAt: now('last_write_at')
});

export const tasks = pgTable(
	'tasks',
	{
		id: varchar('id', { length: 36 }).primaryKey(),
		projectId: varchar('project_id', { length: 36 })
			.notNull()
			.references(() => projects.id, { onDelete: 'cascade' }),
		title: text('title').notNull(),
		summary: text('summary').notNull(),
		state: varchar('state', { length: 32 }).notNull(),
		note: text('note').notNull(),
		agent: json('agent'),
		links: json('links'),
		prs: json('prs'),
		repo: varchar('repo', { length: 255 }),
		branch: varchar('branch', { length: 255 }),
		createdAt: now('created_at'),
		updatedAt: now('updated_at'),
		stateSince: now('state_since'),
		finishedAt: instant('finished_at')
	},
	(table) => [index('tasks_project_created_idx').on(table.projectId, table.createdAt)]
);

// Every `path` column is COLLATE "C" in the migration; keep it so.
export const nodes = pgTable(
	'nodes',
	{
		taskId: varchar('task_id', { length: 36 })
			.notNull()
			.references(() => tasks.id, { onDelete: 'cascade' }),
		path: varchar('path', { length: 512 }).notNull(),
		parentPath: varchar('parent_path', { length: 512 }),
		key: varchar('key', { length: 64 }).notNull(),
		depth: integer('depth').notNull(),
		title: text('title').notNull(),
		state: varchar('state', { length: 32 }).notNull(),
		note: text('note').notNull(),
		tags: json('tags').notNull(),
		agent: json('agent'),
		links: json('links'),
		position: integer('position').notNull(),
		createdAt: now('created_at'),
		updatedAt: now('updated_at'),
		stateSince: now('state_since')
	},
	(table) => [primaryKey({ columns: [table.taskId, table.path] })]
);

export const notices = pgTable(
	'notices',
	{
		id: varchar('id', { length: 36 }).primaryKey(),
		taskId: varchar('task_id', { length: 36 })
			.notNull()
			.references(() => tasks.id, { onDelete: 'cascade' }),
		path: varchar('path', { length: 512 }),
		kind: varchar('kind', { length: 16 }).notNull(),
		text: text('text').notNull(),
		createdAt: now('created_at')
	},
	(table) => [index('notices_task_created_idx').on(table.taskId, table.createdAt)]
);

export const images = pgTable(
	'images',
	{
		id: varchar('id', { length: 36 }).primaryKey(),
		taskId: varchar('task_id', { length: 36 })
			.notNull()
			.references(() => tasks.id, { onDelete: 'cascade' }),
		path: varchar('path', { length: 512 }),
		caption: varchar('caption', { length: 300 }).notNull(),
		review: boolean('review').notNull(),
		width: integer('width').notNull(),
		height: integer('height').notNull(),
		createdAt: now('created_at')
	},
	(table) => [index('images_task_created_idx').on(table.taskId, table.createdAt)]
);

export const events = pgTable(
	'events',
	{
		seq: bigserial('seq', { mode: 'number' }).primaryKey(),
		projectId: varchar('project_id', { length: 36 })
			.notNull()
			.references(() => projects.id, { onDelete: 'cascade' }),
		taskId: varchar('task_id', { length: 36 }),
		path: varchar('path', { length: 512 }),
		type: varchar('type', { length: 16 }).notNull(),
		payload: json('payload').notNull(),
		at: now('at')
	},
	(table) => [
		index('events_project_seq_idx').on(table.projectId, table.seq),
		index('events_task_path_seq_idx').on(table.taskId, table.path, table.seq)
	]
);
