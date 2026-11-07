import { resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { sql } from 'drizzle-orm';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { db } from '#lib/server/db/index.ts';

const CONNECT_ATTEMPTS = 30;
const CONNECT_DELAY_MS = 2_000;

export async function bootstrap(): Promise<void> {
	await waitForDatabase();
	await migrate(db, { migrationsFolder: resolve('drizzle') });
}

async function waitForDatabase(): Promise<void> {
	for (let attempt = 1; ; attempt++) {
		try {
			await db.execute(sql`select 1`);
			return;
		} catch (error) {
			if (attempt >= CONNECT_ATTEMPTS) throw error;
			console.warn(`Database not reachable (attempt ${attempt}/${CONNECT_ATTEMPTS}); retrying…`);
			await sleep(CONNECT_DELAY_MS);
		}
	}
}
