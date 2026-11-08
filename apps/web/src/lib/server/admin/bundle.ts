import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdir, mkdtemp, readdir, readFile, rename, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { getTableConfig, type PgColumn, type PgTable } from 'drizzle-orm/pg-core';
import pg from 'pg';
import Cursor from 'pg-cursor';
import { ADMIN_BACKUP_DIR, ADMIN_MAX_UNPACKED_MB } from '$app/env/private';
import { ApiError } from '#lib/server/api.ts';
import { pool } from '#lib/server/db/index.ts';
import { events, nodes, notices, projects, tasks } from '#lib/server/db/schema.ts';
import { log } from '#lib/server/log.ts';
import { drainRequests } from '#lib/server/inflight.ts';
import { imageCache } from '#lib/server/images.ts';
import { endStreams } from '#lib/server/stream.ts';
import {
	checkEntryName,
	readDirectory,
	readEntry,
	writeZip,
	ZipError,
	type ZipEntry,
	type ZipSource
} from '#lib/server/admin/zip.ts';
import pkg from '../../../../package.json' with { type: 'json' };

export const FORMAT = 1;
export const SERVICE = 'chronicle';
export const DB_FILE = 'db.ndjson';
export const MANIFEST_FILE = 'manifest.json';
const BACKUPS_KEPT = 5;
const MAX_LINE_BYTES = 40 << 20;
const MAX_MANIFEST_BYTES = 1 << 20;
const BATCH_ROWS = 500;
const DRAIN_MS = 30_000;
const CURSOR_ROWS = 256;
const LEGACY_SCHEMAS = [
	'0000_init',
	'0001_events_task_index',
	'0002_agent_links_notes',
	'0003_review_state',
	'0004_task_prs',
	'0005_notices',
	'0006_images'
];

// Only SQLSTATE classes 22 (data exception) and 23 (integrity violation) blame the Bundle.
export function isRowError(error: unknown): error is Error & { code: string } {
	const code = (error as { code?: unknown } | null)?.code;
	return typeof code === 'string' && /^2[23]/.test(code);
}

// Parents before children. Images are deliberately absent: their bytes live in server memory only,
// so an imported Task has none and the images table is emptied.
export const BUNDLE_TABLES: Record<string, PgTable> = {
	projects,
	tasks,
	nodes,
	notices,
	events
};
const WIPE_ORDER = ['events', 'images', 'notices', 'nodes', 'tasks', 'projects'];

export interface Manifest {
	format: number;
	service: string;
	appVersion: string;
	schema: string;
	createdAt: string;
	files: { path: string; size: number; sha256: string }[];
}

export function migrationsDir(): string {
	return resolve('drizzle');
}

export async function readJournal(): Promise<{ tag: string; when: number }[]> {
	const journal = JSON.parse(await readFile(join(migrationsDir(), 'meta/_journal.json'), 'utf8'));
	return journal.entries;
}

export async function journalTags(): Promise<string[]> {
	return (await readJournal()).map((entry) => entry.tag);
}

function columnsOf(table: PgTable) {
	return getTableConfig(table).columns;
}

const INTEGER_OIDS = new Set([20, 21, 23]);

const rawTypes = {
	getTypeParser: (oid: number) => (INTEGER_OIDS.has(oid) ? Number : (text: string) => text)
};

function selectExpression(column: PgColumn): string {
	const name = `"${column.name}"`;
	return column.columnType === 'PgTimestamp'
		? `to_char(${name} AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS.MS')`
		: name;
}

async function* dumpDatabase(conn: pg.PoolClient): AsyncGenerator<Buffer> {
	for (const [name, table] of Object.entries(BUNDLE_TABLES)) {
		const columns = columnsOf(table);
		const names = columns.map((column) => column.name);
		yield Buffer.from(`${JSON.stringify({ table: name, columns: names })}\n`);
		const cursor = conn.query(
			new Cursor(`SELECT ${columns.map(selectExpression).join(', ')} FROM "${name}"`, [], {
				rowMode: 'array',
				types: rawTypes
			})
		);
		let pending = '';
		for (;;) {
			const batch = await cursor.read(CURSOR_ROWS);
			if (!batch.length) break;
			for (const row of batch) pending += `${JSON.stringify(row)}\n`;
			if (pending.length > 1 << 16) {
				yield Buffer.from(pending);
				pending = '';
			}
		}
		await cursor.close();
		if (pending) yield Buffer.from(pending);
	}
}

