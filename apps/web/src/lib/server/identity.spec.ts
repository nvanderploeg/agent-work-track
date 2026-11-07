import { beforeEach, describe, expect, it, vi } from 'vitest';

const auth = vi.hoisted(() => ({
	verifyIdToken: vi.fn(),
	createSessionCookie: vi.fn(),
	verifySessionCookie: vi.fn(),
	createCustomToken: vi.fn(),
	revokeRefreshTokens: vi.fn()
}));

vi.mock('firebase-admin/app', () => ({
	cert: (json: unknown) => json,
	getApps: () => [],
	initializeApp: () => ({})
}));
vi.mock('firebase-admin/auth', () => ({ getAuth: () => auth }));

const {
	createSession,
	customTokenFor,
	isIdToken,
	revokeTools,
	verifyBearer,
	verifySession,
	webConfig
} = await import('./identity.ts');

const claims = (authTime: number) => ({
	uid: 'u1',
	email: 'a@example.com',
	name: 'Ada',
	picture: 'https://example.com/a.png',
	auth_time: authTime
});
const now = () => Math.floor(Date.now() / 1000);

beforeEach(() => vi.resetAllMocks());

describe('createSession', () => {
	it('exchanges a fresh ID token for a session cookie', async () => {
		auth.verifyIdToken.mockResolvedValue(claims(now() - 10));
		auth.createSessionCookie.mockResolvedValue('cookie-value');

		const result = await createSession('id-token');

		expect(result.cookie).toBe('cookie-value');
		expect(result.viewer).toEqual({
			uid: 'u1',
			email: 'a@example.com',
			name: 'Ada',
			picture: 'https://example.com/a.png'
		});
		expect(auth.createSessionCookie).toHaveBeenCalledWith('id-token', {
			expiresIn: 5 * 24 * 60 * 60 * 1000
		});
	});

	it('refuses an ID token Firebase rejects', async () => {
		auth.verifyIdToken.mockRejectedValue(
			Object.assign(new Error('bad'), { code: 'auth/argument-error' })
		);

		await expect(createSession('x')).rejects.toMatchObject({ status: 401 });
		expect(auth.createSessionCookie).not.toHaveBeenCalled();
	});

	it('refuses an ID token signed in more than five minutes ago', async () => {
		auth.verifyIdToken.mockResolvedValue(claims(now() - 301));

		await expect(createSession('old')).rejects.toMatchObject({ status: 401 });
		expect(auth.createSessionCookie).not.toHaveBeenCalled();
	});
});

describe('createSession provider', () => {
	it('refuses a tool login token, which is a custom-token sign-in', async () => {
		auth.verifyIdToken.mockResolvedValue({
			...claims(now() - 10),
			firebase: { sign_in_provider: 'custom' }
		});

		await expect(createSession('tool-token')).rejects.toMatchObject({ status: 403 });
		expect(auth.createSessionCookie).not.toHaveBeenCalled();
	});

	it('accepts a browser sign-in provider', async () => {
		auth.verifyIdToken.mockResolvedValue({
			...claims(now() - 10),
			firebase: { sign_in_provider: 'google.com' }
		});
		auth.createSessionCookie.mockResolvedValue('cookie');

		expect((await createSession('browser-token')).cookie).toBe('cookie');
	});

	it('reports 503, not 401, when Firebase cannot answer', async () => {
		auth.verifyIdToken.mockRejectedValue(new Error('ECONNRESET'));

		await expect(createSession('x')).rejects.toMatchObject({ status: 503 });
	});
});

describe('verification failures', () => {
	const failure = (code?: string) => Object.assign(new Error('boom'), code ? { code } : {});

	it.each([
		'auth/id-token-expired',
		'auth/id-token-revoked',
		'auth/argument-error',
		'auth/user-disabled'
	])('treat %s as an invalid token', async (code) => {
		auth.verifyIdToken.mockRejectedValue(failure(code));

		expect(await verifyBearer(`invalid-${code}`)).toBeNull();
	});

	it.each([undefined, 'auth/internal-error', 'auth/quota-exceeded', 'app/network-error'])(
		'treat %s as an outage, never as an invalid token',
		async (code) => {
			auth.verifyIdToken.mockRejectedValue(failure(code));
			auth.verifySessionCookie.mockRejectedValue(failure(code));

			await expect(verifyBearer(`outage-${code}`)).rejects.toMatchObject({ status: 503 });
			await expect(verifySession(`outage-${code}`)).rejects.toMatchObject({ status: 503 });
		}
	);

	it('are not cached', async () => {
		auth.verifyIdToken.mockRejectedValueOnce(failure('auth/id-token-revoked'));
		auth.verifyIdToken.mockResolvedValueOnce({ uid: 'u9' });

		expect(await verifyBearer('retry-token')).toBeNull();
		expect((await verifyBearer('retry-token'))?.uid).toBe('u9');
	});
});

