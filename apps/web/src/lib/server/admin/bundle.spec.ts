import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { sql } from 'drizzle-orm';
import { getTableConfig } from 'drizzle-orm/pg-core';
import pg from 'pg';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DATABASE_URL } from '$app/env/private';
import { ApiError } from '#lib/server/api.ts';
import { db, pool } from '#lib/server/db/index.ts';
import { events, images, nodes, notices, projects, tasks } from '#lib/server/db/schema.ts';
import { trackRequest } from '#lib/server/inflight.ts';
import { createProjectStream, endStreams } from '#lib/server/stream.ts';
import { resetDb } from '#lib/server/test/db.ts';
import { DELETE as deleteProjectRoute } from '../../../routes/api/admin/projects/[id]/+server.ts';
import { GET as exportRoute } from '../../../routes/api/admin/export/+server.ts';
import { POST as importRoute } from '../../../routes/api/admin/import/+server.ts';
import { deletePhrase, deleteProject, listProjects, stats } from './portal.ts';
import {
	BUNDLE_TABLES,
	DB_FILE,
	exportBundle,
	importBundle,
	isImporting,
	isRowError,
	receiveUpload,
	journalTags,
	MANIFEST_FILE,
	verifyBundle,
	type Manifest
} from './bundle.ts';
import { readDirectory, readEntry, writeZip } from './zip.ts';

const ADMIN = { admin: { via: 'bearer', csrf: '' } };
const PROJECT = '11111111-1111-4111-8111-111111111111';
const TASK = '22222222-2222-4222-8222-222222222222';
const NASTY = `it's "quoted" \\ back\\slash\nnew line\ttab \u{1F680} end`;
const WRITE_KEY_HASH = createHash('sha256').update('ws_secret').digest('hex');

let dir: string;
beforeEach(async () => {
	await resetDb();
	dir = await mkdtemp(join(tmpdir(), 'bundlespec-'));
});
afterEach(() => rm(dir, { recursive: true, force: true }));

async function seed() {
	await db.insert(projects).values({
		id: PROJECT,
		name: 'Round trip',
		notes: NASTY,
		links: [{ url: 'https://example.com' }],
		writeKeyHash: WRITE_KEY_HASH,
		config: { theme: 'light', states: [] }
	});
	await db.insert(tasks).values({
		id: TASK,
		projectId: PROJECT,
		title: NASTY,
		summary: '',
		state: 'queued',
		note: '',
		agent: { tool: 'x' }
	});
	await db.insert(nodes).values({
		taskId: TASK,
		path: 'Chunk-1/Tests',
		parentPath: 'Chunk-1',
		key: 'Tests',
		depth: 2,
		title: NASTY,
		state: 'queued',
		note: '',
		tags: ['round 2'],
		position: 0
	});
	await db.insert(notices).values({
		id: '33333333-3333-4333-8333-333333333333',
		taskId: TASK,
		kind: 'assumption',
		text: NASTY
	});
	await db.insert(images).values({
		id: '44444444-4444-4444-8444-444444444444',
		taskId: TASK,
		caption: 'shot',
		review: false,
		width: 1,
		height: 1
	});
	await db.insert(events).values({
		projectId: PROJECT,
		taskId: TASK,
		type: 'task',
		payload: { title: NASTY }
	});
}

async function exportTo(name = 'out.zip'): Promise<string> {
	const path = join(dir, name);
	await pipeline(Readable.from(exportBundle()), createWriteStream(path));
	return path;
}

async function unpack(path: string): Promise<{ manifest: Manifest; db: string }> {
	const entries = await readDirectory(path, {
		maxEntries: 8,
		maxEntryBytes: 1 << 28,
		maxTotalBytes: 1 << 28
	});
	const text = async (name: string) => {
		const parts: Buffer[] = [];
		for await (const chunk of readEntry(
			path,
			entries.find((e) => e.name === name)!
		)) {
			parts.push(chunk);
		}
		return Buffer.concat(parts).toString('utf8');
	};
	return { manifest: JSON.parse(await text(MANIFEST_FILE)), db: await text(DB_FILE) };
}

