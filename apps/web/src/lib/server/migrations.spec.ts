import { sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { db } from './db/index.ts';
import { journalTags } from './admin/bundle.ts';

async function rows<T extends object>(query: ReturnType<typeof sql>): Promise<T[]> {
	return (await db.execute<T>(query)).rows;
}

describe('migrations', () => {
	it('applies each journal entry once, baseline first', async () => {
		const tags = await journalTags();
		expect(tags[0]).toBe('0000_baseline');
		const applied = await rows(sql`select 1 from drizzle.__drizzle_migrations`);
		expect(applied).toHaveLength(tags.length);
	});

	it('leaves existing Projects anonymous and public, and Tasks private', async () => {
		const found = await rows<{ table_name: string; column_name: string; column_default: string }>(
			sql`select table_name, column_name, column_default from information_schema.columns
				where table_schema = current_schema() and column_name in ('owner_uid', 'public')
				order by table_name, column_name`
		);
		expect(found).toEqual([
			{ table_name: 'projects', column_name: 'owner_uid', column_default: null },
			{ table_name: 'projects', column_name: 'public', column_default: 'true' },
			{ table_name: 'tasks', column_name: 'public', column_default: 'false' }
		]);
	});

	it('sorts every path column bytewise', async () => {
		const found = await rows<{ table_name: string; column_name: string; collation_name: string }>(
			sql`select table_name, column_name, collation_name from information_schema.columns
				where table_schema = current_schema() and column_name in ('path', 'parent_path')`
		);
		expect(found.length).toBeGreaterThan(0);
		for (const column of found) expect(column.collation_name).toBe('C');
	});

	it('stores timestamps with millisecond precision and a zone', async () => {
		const found = await rows<{ data_type: string; datetime_precision: number }>(
			sql`select data_type, datetime_precision from information_schema.columns
				where table_schema = current_schema() and table_name = 'projects' and column_name = 'created_at'`
		);
		expect(found).toEqual([{ data_type: 'timestamp with time zone', datetime_precision: 3 }]);
	});
});
