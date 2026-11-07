import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import * as schema from './schema.ts';
import { DATABASE_URL } from '$app/env/private';

if (!DATABASE_URL) throw new Error('DATABASE_URL is not set');

// UTC sessions: the Bundle carries timestamps as zone-less UTC text.
export const pool = new pg.Pool({
	connectionString: DATABASE_URL,
	max: 10,
	options: '-c timezone=UTC'
});

// An idle client dropped by the server must not crash the process.
pool.on('error', () => {});

export const db = drizzle(pool, { schema });