async function repack(
	name: string,
	files: Record<string, string>,
	manifest?: (m: Manifest) => Manifest | Record<string, unknown>
): Promise<string> {
	const sha = (s: string) => createHash('sha256').update(s).digest('hex');
	const base: Manifest = {
		format: 1,
		service: 'chronicle',
		appVersion: '0.0.0',
		schema: (await journalTags()).at(-1)!,
		createdAt: new Date().toISOString(),
		files: Object.entries(files).map(([path, data]) => ({
			path,
			size: Buffer.byteLength(data),
			sha256: sha(data)
		}))
	};
	const all = { ...files, [MANIFEST_FILE]: JSON.stringify(manifest ? manifest(base) : base) };
	async function* entries() {
		for (const [entry, data] of Object.entries(all)) {
			yield {
				name: entry,
				data: (async function* () {
					yield Buffer.from(data);
				})()
			};
		}
	}
	const path = join(dir, name);
	await pipeline(Readable.from(writeZip(entries())), createWriteStream(path));
	return path;
}

const headers = (names: string[] = Object.keys(BUNDLE_TABLES)) =>
	names
		.map((table) =>
			JSON.stringify({
				table,
				columns: getTableConfig(BUNDLE_TABLES[table]).columns.map((c) => c.name)
			})
		)
		.join('\n') + '\n';

const MiB = 1024 * 1024;

const rejected = (work: Promise<unknown>, status: number, message: RegExp) =>
	expect(work).rejects.toMatchObject({ status, message: expect.stringMatching(message) });

const dump = async () => ({
	projects: await db.select().from(projects),
	tasks: await db.select().from(tasks),
	nodes: await db.select().from(nodes),
	notices: await db.select().from(notices),
	events: await db.select().from(events)
});

describe('export', () => {
	it('writes a manifest in the shared shape, listing db with a true size and hash', async () => {
		await seed();
		const { manifest, db: text } = await unpack(await exportTo());
		expect(Object.keys(manifest).sort()).toEqual(
			['appVersion', 'createdAt', 'files', 'format', 'schema', 'service'].sort()
		);
		expect(manifest.format).toBe(1);
		expect(manifest.service).toBe('chronicle');
		expect(manifest.schema).toBe((await journalTags()).at(-1));
		expect(manifest.files).toEqual([
			{
				path: DB_FILE,
				size: Buffer.byteLength(text),
				sha256: createHash('sha256').update(text).digest('hex')
			}
		]);
	});

	it('leaves Images out', async () => {
		await seed();
		const { db: text } = await unpack(await exportTo());
		expect(text).not.toMatch(/"table":"images"/);
		expect(text).not.toContain('44444444-4444');
	});

	it('dumps the snapshot taken when it opened, not writes that land mid-stream', async () => {
		await seed();
		const stream = exportBundle();
		const first = (await stream.next()).value as Buffer;
		await db
			.insert(events)
			.values({ projectId: PROJECT, type: 'task', payload: { late: 'marker' } });
		const chunks: Buffer[] = [first];
		for await (const chunk of stream) chunks.push(chunk);

		const text = await unpack(await writeAll(chunks));
		expect(text.db).toContain('"table":"events"');
		expect(text.db).not.toContain('marker');
	});

	async function writeAll(chunks: Buffer[]): Promise<string> {
		const path = join(dir, 'late.zip');
		await writeFile(path, Buffer.concat(chunks));
		return path;
	}
});

