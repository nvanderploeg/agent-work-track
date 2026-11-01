import { DATABASE_URL } from '$app/env/private';
import { db } from '#lib/server/db/index.ts';
import { events, images, nodes, notices, projects, tasks } from '#lib/server/db/schema.ts';

export async function resetDb(): Promise<void> {
	const database = new URL(DATABASE_URL).pathname.slice(1);
	if (!database.endsWith('_test')) {
		throw new Error(`refusing to wipe "${database}": tests need a database named *_test`);
	}
	await db.delete(events);
	await db.delete(images);
	await db.delete(notices);
	await db.delete(nodes);
	await db.delete(tasks);
	await db.delete(projects);
}
