import { resolve } from 'node:path';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import pg from 'pg';

export default async function setup(): Promise<void> {
	const connectionString = process.env.DATABASE_URL;
	if (!connectionString) throw new Error('DATABASE_URL is not set');

	const client = new pg.Client({ connectionString });
	await client.connect();
	try {
		await migrate(drizzle(client), {
			migrationsFolder: resolve(import.meta.dirname, '../../../../drizzle')
		});
	} finally {
		await client.end();
	}
}