describe('import', () => {
	it('restores everything, byte for byte, with the write key hash intact', async () => {
		await seed();
		const before = await dump();
		const first = await exportTo('a.zip');
		await resetDb();
		expect(await db.select().from(projects)).toEqual([]);

		const result = await importBundle(first, { backupDir: dir });

		expect(result.rows.projects).toBe(1);
		expect(await dump()).toEqual(before);
		expect(before.projects[0].writeKeyHash).toBe(WRITE_KEY_HASH);
		expect(before.tasks[0].title).toBe(NASTY);
		expect(await db.select().from(images)).toEqual([]);

		await resetDb();
		await importBundle(first, { backupDir: dir });
		expect((await unpack(await exportTo('b.zip'))).db).toBe((await unpack(first)).db);
	});

	it('keeps foreign keys working after the swap', async () => {
		await seed();
		await importBundle(await exportTo(), { backupDir: dir });
		await db.delete(projects);
		expect(await db.select().from(tasks)).toEqual([]);
	});

	it('replaces what is there, empties Images, and backs the old state up first', async () => {
		await seed();
		const bundle = await exportTo();
		await db.insert(projects).values({
			id: '55555555-5555-4555-8555-555555555555',
			name: 'Extra',
			writeKeyHash: WRITE_KEY_HASH,
			config: {}
		});

		const result = await importBundle(bundle, { backupDir: dir });

		expect((await db.select().from(projects)).map((p) => p.id)).toEqual([PROJECT]);
		expect(await db.select().from(images)).toEqual([]);
		expect((await unpack(result.backup)).db).toContain('Extra');
		expect(await readdir(dir)).toContain(result.backup.split('/').at(-1));
	});

	it('keeps only the newest five backups', async () => {
		await seed();
		const bundle = await exportTo();
		for (let i = 0; i < 7; i++) await importBundle(bundle, { backupDir: dir });

		const backups = (await readdir(dir)).filter((n) => n.startsWith('chronicle-pre-import-'));
		expect(backups).toHaveLength(5);
	});

	it('leaves the database untouched when the bundle fails validation', async () => {
		await seed();
		const { db: text } = await unpack(await exportTo());
		const tampered = await repack('t.zip', { [DB_FILE]: text }, (m) => ({
			...m,
			files: [{ ...m.files[0], sha256: '0'.repeat(64) }]
		}));

		await rejected(importBundle(tampered, { backupDir: dir }), 422, /checksum/);

		expect(await db.select().from(projects)).toHaveLength(1);
	});

	it('refuses a tampered database file even when the manifest still lists the old hash', async () => {
		await seed();
		const { db: text, manifest } = await unpack(await exportTo());
		const forged = await repack(
			'f.zip',
			{ [DB_FILE]: text.replace('Round trip', 'Round trap') },
			() => manifest
		);

		await rejected(verifyBundle(forged), 422, /size|checksum/);
	});

	it('refuses a bundle from a newer schema than this build', async () => {
		const { db: text } = await unpack(await exportTo());
		const newer = await repack('n.zip', { [DB_FILE]: text }, (m) => ({
			...m,
			schema: '9999_from_the_future'
		}));

		await rejected(importBundle(newer, { backupDir: dir }), 409, /newer than this build/);
	});

	it('refuses wrong format, wrong service and unlisted or extra files', async () => {
		const { db: text } = await unpack(await exportTo());
		await rejected(
			verifyBundle(await repack('f.zip', { [DB_FILE]: text }, (m) => ({ ...m, format: 2 }))),
			422,
			/format/
		);
		await rejected(
			verifyBundle(await repack('s.zip', { [DB_FILE]: text }, (m) => ({ ...m, service: 'sagas' }))),
			422,
			/not chronicle/
		);
		await rejected(
			verifyBundle(
				await repack('x.zip', { [DB_FILE]: text, 'extra.txt': 'x' }, (m) => ({
					...m,
					files: m.files.slice(0, 1)
				}))
			),
			422,
			/unlisted/
		);
		await rejected(verifyBundle(await repack('e.zip', { 'other.bin': 'x' })), 422, /holds db/);
	});

	it('refuses zip-slip names in the zip and in the manifest', async () => {
		const { db: text } = await unpack(await exportTo());
		await rejected(
			verifyBundle(await repack('z.zip', { '../db.ndjson': text })),
			422,
			/unsafe entry name/
		);
		await rejected(
			verifyBundle(
				await repack('m.zip', { [DB_FILE]: text }, (m) => ({
					...m,
					files: [{ ...m.files[0], path: '../../etc/passwd' }]
				}))
			),
			422,
			/unsafe entry name/
		);
	});

	it('refuses absurd sizes', async () => {
		await seed();
		const { db: text } = await unpack(await exportTo());
		const path = await repack('big.zip', { [DB_FILE]: text });

		await rejected(verifyBundle(path, 10), 422, /too large|unpacks too large/);
	});

	it('refuses a file that is not a zip', async () => {
		const path = join(dir, 'junk.zip');
		await writeFile(path, 'hello');

		await rejected(verifyBundle(path), 422, /not a zip/);
	});

	it('refuses a table it does not know, leaving the data alone', async () => {
		await seed();
		const bad = await repack('evil.zip', {
			[DB_FILE]: `${JSON.stringify({ table: 'pg_catalog.pg_user', columns: ['id'] })}\n["x"]\n`
		});

		await rejected(importBundle(bad, { backupDir: dir }), 422, /unexpected table/);

		expect(await db.select().from(projects)).toHaveLength(1);
	});

	it('rolls the whole swap back when a row is bad', async () => {
		await seed();
		const header = JSON.stringify({
			table: 'projects',
			columns: ['id', 'name', 'write_key_hash', 'config']
		});
		const bad = await repack('bad.zip', {
			[DB_FILE]: `${header}\n["dup","a","${'a'.repeat(64)}","{}"]\n["dup","b","${'b'.repeat(64)}","{}"]\n`
		});

		await expect(importBundle(bad, { backupDir: dir })).rejects.toThrow();

		expect((await db.select().from(projects)).map((p) => p.id)).toEqual([PROJECT]);
	});

	it('imports a bundle from an older schema, filling columns it lacks', async () => {
		const header = JSON.stringify({
			table: 'projects',
			columns: ['id', 'name', 'write_key_hash', 'config']
		});
		const rest = headers(Object.keys(BUNDLE_TABLES).filter((t) => t !== 'projects'));
		const old = await repack(
			'old.zip',
			{
				[DB_FILE]: `${header}\n${JSON.stringify([PROJECT, 'Old', 'c'.repeat(64), '{}'])}\n${rest}`
			},
			(m) => ({ ...m, schema: '0001_events_task_index' })
		);

		await importBundle(old, { backupDir: dir });

		expect((await db.select().from(projects))[0].name).toBe('Old');
	});

	it('ends open streams with a reset so dashboards reload', async () => {
		await seed();
		const bundle = await exportTo();
		const stream = (await createProjectStream(PROJECT))!;
		const reader = stream.getReader();
		const chunks: string[] = [];
		const done = (async () => {
			for (;;) {
				const { value, done: finished } = await reader.read();
				if (finished) return;
				chunks.push(new TextDecoder().decode(value));
			}
		})();

		await importBundle(bundle, { backupDir: dir });
		await done;

		expect(chunks.join('')).toContain('event: reset');
		endStreams();
	});

	it('serves one import at a time', async () => {
		await seed();
		const bundle = await exportTo();
		const results = await Promise.allSettled([
			importBundle(bundle, { backupDir: dir }),
			importBundle(bundle, { backupDir: dir })
		]);

		expect(results.map((r) => r.status).sort()).toEqual(['fulfilled', 'rejected']);
		const failure = results.find((r) => r.status === 'rejected') as PromiseRejectedResult;
		expect(failure.reason).toBeInstanceOf(ApiError);
	});
});