// Read every table inside the one snapshot the first query fixes.
// Write the manifest last: sizes and hashes exist only once the files are sent.
export async function* exportBundle(): AsyncGenerator<Buffer> {
	const tags = await journalTags();
	const conn = await pool.connect();
	let complete = false;
	try {
		await conn.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
		await conn.query('SET LOCAL statement_timeout = 0');
		await conn.query('SELECT pg_current_snapshot()');
		const hash = createHash('sha256');
		let size = 0;
		async function* entries(): AsyncGenerator<ZipSource> {
			yield {
				name: DB_FILE,
				data: (async function* () {
					for await (const chunk of dumpDatabase(conn)) {
						hash.update(chunk);
						size += chunk.length;
						yield chunk;
					}
				})()
			};
			const manifest: Manifest = {
				format: FORMAT,
				service: SERVICE,
				appVersion: pkg.version,
				schema: tags[tags.length - 1],
				createdAt: new Date().toISOString(),
				files: [{ path: DB_FILE, size, sha256: hash.digest('hex') }]
			};
			yield {
				name: MANIFEST_FILE,
				data: (async function* () {
					yield Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`);
				})()
			};
		}
		yield* writeZip(entries());
		complete = true;
	} finally {
		if (complete) {
			await conn.query('ROLLBACK').catch(() => {});
			conn.release();
		} else {
			conn.release(true);
		}
	}
}

export function bundleName(date = new Date()): string {
	return `chronicle-${date.toISOString().replace(/[:.]/g, '-')}.zip`;
}

let busy = false;
let freezing = false;

/** True while the database is being replaced; ordinary /api requests answer 503. */
export const isImporting = () => freezing;

export function assertIdle(): void {
	if (busy) refuse('an import is already running', 409);
}

const ZIP_LIMIT_BYTES = 3.5 * 1024 ** 3;

/** Refuses up front an export whose tables alone would pass the 4 GiB a streamed zip can address. */
export async function assertExportable(): Promise<void> {
	const { rows } = await pool.query<{ bytes: string }>(
		`SELECT COALESCE(SUM(pg_table_size(to_regclass(quote_ident(t)))), 0) AS bytes
		 FROM unnest($1::text[]) AS t`,
		[Object.keys(BUNDLE_TABLES)]
	);
	if (Number(rows[0].bytes) > ZIP_LIMIT_BYTES) {
		throw new ApiError(413, 'the database is too large for a single-zip bundle (4 GiB limit)');
	}
}

export interface VerifiedBundle {
	manifest: Manifest;
	entries: Map<string, ZipEntry>;
}

function refuse(message: string, status = 422): never {
	throw new ApiError(status, message);
}

function guard<T>(work: Promise<T>): Promise<T> {
	return work.catch((error) => {
		if (error instanceof ZipError) refuse(`bundle rejected: ${error.message}`);
		throw error;
	});
}

async function slurp(source: AsyncIterable<Buffer>, limit: number): Promise<Buffer> {
	const parts: Buffer[] = [];
	let total = 0;
	for await (const chunk of source) {
		total += chunk.length;
		if (total > limit) refuse('bundle rejected: manifest is too large');
		parts.push(chunk);
	}
	return Buffer.concat(parts);
}

// Everything checked before any write: structure, schema level, and every file's size and hash.
export async function verifyBundle(
	path: string,
	maxUnpackedBytes?: number
): Promise<VerifiedBundle> {
	const cap = maxUnpackedBytes ?? ADMIN_MAX_UNPACKED_MB * 1024 * 1024;
	const list = await guard(
		readDirectory(path, { maxEntries: 8, maxEntryBytes: cap, maxTotalBytes: cap })
	);
	const entries = new Map(list.map((entry) => [entry.name, entry]));
	const manifestEntry = entries.get(MANIFEST_FILE);
	if (!manifestEntry) refuse('bundle rejected: manifest.json is missing');

	let manifest: Manifest;
	try {
		manifest = JSON.parse(
			(await guard(slurp(readEntry(path, manifestEntry), MAX_MANIFEST_BYTES))).toString('utf8')
		);
	} catch (error) {
		if (error instanceof ApiError) throw error;
		refuse('bundle rejected: manifest.json is not valid JSON');
	}
	if (manifest.format !== FORMAT) refuse(`bundle rejected: unsupported format ${manifest.format}`);
	if (manifest.service !== SERVICE)
		refuse(`bundle rejected: made by ${manifest.service}, not chronicle`);
	if (typeof manifest.schema !== 'string' || !Array.isArray(manifest.files)) {
		refuse('bundle rejected: malformed manifest');
	}

	const tags = await journalTags();
	if (!tags.includes(manifest.schema) && !LEGACY_SCHEMAS.includes(manifest.schema)) {
		refuse(
			`bundle rejected: schema ${JSON.stringify(manifest.schema)} is newer than this build (latest ${tags[tags.length - 1]})`,
			409
		);
	}

	const listed = new Set<string>();
	for (const file of manifest.files) {
		if (
			typeof file?.path !== 'string' ||
			!Number.isInteger(file.size) ||
			!/^[0-9a-f]{64}$/.test(file.sha256 ?? '')
		) {
			refuse('bundle rejected: malformed manifest file entry');
		}
		try {
			checkEntryName(file.path);
		} catch (error) {
			refuse(`bundle rejected: ${(error as Error).message}`);
		}
		if (listed.has(file.path)) refuse('bundle rejected: manifest lists a file twice');
		listed.add(file.path);
	}
	const extra = [...entries.keys()].filter((name) => name !== MANIFEST_FILE && !listed.has(name));
	if (extra.length) refuse(`bundle rejected: unlisted file ${JSON.stringify(extra[0])}`);
	if (!listed.has(DB_FILE) || listed.size !== 1) {
		refuse(`bundle rejected: a Bundle holds ${DB_FILE} and nothing else`);
	}

	for (const file of manifest.files) {
		const entry = entries.get(file.path);
		if (!entry) refuse(`bundle rejected: ${file.path} is missing`);
		if (entry.size !== file.size)
			refuse(`bundle rejected: ${file.path} size differs from the manifest`);
		const hash = createHash('sha256');
		let size = 0;
		await guard(
			(async () => {
				for await (const chunk of readEntry(path, entry)) {
					hash.update(chunk);
					size += chunk.length;
				}
			})()
		);
		if (size !== file.size || hash.digest('hex') !== file.sha256) {
			refuse(`bundle rejected: ${file.path} fails its checksum`);
		}
	}
	return { manifest, entries };
}

async function* lines(source: AsyncIterable<Buffer>): AsyncGenerator<string> {
	let rest: Buffer = Buffer.alloc(0);
	for await (const chunk of source) {
		rest = rest.length ? Buffer.concat([rest, chunk]) : chunk;
		let at: number;
		while ((at = rest.indexOf(10)) >= 0) {
			yield rest.toString('utf8', 0, at);
			rest = rest.subarray(at + 1);
		}
		if (rest.length > MAX_LINE_BYTES) refuse('bundle rejected: a database line is absurdly long');
	}
	if (rest.length) yield rest.toString('utf8');
}

export async function backupDir(): Promise<string> {
	const dir = ADMIN_BACKUP_DIR ?? join(tmpdir(), 'chronicle-backups');
	await mkdir(dir, { recursive: true });
	return dir;
}

async function writeBackup(dir: string): Promise<string> {
	const target = join(dir, `chronicle-pre-import-${bundleName().slice('chronicle-'.length)}`);
	const partial = `${target}.part`;
	try {
		await pipeline(exportBundle(), createWriteStream(partial, { mode: 0o600 }));
		await rename(partial, target);
	} catch (error) {
		await rm(partial, { force: true });
		throw error;
	}
	try {
		const old = (await readdir(dir))
			.filter((name) => name.startsWith('chronicle-pre-import-') && name.endsWith('.zip'))
			.sort()
			.slice(0, -BACKUPS_KEPT);
		await Promise.all(old.map((name) => rm(join(dir, name), { force: true })));
	} catch (error) {
		log('admin.backup_prune_failed', { error: (error as Error).message });
	}
	return target;
}

function parseLine(line: string): unknown[] | { table?: unknown; columns?: unknown } {
	let parsed: unknown;
	try {
		parsed = JSON.parse(line);
	} catch {
		refuse('bundle rejected: db.ndjson is not valid');
	}
	if (parsed === null || typeof parsed !== 'object') {
		refuse('bundle rejected: db.ndjson holds a line that is neither a header nor a row');
	}
	return parsed as unknown[] | { table?: unknown; columns?: unknown };
}

function openTable(header: { table?: unknown; columns?: unknown }, rows: Record<string, number>) {
	const name = String(header.table);
	const target = Object.hasOwn(BUNDLE_TABLES, name) ? BUNDLE_TABLES[name] : undefined;
	if (!target || !Array.isArray(header.columns) || name in rows) {
		refuse(`bundle rejected: unexpected table ${JSON.stringify(name)}`);
	}
	const given = header.columns.map(String);
	const config = columnsOf(target);
	for (const column of config) {
		if (!given.includes(column.name) && column.notNull && !column.hasDefault) {
			refuse(`bundle rejected: ${name}.${column.name} is missing and has no default`);
		}
	}
	const known = new Set(config.map((column) => column.name));
	const pick = given.flatMap((column, index) => (known.has(column) ? [index] : []));
	rows[name] = 0;
	return {
		name,
		width: given.length,
		columns: pick.map((index) => given[index]),
		pick,
		pending: [] as unknown[][]
	};
}

// Reads db.ndjson once before anything is deleted: every table present once, rows the width of
// their header, and a Bundle that would leave no Projects only when the caller says so.
async function scanDatabase(path: string, entry: ZipEntry, allowEmpty: boolean): Promise<void> {
	const rows: Record<string, number> = {};
	let table: ReturnType<typeof openTable> | undefined;
	for await (const line of lines(readEntry(path, entry))) {
		if (line === '') continue;
		const parsed = parseLine(line);
		if (!Array.isArray(parsed)) {
			table = openTable(parsed, rows);
			continue;
		}
		if (!table || parsed.length !== table.width) {
			refuse('bundle rejected: a row does not match its table header');
		}
		rows[table.name]++;
	}
	for (const name of Object.keys(BUNDLE_TABLES)) {
		if (!(name in rows)) refuse(`bundle rejected: db.ndjson has no ${name} table`);
	}
	if (rows.projects === 0 && !allowEmpty) {
		refuse('bundle rejected: it holds no Projects; pass allow-empty=1 to wipe the server', 422);
	}
}

function assertNoNul(
	table: { name: string; columns: string[]; pending: unknown[][] },
	done: number
) {
	table.pending.forEach((row, r) =>
		row.forEach((value, c) => {
			if (typeof value === 'string' && value.includes('\0')) {
				refuse(
					`bundle rejected: ${table.name} row ${done + r + 1} column ${table.columns[c]} holds U+0000, which PostgreSQL text cannot store`
				);
			}
		})
	);
}

// Never let the events sequence fall behind imported rows or move backwards.
async function advanceEventSequence(conn: pg.PoolClient): Promise<void> {
	await conn.query(
		`SELECT setval(s.name, m.top)
		 FROM (SELECT pg_get_serial_sequence('events', 'seq') AS name) s,
			(SELECT MAX(seq) AS top FROM events) m
		 WHERE m.top > (SELECT COALESCE(MAX(last_value), 0) FROM pg_sequences
			WHERE schemaname || '.' || sequencename = s.name)`
	);
}

export interface ImportResult {
	schema: string;
	appVersion: string;
	backup: string;
	rows: Record<string, number>;
	/** Image records removed from the database; the in-memory bytes are dropped too. */
	imagesDropped: number;
	warnings: string[];
}

// Replace-everything, in one transaction: either the whole Bundle lands or the database is
// untouched. Rows from an older schema carry only the columns that existed then; the rest take
// their defaults.
export async function importBundle(
	path: string,
	options: { backupDir?: string; allowEmpty?: boolean; drainMs?: number } = {}
): Promise<ImportResult> {
	assertIdle();
	busy = true;
	try {
		const { manifest, entries } = await verifyBundle(path);
		const dbEntry = entries.get(DB_FILE)!;
		await scanDatabase(path, dbEntry, options.allowEmpty ?? false);

		freezing = true;
		if (!(await drainRequests(options.drainMs ?? DRAIN_MS))) {
			refuse('requests are still running; retry the import shortly', 503);
		}
		const backup = await writeBackup(options.backupDir ?? (await backupDir()));

		const conn = await pool.connect();
		const rows: Record<string, number> = {};
		let imagesDropped = 0;
		try {
			await conn.query('BEGIN');
			await conn.query("SET LOCAL TIME ZONE 'UTC'");
			await conn.query('SET LOCAL statement_timeout = 0');
			const counted = await conn.query<{ n: string }>('SELECT COUNT(*) AS n FROM "images"');
			imagesDropped = Number(counted.rows[0].n);
			for (const name of WIPE_ORDER) await conn.query(`DELETE FROM "${name}"`);

			let table: ReturnType<typeof openTable> | undefined;
			const flush = async () => {
				if (!table?.pending.length) return;
				const open = table;
				assertNoNul(open, rows[open.name]);
				const width = open.columns.length;
				const placeholders = open.pending
					.map((_, r) => `(${open.columns.map((_, c) => `$${r * width + c + 1}`).join(', ')})`)
					.join(', ');
				await conn.query(
					`INSERT INTO "${open.name}" (${open.columns.map((c) => `"${c}"`).join(', ')}) VALUES ${placeholders}`,
					open.pending.flat()
				);
				rows[open.name] += open.pending.length;
				open.pending = [];
			};
			for await (const line of lines(readEntry(path, dbEntry))) {
				if (line === '') continue;
				const parsed = parseLine(line);
				if (!Array.isArray(parsed)) {
					await flush();
					table = openTable(parsed, rows);
					continue;
				}
				if (!table || parsed.length !== table.width) {
					refuse('bundle rejected: a row does not match its table header');
				}
				table.pending.push(table.pick.map((i) => parsed[i]));
				if (table.pending.length >= BATCH_ROWS) await flush();
			}
			await flush();
			await advanceEventSequence(conn);
			await conn.query('COMMIT');
		} catch (error) {
			await conn.query('ROLLBACK').catch(() => {});
			await rm(backup, { force: true });
			if (error instanceof SyntaxError) refuse('bundle rejected: db.ndjson is not valid');
			if (error instanceof ZipError) refuse(`bundle rejected: ${error.message}`);
			if (isRowError(error)) refuse(`bundle rejected: ${error.message}`);
			throw error;
		} finally {
			conn.release();
		}

		// The swap is committed; nothing below may turn it into an error response.
		const warnings: string[] = [];
		const after = (step: string, work: () => void) => {
			try {
				work();
			} catch (error) {
				warnings.push(`${step}: ${(error as Error).message}`);
				log('admin.import_warning', { step, error: (error as Error).message });
			}
		};
		after('end streams', () => endStreams());
		after('drop cached images', () => void imageCache.clear());
		log('admin.import', { schema: manifest.schema, backup, images_dropped: imagesDropped });
		return {
			schema: manifest.schema,
			appVersion: manifest.appVersion,
			backup,
			rows,
			imagesDropped,
			warnings
		};
	} finally {
		busy = false;
		freezing = false;
	}
}

// Spools an upload to a private temp file, refusing past `maxBytes`. The caller removes `dir`.
export async function receiveUpload(
	request: Request,
	maxBytes: number
): Promise<{ dir: string; path: string }> {
	const declared = Number(request.headers.get('content-length') ?? 0);
	assertIdle();
	if (declared > maxBytes) refuse('bundle is larger than ADMIN_MAX_BUNDLE_MB allows', 413);
	if (!request.body) refuse('no bundle in the request body', 400);
	const dir = await mkdtemp(join(tmpdir(), 'chronicle-import-'));
	const path = join(dir, 'upload.zip');
	let total = 0;
	try {
		const counted = new TransformStream<Uint8Array, Uint8Array>({
			transform(chunk, controller) {
				total += chunk.length;
				if (total > maxBytes) {
					controller.error(new ApiError(413, 'bundle is larger than ADMIN_MAX_BUNDLE_MB allows'));
					return;
				}
				controller.enqueue(chunk);
			}
		});
		await pipeline(
			Readable.fromWeb(request.body.pipeThrough(counted) as never),
			createWriteStream(path, { mode: 0o600 })
		);
		return { dir, path };
	} catch (error) {
		await rm(dir, { recursive: true, force: true });
		throw error;
	}
}
