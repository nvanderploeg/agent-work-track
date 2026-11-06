import { defineConfig } from '@playwright/test';

const port = 5191;

export default defineConfig({
	testDir: 'e2e',
	testMatch: ['*.capture.ts', '*.e2e.ts'],
	workers: 1,
	fullyParallel: false,
	timeout: 90_000,
	expect: { timeout: 15_000 },
	reporter: [['list']],
	outputDir: 'test-results',
	use: {
		baseURL: `http://localhost:${port}`,
		viewport: { width: 1280, height: 800 },
		video: { mode: 'on', size: { width: 1280, height: 800 } }
	},
	webServer: {
		command: `pnpm --filter web dev --port ${port} --strictPort`,
		url: `http://localhost:${port}/api/health`,
		reuseExistingServer: false,
		timeout: 120_000,
		env: {
			CHRONICLE_IDLE_MS: '8000',
			CHRONICLE_WRITES_PER_WINDOW: '0',
			ADMIN_TOKEN: 'e2e-admin-token-0123456789'
		}
	}
});