describe('routes', () => {
	it('streams a bundle from GET and takes it back on POST only with the confirmation', async () => {
		await seed();
		const res = await exportRoute({ locals: ADMIN } as never);
		expect(res.headers.get('content-type')).toBe('application/zip');
		const bytes = Buffer.from(await res.arrayBuffer());
		await resetDb();

		const post = (query: string) => {
			const url = new URL(`http://chronicle.test/api/admin/import${query}`);
			return importRoute({
				locals: ADMIN,
				request: new Request(url, {
					method: 'POST',
					body: bytes,
					headers: { 'content-type': 'application/zip' }
				}),
				url
			} as never);
		};

		expect((await post('')).status).toBe(400);
		expect(await db.select().from(projects)).toEqual([]);
		const ok = await post('?confirm=replace-everything');
		expect(ok.status).toBe(200);
		expect(await db.select().from(projects)).toHaveLength(1);
		expect(await readFile((await ok.json()).backup)).toBeTruthy();
	});
});

describe('portal', () => {
	it('reports health, and lists Projects with Task counts, sizes and activity', async () => {
		await seed();
		const report = await stats();
		expect(report.counts.projects).toBe(1);
		expect(report.counts.tasks).toBe(1);
		expect(report.database.bytes).toBeGreaterThan(0);
		expect(report.migrations.every((m: { applied: boolean }) => m.applied)).toBe(true);

		const [listed] = await listProjects();
		expect(listed).toMatchObject({ id: PROJECT, name: 'Round trip', tasks: 1 });
		expect(listed.bytes).toBeGreaterThan(0);
		expect(listed.lastActivityAt).toBeTruthy();
	});

	it('deletes only on the exact typed name, taking its Tasks along', async () => {
		await seed();
		await rejected(deleteProject(PROJECT, 'Round trip'), 400, /confirm/);
		expect(await db.select().from(projects)).toHaveLength(1);

		const res = await deleteProjectRoute({
			locals: ADMIN,
			params: { id: PROJECT },
			request: new Request('http://x', {
				method: 'DELETE',
				body: JSON.stringify({ confirm: deletePhrase('Round trip', PROJECT) })
			})
		} as never);

		expect(res.status).toBe(200);
		expect(await db.select().from(projects)).toEqual([]);
		expect(await db.select().from(tasks)).toEqual([]);
	});

	it('releases its connection when an export is abandoned or finishes', async () => {
		await seed();
		for (let i = 0; i < 12; i++) {
			const abandoned = exportBundle();
			await abandoned.next();
			await abandoned.return(undefined);
		}
		await expect(exportTo()).resolves.toMatch(/out\.zip$/);
	});
});

