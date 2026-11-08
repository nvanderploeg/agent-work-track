import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import * as schema from './schema.ts';
import { DATABASE_URL } from '$app/env/private';

if (!DATABASE_URL) throw new Error('DATABASE_URL is not set');

const SESSION_SETTINGS = `SET idle_in_transaction_session_timeout = 600000; SET statement_timeout = 60000`;

const report = (error: Error) => console.error(`database connection error: ${error.message}`);

// The client's own 'error' listener must outlive checkout: the pool detaches its listener then.
class SessionClient extends pg.Client {
	constructor(config?: string | pg.ClientConfig) {
		super(config);
		this.on('error', report);
	}

	connect(): Promise<this>;
	connect(callback: (error: Error) => void): void;
	connect(callback: (error: null, client: pg.Client) => void): void;
	connect(
		callback?: ((error: Error) => void) | ((error: null, client: pg.Client) => void)
	): Promise<this> | void {
		const ready = super.connect().then(async () => {
			await this.query(SESSION_SETTINGS);
			return this;
		});
		if (!callback) return ready;
		const done = callback as (error: Error | null, client?: pg.Client) => void;
		ready.then(
			() => done(null, this),
			(error) => done(error)
		);
	}
}

export const pool = new pg.Pool({
	connectionString: DATABASE_URL,
	Client: SessionClient,
	max: 10,
	keepAlive: true,
	connectionTimeoutMillis: 10_000
});

pool.on('error', report);

export const db = drizzle(pool, { schema });
