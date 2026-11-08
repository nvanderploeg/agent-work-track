import { setTimeout as sleep } from 'node:timers/promises';
import { describe, expect, it, vi } from 'vitest';
import { pool } from './index.ts';

describe('pool', () => {
	it('survives a checked-out connection killed by the server', async () => {
		const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
		const client = await pool.connect();
		await client.query('BEGIN');
		const pid = (await client.query('select pg_backend_pid() as pid')).rows[0].pid;

		await pool.query('select pg_terminate_backend($1)', [pid]);
		await sleep(200);
		client.release(true);

		expect(logged).toHaveBeenCalledWith(expect.stringContaining('database connection error'));
		expect((await pool.query('select 1 as one')).rows[0].one).toBe(1);
		logged.mockRestore();
	});

	it('limits idle transactions and statements, with a bounded connect wait', async () => {
		const settings = (
			await pool.query(
				`select current_setting('idle_in_transaction_session_timeout') as idle,
					current_setting('statement_timeout') as statement`
			)
		).rows[0];
		expect(settings).toEqual({ idle: '10min', statement: '1min' });
	});
});
