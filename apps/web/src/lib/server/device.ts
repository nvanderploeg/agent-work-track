import { createHash, randomBytes } from 'node:crypto';
import { and, eq, isNull, lt, sql } from 'drizzle-orm';
import { ApiError } from '#lib/server/api.ts';
import { db } from '#lib/server/db/index.ts';
import { deviceCodes } from '#lib/server/db/schema.ts';
import { customTokenFor, isIdToken, verifyBearer, type Viewer } from '#lib/server/identity.ts';
import { recordUser } from '#lib/server/users.ts';

export const DEVICE_TTL_MS = 10 * 60 * 1000;
export const DEVICE_POLL_SECONDS = 3;
// No 0/O/1/I: a user code is read off one screen and typed into another.
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');

export function bearer(request: Request): string | undefined {
	return /^Bearer\s+(\S+)\s*$/i.exec(request.headers.get('authorization') ?? '')?.[1];
}

/** The user behind a request's Firebase ID token bearer, or null when it carries none that verifies. */
export async function bearerUser(request: Request): Promise<Viewer | null> {
	const token = bearer(request);
	if (!isIdToken(token)) return null;
	const viewer = await verifyBearer(token);
	if (viewer) await recordUser(viewer);
	return viewer;
}

/** Like `bearerUser`, for a request that must carry one. */
export async function requireBearerUser(request: Request): Promise<Viewer> {
	if (!isIdToken(bearer(request))) throw new ApiError(401, 'missing token');
	const viewer = await bearerUser(request);
	if (!viewer) throw new ApiError(403, 'invalid token');
	return viewer;
}

function newUserCode(): string {
	const bytes = randomBytes(8);
	const chars = Array.from(bytes, (b) => CODE_ALPHABET[b % CODE_ALPHABET.length]);
	return `${chars.slice(0, 4).join('')}-${chars.slice(4).join('')}`;
}

export const normaliseUserCode = (code: string): string =>
	code
		.toUpperCase()
		.replace(/[^A-Z0-9]/g, '')
		.replace(/^(.{4})(.+)$/, '$1-$2');

export async function startDevice(label: string) {
	await db.delete(deviceCodes).where(lt(deviceCodes.expiresAt, new Date()));
	const deviceCode = randomBytes(32).toString('base64url');
	const userCode = newUserCode();
	const expiresAt = new Date(Date.now() + DEVICE_TTL_MS);
	await db
		.insert(deviceCodes)
		.values({ deviceHash: sha256(deviceCode), userCode, label, expiresAt });
	return { deviceCode, userCode, expiresAt };
}

export async function deviceByUserCode(userCode: string) {
	const [row] = await db
		.select()
		.from(deviceCodes)
		.where(eq(deviceCodes.userCode, normaliseUserCode(userCode)));
	return row && row.expiresAt.getTime() > Date.now() ? row : undefined;
}

/** True when a pending, unexpired code was approved for `uid` or, when `uid` is null, denied. */
export async function answerDevice(userCode: string, uid: string | null): Promise<boolean> {
	const code = normaliseUserCode(userCode);
	if (uid === null) {
		const gone = await db
			.delete(deviceCodes)
			.where(and(eq(deviceCodes.userCode, code), sql`${deviceCodes.expiresAt} > now()`))
			.returning({ hash: deviceCodes.deviceHash });
		return gone.length > 0;
	}
	const rows = await db
		.update(deviceCodes)
		.set({ ownerUid: uid })
		.where(
			and(
				eq(deviceCodes.userCode, code),
				isNull(deviceCodes.ownerUid),
				sql`${deviceCodes.expiresAt} > now()`
			)
		)
		.returning({ hash: deviceCodes.deviceHash });
	return rows.length > 0;
}

export type DevicePoll =
	{ status: 'pending' } | { status: 'gone' } | { status: 'approved'; customToken: string };

/** An approved code is spent by the poll that sees it: it mints the custom token and removes the row. */
export async function pollDevice(deviceCode: string): Promise<DevicePoll> {
	const hash = sha256(deviceCode);
	const [row] = await db.select().from(deviceCodes).where(eq(deviceCodes.deviceHash, hash));
	if (!row || row.expiresAt.getTime() <= Date.now()) return { status: 'gone' };
	if (!row.ownerUid) return { status: 'pending' };
	const spent = await db
		.delete(deviceCodes)
		.where(eq(deviceCodes.deviceHash, hash))
		.returning({ hash: deviceCodes.deviceHash });
	if (!spent.length) return { status: 'gone' };
	return { status: 'approved', customToken: await customTokenFor(row.ownerUid) };
}
