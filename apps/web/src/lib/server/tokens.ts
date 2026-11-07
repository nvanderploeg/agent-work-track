import { createHash, randomBytes } from 'node:crypto';
import { and, eq, isNull, lt, sql } from 'drizzle-orm';
import { ApiError } from '#lib/server/api.ts';
import { db } from '#lib/server/db/index.ts';
import { apiTokens, deviceCodes } from '#lib/server/db/schema.ts';

export const TOKEN_PREFIX = 'cht_';
export const DEVICE_TTL_MS = 10 * 60 * 1000;
export const DEVICE_POLL_SECONDS = 3;
const TOUCH_AFTER_MS = 60_000;
// No 0/O/1/I: a user code is read off one screen and typed into another.
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');

export function bearer(request: Request): string | undefined {
	return /^Bearer\s+(\S+)\s*$/i.exec(request.headers.get('authorization') ?? '')?.[1];
}

export const isApiToken = (value: string | undefined): value is string =>
	value?.startsWith(TOKEN_PREFIX) === true;

/** The uid a live token belongs to, or undefined when it is unknown or revoked. */
export async function ownerOfToken(
	token: string
): Promise<{ id: string; uid: string } | undefined> {
	const [row] = await db
		.select()
		.from(apiTokens)
		.where(and(eq(apiTokens.tokenHash, sha256(token)), isNull(apiTokens.revokedAt)));
	if (!row) return undefined;
	if (!row.lastUsedAt || Date.now() - row.lastUsedAt.getTime() > TOUCH_AFTER_MS) {
		await db.update(apiTokens).set({ lastUsedAt: new Date() }).where(eq(apiTokens.id, row.id));
	}
	return { id: row.id, uid: row.ownerUid };
}

/** Like `ownerOfToken`, for a request that must carry one. */
export async function requireToken(request: Request): Promise<{ id: string; uid: string }> {
	const token = bearer(request);
	if (!isApiToken(token)) throw new ApiError(401, 'missing token');
	const owner = await ownerOfToken(token);
	if (!owner) throw new ApiError(403, 'invalid token');
	return owner;
}

export async function mintToken(uid: string, label: string): Promise<string> {
	const token = `${TOKEN_PREFIX}${randomBytes(32).toString('base64url')}`;
	await db.insert(apiTokens).values({
		id: crypto.randomUUID(),
		ownerUid: uid,
		tokenHash: sha256(token),
		label
	});
	return token;
}

export async function listTokens(uid: string) {
	return db
		.select({
			id: apiTokens.id,
			label: apiTokens.label,
			createdAt: apiTokens.createdAt,
			lastUsedAt: apiTokens.lastUsedAt
		})
		.from(apiTokens)
		.where(and(eq(apiTokens.ownerUid, uid), isNull(apiTokens.revokedAt)))
		.orderBy(apiTokens.createdAt);
}

/** True when a live token of `uid` was revoked. */
export async function revokeToken(uid: string, id: string): Promise<boolean> {
	const rows = await db
		.update(apiTokens)
		.set({ revokedAt: new Date() })
		.where(and(eq(apiTokens.id, id), eq(apiTokens.ownerUid, uid), isNull(apiTokens.revokedAt)))
		.returning({ id: apiTokens.id });
	return rows.length > 0;
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
	{ status: 'pending' } | { status: 'gone' } | { status: 'approved'; token: string };

/** An approved code is spent by the poll that sees it: it mints the token and removes the row. */
export async function pollDevice(deviceCode: string): Promise<DevicePoll> {
	const hash = sha256(deviceCode);
	const [row] = await db.select().from(deviceCodes).where(eq(deviceCodes.deviceHash, hash));
	if (!row || row.expiresAt.getTime() <= Date.now()) return { status: 'gone' };
	if (!row.ownerUid) return { status: 'pending' };
	const spent = await db
		.delete(deviceCodes)
		.where(eq(deviceCodes.deviceHash, hash))
		.returning({ label: deviceCodes.label });
	if (!spent.length) return { status: 'gone' };
	return { status: 'approved', token: await mintToken(row.ownerUid, spent[0].label) };
}
