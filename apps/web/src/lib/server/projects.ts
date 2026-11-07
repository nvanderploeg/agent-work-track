import { generateWriteKey, hashWriteKey } from '#lib/server/auth.ts';
import { log } from '#lib/server/log.ts';
import { publicOrigin } from '#lib/server/origin.ts';
import { insertProject } from '#lib/server/store.ts';
import { parseProjectCreate } from '#lib/server/validate.ts';

/** `ownerUid` null makes an anonymous Project; a uid makes a private one that uid owns. */
export async function createProject(
	body: Record<string, unknown>,
	url: URL,
	ip: string,
	ownerUid: string | null
): Promise<Response> {
	const { name, notes, links, config } = parseProjectCreate(body);
	const id = crypto.randomUUID();
	const writeKey = generateWriteKey();
	const now = new Date();
	await insertProject({
		id,
		name,
		notes,
		links,
		writeKeyHash: hashWriteKey(writeKey),
		config,
		ownerUid,
		public: ownerUid === null,
		createdAt: now,
		lastWriteAt: now
	});
	log('project.create', { id, name, ip, owned: ownerUid !== null });
	return Response.json(
		{ id, name, writeKey, url: `${publicOrigin(url)}/p/${id}`, config },
		{ status: 201 }
	);
}
