import { defineEnvVars } from '@sveltejs/kit/env';

export const variables = defineEnvVars({
	DATABASE_URL: { description: 'The database connection string.' },
	ORIGIN: {
		description:
			'Public base URL used in links the API returns, e.g. `https://chronicle.nanzero.com`. Unset: the request origin.',
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
	CHRONICLE_HEARTBEAT_MS: {
		description: 'Milliseconds between `: ping` heartbeats on a project stream.',
		schema: (value) => Number(value || 25_000)
	}
});
