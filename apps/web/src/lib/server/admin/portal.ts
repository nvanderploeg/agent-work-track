import { ApiError } from '#lib/server/api.ts';
import { TABLE_PREFIX } from '#lib/server/db/schema.ts';
import { setProjectOwner } from '#lib/server/store.ts';
import { parseOwnerTarget } from '#lib/server/validate.ts';
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
		const [row] = await rows<{ n: number }>(`SELECT COUNT(*) AS n FROM "${TABLE_PREFIX}${table}"`);
		counts[table] = Number(row.n);
	}
	const journal = await readJournal();
	const applied = new Set(
		(await rows<{ created_at: string }>('SELECT created_at FROM drizzle.chronicle_migrations')).map(
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
		owner_uid: string | null;
		owner_email: string | null;
		public: boolean;
	}>(
		`SELECT p.id, p.name, p.created_at, p.last_write_at, p.owner_uid, p.public, u.email AS owner_email,
			COALESCE(t.c, 0) AS tasks,
			COALESCE(t.b, 0) + COALESCE(n.b, 0) + COALESCE(e.b, 0) AS bytes
		 FROM chronicle_projects p
		 LEFT JOIN (SELECT project_id, COUNT(*) c, SUM(octet_length(title) + octet_length(summary) + octet_length(note)) b
			FROM chronicle_tasks GROUP BY project_id) t ON t.project_id = p.id
		 LEFT JOIN (SELECT t2.project_id, SUM(octet_length(n2.title) + octet_length(n2.note)) b
			FROM chronicle_nodes n2 JOIN chronicle_tasks t2 ON t2.id = n2.task_id GROUP BY t2.project_id) n ON n.project_id = p.id
		 LEFT JOIN (SELECT project_id, SUM(octet_length(payload::text)) b
			FROM chronicle_events GROUP BY project_id) e ON e.project_id = p.id
		 LEFT JOIN chronicle_users u ON u.uid = p.owner_uid
		 ORDER BY p.last_write_at DESC`
	);
	const iso = (value: unknown) => new Date(value as string).toISOString();
	return found.map((project) => ({
		id: project.id,
		name: project.name,
		confirmPhrase: deletePhrase(project.name, project.id),
		tasks: Number(project.tasks),
		bytes: Number(project.bytes),
		owner: project.owner_uid ? { uid: project.owner_uid, email: project.owner_email } : null,
		createdAt: iso(project.created_at),
		lastActivityAt: iso(project.last_write_at)
	}));
}

/** The phrase a person types to delete a Project: names are not unique, so it carries the id's first eight characters. */
export const deletePhrase = (name: string, id: string) => `${name} (${id.slice(0, 8)})`;

export async function deleteProject(id: string, confirm: unknown) {
	const [project] = await rows<{ name: string }>(
		'SELECT name FROM chronicle_projects WHERE id = $1',
		[id]
	);
	if (!project) throw new ApiError(404, 'Project not found');
	if (typeof confirm !== 'string' || confirm !== deletePhrase(project.name, id)) {
		throw new ApiError(400, 'confirm must equal the Project name and id prefix exactly');
	}
	await pool.query('DELETE FROM chronicle_projects WHERE id = $1', [id]);
	imageCache.clear(id);
	endStreams(id);
	log('admin.delete_project', { id });
	return { deleted: id };
}

/** Makes `body.uid`, or the signed-in user with `body.email`, the Owner. Visibility and the Write key are untouched. */
export async function assignOwner(id: string, body: Record<string, unknown>) {
	const target = parseOwnerTarget(body);
	const [project] = await rows<{ owner_uid: string | null }>(
		'SELECT owner_uid FROM chronicle_projects WHERE id = $1',
		[id]
	);
	if (!project) throw new ApiError(404, 'Project not found');
	let uid: string;
	let email: string | null = null;
	if ('uid' in target) {
		uid = target.uid;
	} else {
		const found = await rows<{ uid: string }>(
			'SELECT uid FROM chronicle_users WHERE lower(email) = $1',
			[target.email]
		);
		if (found.length === 0) {
			throw new ApiError(
				404,
				`no user with email ${target.email}: they must sign in to chronicle first`
			);
		}
		if (found.length > 1) {
			throw new ApiError(409, `more than one user has email ${target.email}: assign by uid`);
		}
		uid = found[0].uid;
		email = target.email;
	}
	const updated = await setProjectOwner(id, uid);
	if (project.owner_uid !== uid && !updated.public) endStreams(id);
	log('admin.assign_owner', { id, uid, from: project.owner_uid });
	return { id, owner: { uid, email }, public: updated.public };
}
