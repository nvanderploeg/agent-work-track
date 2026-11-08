import { defineConfig } from 'vitest/config';
import tailwindcss from '@tailwindcss/vite';
import adapter from '@sveltejs/adapter-node';
import { sveltekit } from '@sveltejs/kit/vite';
import { buildInfo } from './build-info.ts';

export default defineConfig(({ mode, command }) => {
	// Set before the sveltekit plugin loads the environment; the real environment wins.
	if (mode === 'test') {
		process.env.ADMIN_TOKEN ??= 'test-admin-token-0123456789';
		process.env.DATABASE_URL ??= 'postgres://chronicle:chronicle@127.0.0.1:5436/chronicle_test';
	}
	if (mode === 'development') {
		process.env.DATABASE_URL ??= 'postgres://chronicle:chronicle@127.0.0.1:5436/chronicle_dev';
	}
	// Route analysis imports server modules; the runtime environment supplies the real value.
	if (command === 'build') {
		process.env.DATABASE_URL ??= 'postgres://build:build@127.0.0.1:5432/build';
	}

	return {
		define: buildInfo(),
		plugins: [
			tailwindcss(),
			sveltekit({
				compilerOptions: {
					// Force runes mode for the project, except for libraries. Can be removed in svelte 6.
					runes: ({ filename }) =>
						filename.split(/[/\\]/).includes('node_modules') ? undefined : true
				},
				adapter: adapter()
			})
		],
		test: {
			expect: { requireAssertions: true },
			projects: [
				{
					extends: './vite.config.ts',
					test: {
						name: 'server',
						environment: 'node',
						include: ['src/**/*.{test,spec}.{js,ts}'],
						exclude: ['src/**/*.svelte.{test,spec}.{js,ts}'],
						globalSetup: ['./src/lib/server/test/global-setup.ts'],
						fileParallelism: false
					}
				}
			]
		}
	};
});
