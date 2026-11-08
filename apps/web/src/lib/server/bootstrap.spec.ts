import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DATABASE_URL } from '$app/env/private';
import { bootstrap } from './bootstrap.ts';

const FRESH = 'chronicle_bootstrap_test';

describe('bootstrap', () => {
	let admin: pg.Pool;
	let fresh: pg.Pool;

	beforeAll(async () => {
		admin = new pg.Pool({ connectionString: DATABASE_URL });
		await admin.query(`drop database if exists ${FRESH}`);
		await admin.query(`create database ${FRESH}`);
		const url = new URL(DATABASE_URL);
		url.pathname = `/${FRESH}`;
		fresh = new pg.Pool({ connectionString: url.toString(), max: 12 });
	});

	afterAll(async () => {
		await fresh.end();
		await admin.query(`drop database if exists ${FRESH}`);
		await admin.end();
	});

	it('lets several pods migrate a fresh database at once', async () => {
		const results = await Promise.allSettled([1, 2, 3, 4].map(() => bootstrap(fresh)));

		expect(results.map((r) => r.status)).toEqual(Array(4).fill('fulfilled'));
		const applied = await fresh.query(
			'select count(*)::int as n from drizzle.__drizzle_migrations'
		);
		expect(applied.rows[0].n).toBe(1);
	});
});
