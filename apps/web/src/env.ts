import { defineEnvVars } from '@sveltejs/kit/env';

function positive(name: string, value: string | undefined, fallback: number): number {
	const number = value?.trim() ? Number(value) : fallback;
	if (!Number.isFinite(number) || number <= 0) throw new Error(`${name} must be a positive number`);
	return number;
}

export const variables = defineEnvVars({
	DATABASE_URL: { description: 'The database connection string.' },
	ORIGIN: {
		description:
			'Public base URL used in links the API returns, e.g. `https://chronicle.merc.camp`. Unset: the request origin.',
		schema: (value) => value?.trim().replace(/\/+$/, '') || undefined
	},
	CHRONICLE_IDLE_MS: {
		description: 'Milliseconds without a project write before its stream sends `idle` and closes.',
		schema: (value) => Number(value || 14_400_000)
	},
	CHRONICLE_WRITES_PER_WINDOW: {
		description:
			'Writes one client address may burst, refilled at this many per write window; excess gets 429. 0 disables the limit.',
		schema: (value) => Number(value || 120)
	},
	CHRONICLE_WRITE_WINDOW_MS: {
		description: 'Milliseconds over which a client address regains its full write burst.',
		schema: (value) => Number(value || 300_000)
	},
	CHRONICLE_IMAGE_CACHE_BYTES: {
		description:
			'Bytes of image data held in memory across all projects; the oldest images go first.',
		schema: (value) => Number(value || 83_886_080)
	},
	CHRONICLE_IMAGE_FINISHED_MS: {
		description: 'Milliseconds after a task finishes before its images are dropped.',
		schema: (value) => Number(value || 600_000)
	},
	CHRONICLE_IMAGE_IDLE_MS: {
		description:
			'Milliseconds without an event on an unfinished task before its images are dropped.',
		schema: (value) => Number(value || 1_800_000)
	},
	ADMIN_TOKEN: {
		description:
			'The Admin token: 16 to 256 characters, no whitespace. Unset: the admin portal and every `/api/admin` route answer 404.',
		schema: (value) => {
			const token = value?.trim();
			if (!token) return undefined;
			if (token.length < 16 || token.length > 256 || /\s/.test(token)) {
				throw new Error('ADMIN_TOKEN must be 16 to 256 characters with no whitespace');
			}
			return token;
		}
	},
	ADMIN_BACKUP_DIR: {
		description: 'Directory for the automatic pre-import backup Bundles. Unset: the OS temp dir.',
		schema: (value) => value?.trim() || undefined
	},
	ADMIN_MAX_BUNDLE_MB: {
		description: 'Largest Bundle an import accepts, in MiB of zip.',
		schema: (value) => positive('ADMIN_MAX_BUNDLE_MB', value, 256)
	},
	ADMIN_MAX_UNPACKED_MB: {
		description: 'Largest total unpacked size of a Bundle, in MiB.',
		schema: (value) => positive('ADMIN_MAX_UNPACKED_MB', value, 2048)
	},
	CHRONICLE_HEARTBEAT_MS: {
		description: 'Milliseconds between `: ping` heartbeats on a project stream.',
		schema: (value) => Number(value || 25_000)
	}
});
