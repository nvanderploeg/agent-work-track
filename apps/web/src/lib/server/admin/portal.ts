import { ApiError } from '#lib/server/api.ts';
import { pool } from '#lib/server/db/index.ts';
import { readJournal } from '#lib/server/admin/bundle.ts';
import { log } from '#lib/server/log.ts';
import { imageCache } from '#lib/server/images.ts';
import { endStreams } from '#lib/server/stream.ts';
import pkg from '../../../../package.json' with { type: 'json' };

const COUNTED = ['projects', 'tasks', 'nodes', 'notices', 'events', 'images'];

async function rows<T extends object>(sql: string, values: unknown[] = []): Promise<T[]> {
	return (await pool.query<T>(sql, values)).rows;
}

export async function stats() {
	const [{ bytes, name }] = await rows<{ bytes: number; name: string }>(
		`SELECT COALESCE(SUM(pg_total_relation_size(c.oid)), 0) AS bytes, current_database() AS name
		 FROM pg_class c WHERE c.relkind = 'r' AND c.relnamespace = current_schema()::regnamespace`
	);
	const counts: Record<string, number> = {};
	for (const table of COUNTED) {
		const [row] = await rows<{ n: number }>(`SELECT COUNT(*) AS n FROM "${table}"`);
		counts[table] = Number(row.n);
	}
	const journal = await readJournal();
	const applied = new Set(
		(await rows<{ created_at: string }>('SELECT created_at FROM drizzle.__drizzle_migrations')).map(
			(row) => Number(row.created_at)
		)
	);
	return {
		service: 'chronicle',
		appVersion: pkg.version,
		build: __GIT_HASH__,
		database: { name, bytes: Number(bytes) },
		counts,
		schema: journal.at(-1)?.tag ?? null,
		migrations: journal.map((entry) => ({ tag: entry.tag, applied: applied.has(entry.when) }))
	};
}

// `bytes` is the payload the Project's rows hold, not on-disk size.
export async function listProjects() {
	const found = await rows<{
		id: string;
		name: string;
		created_at: Date;
		last_write_at: Date;
		tasks: number;
		bytes: number;
	}>(
		`SELECT p.id, p.name, p.created_at, p.last_write_at,
			COALESCE(t.c, 0) AS tasks,
			COALESCE(t.b, 0) + COALESCE(n.b, 0) + COALESCE(e.b, 0) AS bytes
		 FROM projects p
		 LEFT JOIN (SELECT project_id, COUNT(*) c, SUM(octet_length(title) + octet_length(summary) + octet_length(note)) b
			FROM tasks GROUP BY project_id) t ON t.project_id = p.id
		 LEFT JOIN (SELECT t2.project_id, SUM(octet_length(n2.title) + octet_length(n2.note)) b
			FROM nodes n2 JOIN tasks t2 ON t2.id = n2.task_id GROUP BY t2.project_id) n ON n.project_id = p.id
		 LEFT JOIN (SELECT project_id, SUM(octet_length(payload::text)) b
			FROM events GROUP BY project_id) e ON e.project_id = p.id
		 ORDER BY p.last_write_at DESC`
	);
	const iso = (value: unknown) => new Date(value as string).toISOString();
	return found.map((project) => ({
		id: project.id,
		name: project.name,
		confirmPhrase: deletePhrase(project.name, project.id),
		tasks: Number(project.tasks),
		bytes: Number(project.bytes),
		createdAt: iso(project.created_at),
		lastActivityAt: iso(project.last_write_at)
	}));
}

/** The phrase a person types to delete a Project: names are not unique, so it carries the id's first eight characters. */
export const deletePhrase = (name: string, id: string) => `${name} (${id.slice(0, 8)})`;

export async function deleteProject(id: string, confirm: unknown) {
	const [project] = await rows<{ name: string }>('SELECT name FROM projects WHERE id = $1', [id]);
	if (!project) throw new ApiError(404, 'Project not found');
	if (typeof confirm !== 'string' || confirm !== deletePhrase(project.name, id)) {
		throw new ApiError(400, 'confirm must equal the Project name and id prefix exactly');
	}
	await pool.query('DELETE FROM projects WHERE id = $1', [id]);
	imageCache.clear(id);
	endStreams(id);
	log('admin.delete_project', { id });
	return { deleted: id };
}