describe('revocation checks', () => {
	it('are shared by requests within a few seconds, then repeated', async () => {
		vi.useFakeTimers();
		try {
			auth.verifyIdToken.mockResolvedValue({ uid: 'u10' });

			await verifyBearer('burst-token');
			await verifyBearer('burst-token');
			expect(auth.verifyIdToken).toHaveBeenCalledTimes(1);

			vi.advanceTimersByTime(6000);
			await verifyBearer('burst-token');
			expect(auth.verifyIdToken).toHaveBeenCalledTimes(2);
		} finally {
			vi.useRealTimers();
		}
	});

	it('are forgotten for a user whose tokens were just revoked', async () => {
		auth.verifyIdToken.mockResolvedValue({ uid: 'u11' });
		await verifyBearer('soon-revoked');

		await revokeTools('u11');
		await verifyBearer('soon-revoked');

		expect(auth.verifyIdToken).toHaveBeenCalledTimes(2);
	});
});

describe('verifySession', () => {
	it('checks revocation, so signing out elsewhere ends the session', async () => {
		auth.verifySessionCookie.mockResolvedValue({ uid: 'u12' });

		await verifySession('cookie-revocation');

		expect(auth.verifySessionCookie).toHaveBeenCalledWith('cookie-revocation', true);
	});

	it('names the user a valid cookie belongs to', async () => {
		auth.verifySessionCookie.mockResolvedValue({ uid: 'u2' });

		expect(await verifySession('c-valid')).toEqual({
			uid: 'u2',
			email: null,
			name: null,
			picture: null
		});
	});

	it('treats a forged or expired cookie as signed out', async () => {
		auth.verifySessionCookie.mockRejectedValue(
			Object.assign(new Error('expired'), { code: 'auth/session-cookie-expired' })
		);

		expect(await verifySession('c-expired')).toBeNull();
	});
});

describe('verifyBearer', () => {
	it('checks revocation, so a revoked tool stops at once', async () => {
		auth.verifyIdToken.mockResolvedValue({ uid: 'u3' });

		expect((await verifyBearer('t-valid'))?.uid).toBe('u3');
		expect(auth.verifyIdToken).toHaveBeenCalledWith('t-valid', true);
	});

	it('is null for a token Firebase refuses', async () => {
		auth.verifyIdToken.mockRejectedValue(
			Object.assign(new Error('revoked'), { code: 'auth/id-token-revoked' })
		);

		expect(await verifyBearer('t-revoked')).toBeNull();
	});

	it('tells an ID token from a write key', () => {
		expect(isIdToken('eyJhbGciOi.eyJ1aWQiOiJ4In0.c2ln')).toBe(true);
		expect(isIdToken('ws_abc-def')).toBe(false);
		expect(isIdToken(undefined)).toBe(false);
	});
});

describe('tools', () => {
	it('mint a custom token for the approving user', async () => {
		auth.createCustomToken.mockResolvedValue('custom');

		expect(await customTokenFor('u4')).toBe('custom');
		expect(auth.createCustomToken).toHaveBeenCalledWith('u4');
	});

	it("are all disconnected by revoking the user's refresh tokens", async () => {
		await revokeTools('u5');

		expect(auth.revokeRefreshTokens).toHaveBeenCalledWith('u5');
	});
});

describe('webConfig', () => {
	it('hands the browser the project and its auth domain', () => {
		expect(webConfig()).toEqual({
			apiKey: 'test-api-key',
			authDomain: 'runestone-d3a35.firebaseapp.com',
			projectId: 'runestone-d3a35'
		});
	});
});