describe('guards on the bundle itself', () => {
	it('refuses a rehashed bundle with no Projects unless asked to wipe', async () => {
		await seed();
		const empty = await repack('empty.zip', { [DB_FILE]: headers() });

		await rejected(importBundle(empty, { backupDir: dir }), 422, /no Projects/);
		expect(await db.select().from(projects)).toHaveLength(1);

		await importBundle(empty, { backupDir: dir, allowEmpty: true });
		expect(await db.select().from(projects)).toEqual([]);
	});

	it('refuses a bundle missing a table, before deleting anything', async () => {
		await seed();
		const partial = await repack('partial.zip', {
			[DB_FILE]: headers(['projects', 'nodes', 'notices', 'events'])
		});

		await rejected(importBundle(partial, { backupDir: dir }), 422, /no tasks table/);
		expect(await db.select().from(projects)).toHaveLength(1);
	});

	it('reports the dropped image records and keeps request freezing off until the backup starts', async () => {
		await seed();
		const bundle = await exportTo();

		const result = await importBundle(bundle, { backupDir: dir });

		expect(result.imagesDropped).toBe(1);
		expect(result.warnings).toEqual([]);
		expect(isImporting()).toBe(false);
	});
});

describe('hardening', () => {
	it('waits for in-flight requests and answers 503 when they do not finish', async () => {
		await seed();
		const bundle = await exportTo();
		const done = trackRequest();

		await rejected(importBundle(bundle, { backupDir: dir, drainMs: 20 }), 503, /still running/);
		expect(isImporting()).toBe(false);
		expect(await readdir(dir)).not.toContain(expect.stringMatching(/^chronicle-pre-import/));

		const waiting = importBundle(bundle, { backupDir: dir, drainMs: 5000 });
		setTimeout(done, 50);
		await expect(waiting).resolves.toMatchObject({ rows: expect.any(Object) });
	});

	it('maps a row the schema refuses to a 422 and removes the useless backup', async () => {
		await seed();
		const { db: text } = await unpack(await exportTo());
		const orphaned = await repack('orphan.zip', {
			[DB_FILE]: text.replace(
				`["${TASK}","${PROJECT}"`,
				`["${TASK}","99999999-9999-4999-8999-999999999999"`
			)
		});

		await rejected(importBundle(orphaned, { backupDir: dir }), 422, /bundle rejected/);

		expect(await db.select().from(projects)).toHaveLength(1);
		expect((await readdir(dir)).filter((n) => n.startsWith('chronicle-pre-import'))).toEqual([]);
	});

	it('rejects db.ndjson lines that are null or a number', async () => {
		await seed();
		for (const bad of ['null', '5', '"x"']) {
			const path = await repack('bad.zip', { [DB_FILE]: `${bad}\n` });
			await rejected(importBundle(path, { backupDir: dir }), 422, /neither a header nor a row/);
		}
	});

	it('refuses a duplicate import before spooling any bytes', async () => {
		await seed();
		const bundle = await exportTo();
		const first = importBundle(bundle, { backupDir: dir });
		const request = new Request('http://x/y', { method: 'POST', body: Buffer.alloc(10) });

		await rejected(receiveUpload(request, MiB), 409, /already running/);
		await first;
	});

	it('survives more aborted exports than the pool has connections', async () => {
		await seed();
		const rows = Array.from({ length: 2000 }, () => ({
			projectId: PROJECT,
			type: 'task',
			payload: {
				blob: Buffer.from(Array.from({ length: 4000 }, () => Math.random() * 256)).toString(
					'base64'
				)
			}
		}));
		await db.insert(events).values(rows);

		for (let i = 0; i < 25; i++) {
			const stream = exportBundle();
			await stream.next();
			await stream.next();
			await stream.return(undefined);
		}

		const alive = await Promise.race([
			pool.query('SELECT 1').then(() => true),
			new Promise((resolve) => setTimeout(() => resolve(false), 5000))
		]);
		expect(alive).toBe(true);
		await expect(exportTo('after.zip')).resolves.toMatch(/after\.zip$/);
	});

	it('dumps and restores timestamps as UTC', async () => {
		await seed();
		await db.execute(sql`update projects set created_at = '2026-01-02 03:04:05.678'`);
		const bundle = await exportTo();
		expect((await unpack(bundle)).db).toContain('2026-01-02 03:04:05.678');

		await resetDb();
		await importBundle(bundle, { backupDir: dir });

		const [row] = await db.select().from(projects);
		expect(row.createdAt.toISOString()).toBe('2026-01-02T03:04:05.678Z');
	});
});

