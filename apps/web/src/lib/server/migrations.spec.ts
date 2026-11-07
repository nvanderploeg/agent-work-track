import { sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { db } from './db/index.ts';
import { journalTags } from './admin/bundle.ts';

async function rows<T extends object>(query: ReturnType<typeof sql>): Promise<T[]> {
	return (await db.execute<T>(query)).rows;
}

describe('baseline migration', () => {
	it('is the only migration, applied once', async () => {
		expect(await journalTags()).toEqual(['0000_baseline']);
		const applied = await rows(sql`select 1 from drizzle.__drizzle_migrations`);
		expect(applied).toHaveLength(1);
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
