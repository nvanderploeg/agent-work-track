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
		auth.verifyIdToken.mockRejectedValue(new Error('bad'));

		await expect(createSession('x')).rejects.toMatchObject({ status: 401 });
		expect(auth.createSessionCookie).not.toHaveBeenCalled();
	});

	it('refuses an ID token signed in more than five minutes ago', async () => {
		auth.verifyIdToken.mockResolvedValue(claims(now() - 301));

		await expect(createSession('old')).rejects.toMatchObject({ status: 401 });
		expect(auth.createSessionCookie).not.toHaveBeenCalled();
	});
});

describe('verifySession', () => {
	it('names the user a valid cookie belongs to', async () => {
		auth.verifySessionCookie.mockResolvedValue({ uid: 'u2' });

		expect(await verifySession('c')).toEqual({
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

		expect(await verifySession('c')).toBeNull();
	});
});

describe('verifyBearer', () => {
	it('checks revocation, so a revoked tool stops at once', async () => {
		auth.verifyIdToken.mockResolvedValue({ uid: 'u3' });

		expect((await verifyBearer('t'))?.uid).toBe('u3');
		expect(auth.verifyIdToken).toHaveBeenCalledWith('t', true);
	});

	it('is null for a token Firebase refuses', async () => {
		auth.verifyIdToken.mockRejectedValue(
			Object.assign(new Error('revoked'), { code: 'auth/id-token-revoked' })
		);

		expect(await verifyBearer('t')).toBeNull();
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
