import { db } from '#lib/server/db/index.ts';
import { users } from '#lib/server/db/schema.ts';
import type { Viewer } from '#lib/server/identity.ts';

const MAX_REMEMBERED = 10_000;
const known = new Set<string>();

/** Inserts the user the first time this process sees them; later requests cost nothing. */
export async function recordUser(viewer: Viewer): Promise<void> {
	if (known.has(viewer.uid)) return;
	await db
		.insert(users)
		.values({
			uid: viewer.uid,
			email: viewer.email?.slice(0, 320) ?? null,
			name: viewer.name?.slice(0, 255) ?? null
		})
		.onConflictDoNothing();
	if (known.size >= MAX_REMEMBERED) known.clear();
	known.add(viewer.uid);
}

export const forgetUsers = () => known.clear();
