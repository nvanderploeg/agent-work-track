import { resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import type pg from 'pg';
import { pool as appPool } from '#lib/server/db/index.ts';

const CONNECT_ATTEMPTS = 30;
const CONNECT_DELAY_MS = 2_000;
const MIGRATION_LOCK = 7_262_024_001;

export async function bootstrap(pool: pg.Pool = appPool): Promise<void> {
	await waitForDatabase(pool);
	const lock = await pool.connect();
	try {
		await lock.query('SELECT pg_advisory_lock($1)', [MIGRATION_LOCK]);
		await migrate(drizzle(pool), { migrationsFolder: resolve('drizzle') });
	} finally {
		await lock.query('SELECT pg_advisory_unlock($1)', [MIGRATION_LOCK]).catch(() => {});
		lock.release();
	}
}

async function waitForDatabase(pool: pg.Pool): Promise<void> {
	for (let attempt = 1; ; attempt++) {
		try {
			await pool.query('select 1');
			return;
		} catch (error) {
			if (attempt >= CONNECT_ATTEMPTS) throw error;
			console.warn(`Database not reachable (attempt ${attempt}/${CONNECT_ATTEMPTS}); retrying…`);
			await sleep(CONNECT_DELAY_MS);
		}
	}
}
