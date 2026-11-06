declare global {
	const __APP_VERSION__: string;
	const __GIT_HASH__: string;

	namespace App {
		interface Locals {
			// Set by the admin gate for /admin and /api/admin requests that carry credentials.
			admin?: { via: 'bearer' | 'cookie'; csrf: string };
		}
	}
}

export {};
