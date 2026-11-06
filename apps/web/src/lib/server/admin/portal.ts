import type { RowDataPacket } from 'mysql2/promise';
import { ApiError } from '#lib/server/api.ts';
import { pool } from '#lib/server/db/index.ts';
import { readJournal } from '#lib/server/admin/bundle.ts';
import { log } from '#lib/server/log.ts';
import { imageCache } from '#lib/server/images.ts';
import { endStreams } from '#lib/server/stream.ts';
import pkg from '../../../../package.json' with { type: 'json' };

const COUNTED = ['projects', 'tasks', 'nodes', 'notices', 'events', 'images'];

async function rows<T = RowDataPacket>(sql: string, values: unknown[] = []): Promise<T[]> {
	const [result] = await pool.query(sql, values);
	return result as T[];
}

export async function stats() {
	const [{ bytes, name }] = await rows<{ bytes: number; name: string }>(
		`SELECT COALESCE(SUM(data_length + index_length), 0) AS bytes, DATABASE() AS name
		 FROM information_schema.tables WHERE table_schema = DATABASE()`
	);
	const counts: Record<string, number> = {};
	for (const table of COUNTED) {
		const [row] = await rows<{ n: number }>(`SELECT COUNT(*) AS n FROM \`${table}\``);
		counts[table] = Number(row.n);
	}
	const journal = await readJournal();
	const applied = new Set(
		(await rows<{ created_at: string }>('SELECT created_at FROM __drizzle_migrations')).map((row) =>
			Number(row.created_at)
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
		created_at: string;
		last_write_at: string;
		tasks: number;
		bytes: number;
	}>(
		`SELECT p.id, p.name, p.created_at, p.last_write_at,
			COALESCE(t.c, 0) AS tasks,
			COALESCE(t.b, 0) + COALESCE(n.b, 0) + COALESCE(e.b, 0) AS bytes
		 FROM projects p
		 LEFT JOIN (SELECT project_id, COUNT(*) c, SUM(LENGTH(title) + LENGTH(summary) + LENGTH(note)) b
			FROM tasks GROUP BY project_id) t ON t.project_id = p.id
		 LEFT JOIN (SELECT t2.project_id, SUM(LENGTH(n2.title) + LENGTH(n2.note)) b
			FROM nodes n2 JOIN tasks t2 ON t2.id = n2.task_id GROUP BY t2.project_id) n ON n.project_id = p.id
		 LEFT JOIN (SELECT project_id, SUM(LENGTH(CAST(payload AS CHAR))) b
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
	const [project] = await rows<{ name: string }>('SELECT name FROM projects WHERE id = ?', [id]);
	if (!project) throw new ApiError(404, 'Project not found');
	if (typeof confirm !== 'string' || confirm !== deletePhrase(project.name, id)) {
		throw new ApiError(400, 'confirm must equal the Project name and id prefix exactly');
	}
	await pool.query('DELETE FROM projects WHERE id = ?', [id]);
	imageCache.clear(id);
	endStreams(id);
	log('admin.delete_project', { id });
	return { deleted: id };
}