describe('import of a MySQL-era bundle', () => {
	const mysqlBundle = () => {
		const lines = [
			{
				table: 'projects',
				columns: [
					'id',
					'name',
					'notes',
					'links',
					'write_key_hash',
					'config',
					'created_at',
					'last_write_at'
				]
			},
			[
				PROJECT,
				'From MySQL',
				null,
				null,
				WRITE_KEY_HASH,
				'{"theme": "light", "states": [{"key": "q", "kind": "pending"}]}',
				'2026-01-02 03:04:05.678',
				'2026-01-02 03:04:06.000'
			],
			{
				table: 'tasks',
				columns: [
					'id',
					'project_id',
					'title',
					'summary',
					'state',
					'note',
					'agent',
					'links',
					'prs',
					'repo',
					'branch',
					'created_at',
					'updated_at',
					'state_since',
					'finished_at'
				]
			},
			[
				TASK,
				PROJECT,
				'T',
				'',
				'q',
				'',
				null,
				null,
				null,
				null,
				null,
				'2026-01-02 03:04:05.678',
				'2026-01-02 03:04:05.678',
				'2026-01-02 03:04:05.678',
				null
			],
			{
				table: 'nodes',
				columns: [
					'task_id',
					'path',
					'parent_path',
					'key',
					'depth',
					'title',
					'state',
					'note',
					'tags',
					'agent',
					'links',
					'position',
					'created_at',
					'updated_at',
					'state_since'
				]
			},
			[
				TASK,
				'A/b',
				'A',
				'b',
				2,
				'B',
				'q',
				'',
				'["round 2"]',
				null,
				null,
				0,
				'2026-01-02 03:04:05.678',
				'2026-01-02 03:04:05.678',
				'2026-01-02 03:04:05.678'
			],
			{ table: 'notices', columns: ['id', 'task_id', 'path', 'kind', 'text', 'created_at'] },
			{
				table: 'events',
				columns: ['seq', 'project_id', 'task_id', 'path', 'type', 'payload', 'at']
			},
			[41, PROJECT, TASK, null, 'task', '{"a": 1}', '2026-01-02 03:04:05.678'],
			[
				42,
				PROJECT,
				null,
				null,
				'config',
				'{"config": {"theme": "light"}}',
				'2026-01-02 03:04:05.679'
			]
		];
		return lines.map((line) => JSON.stringify(line)).join('\n') + '\n';
	};

	it('loads rows, keeps JSON text and UTC instants, and keeps seq above the last event', async () => {
		const path = await repack('mysql.zip', { [DB_FILE]: mysqlBundle() }, (m) => ({
			...m,
			schema: '0006_images'
		}));

		const result = await importBundle(path, { backupDir: dir });

		expect(result.rows).toMatchObject({ projects: 1, tasks: 1, nodes: 1, events: 2 });
		const [project] = await db.select().from(projects);
		expect(project.createdAt.toISOString()).toBe('2026-01-02T03:04:05.678Z');
		expect(project.config).toEqual({ theme: 'light', states: [{ key: 'q', kind: 'pending' }] });
		const raw = await db.execute(sql`select config::text as text from projects`);
		expect(raw.rows[0].text).toBe(
			'{"theme": "light", "states": [{"key": "q", "kind": "pending"}]}'
		);
		const [next] = await db
			.insert(events)
			.values({ projectId: PROJECT, type: 'task', payload: {} })
			.returning({ seq: events.seq });
		expect(next.seq).toBeGreaterThan(42);
	});

	it('exports what it imported byte for byte', async () => {
		const first = await repack('mysql.zip', { [DB_FILE]: mysqlBundle() });
		await importBundle(first, { backupDir: dir });

		const { db: text } = await unpack(await exportTo());

		expect(text).toBe(mysqlBundle());
	});

	const nextSeq = async () => {
		const [row] = await db
			.insert(events)
			.values({ projectId: PROJECT, type: 'task', payload: {} })
			.returning({ seq: events.seq });
		return row.seq;
	};
	const setSequence = (value: number, called: boolean) =>
		db.execute(sql`select setval('events_seq_seq', ${value}, ${called})`);

	it('continues seq right after the last imported event', async () => {
		await setSequence(1, false);
		const path = await repack('mysql.zip', { [DB_FILE]: mysqlBundle() });

		await importBundle(path, { backupDir: dir });

		expect(await nextSeq()).toBe(43);
	});

	it('leaves seq alone when it is already above the last imported event', async () => {
		await setSequence(5000, true);
		const path = await repack('mysql.zip', { [DB_FILE]: mysqlBundle() });

		await importBundle(path, { backupDir: dir });

		expect(await nextSeq()).toBe(5001);
	});

	it('names the table, row and column of a U+0000 and refuses with a 422', async () => {
		const path = await repack('nul.zip', {
			[DB_FILE]: mysqlBundle().replace('"From MySQL"', '"From\\u0000MySQL"')
		});

		await rejected(
			importBundle(path, { backupDir: dir }),
			422,
			/projects row 1 column name holds U\+0000, which PostgreSQL text cannot store/
		);
	});

	it('round trips exactly while the database defaults to another time zone', async () => {
		const admin = new pg.Client({ connectionString: DATABASE_URL });
		await admin.connect();
		const name = (await admin.query('select current_database() as name')).rows[0].name;
		await admin.query(`alter database "${name}" set timezone to 'America/Los_Angeles'`);
		try {
			await admin.query(
				'select pg_terminate_backend(pid) from pg_stat_activity where datname = $1 and pid <> pg_backend_pid()',
				[name]
			);
			await new Promise((resolve) => setTimeout(resolve, 300));
			const zones = await Promise.all(
				Array.from({ length: 10 }, async () => {
					const client = await pool.connect();
					try {
						return (await client.query('show timezone')).rows[0].TimeZone;
					} finally {
						client.release();
					}
				})
			);
			expect(new Set(zones)).toEqual(new Set(['America/Los_Angeles']));
			const first = await repack('mysql.zip', { [DB_FILE]: mysqlBundle() });
			await importBundle(first, { backupDir: dir });

			const { db: text } = await unpack(await exportTo());

			expect(text).toBe(mysqlBundle());
			const [project] = await db.select().from(projects);
			expect(project.createdAt.toISOString()).toBe('2026-01-02T03:04:05.678Z');
		} finally {
			await admin.query(`alter database "${name}" reset timezone`);
			await admin.end();
		}
	});
});

describe('isRowError', () => {
	it.each(['22001', '22P02', '22021', '23502', '23503', '23505'])(
		'classifies %s as the bundle',
		(code) => {
			expect(isRowError(Object.assign(new Error('x'), { code }))).toBe(true);
		}
	);

	it.each(['08006', '40001', '53300', '57P01', '42P01'])('leaves %s to the server', (code) => {
		expect(isRowError(Object.assign(new Error('x'), { code }))).toBe(false);
	});

	it('ignores errors without a SQLSTATE', () => {
		expect(isRowError(new Error('x'))).toBe(false);
		expect(isRowError(null)).toBe(false);
	});
});
