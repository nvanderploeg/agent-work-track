import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { ApiError } from '#lib/server/api.ts';
import { requireBearerUser } from '#lib/server/device.ts';
import { getProjectRow, getTaskRow, type ProjectRow, type TaskRow } from '#lib/server/store.ts';

export function generateWriteKey(): string {
	return `ws_${randomBytes(32).toString('base64url')}`;
}

export function hashWriteKey(key: string): string {
	return createHash('sha256').update(key).digest('hex');
}

function bearer(request: Request): string | undefined {
	return /^Bearer\s+(\S+)\s*$/i.exec(request.headers.get('authorization') ?? '')?.[1];
}

function keyMatches(token: string, project: ProjectRow): boolean {
	const given = Buffer.from(hashWriteKey(token), 'hex');
	const stored = Buffer.from(project.writeKeyHash, 'hex');
	return given.length === stored.length && timingSafeEqual(given, stored);
}

function checkKey(request: Request, project: ProjectRow): void {
	const token = bearer(request);
	if (!token) throw new ApiError(401, 'missing write key');
	if (!keyMatches(token, project)) throw new ApiError(403, 'invalid write key');
}

/** A hash no one holds the key for: the Project takes no Write key until one is issued. */
export const unissuedKeyHash = (): string => hashWriteKey(generateWriteKey());

export async function authorizeProject(request: Request, projectId: string): Promise<ProjectRow> {
	const project = await getProjectRow(projectId);
	if (!project) throw new ApiError(404, 'project not found');
	if (project.ownerUid === null) {
		checkKey(request, project);
	} else {
		const token = bearer(request);
		if (token && keyMatches(token, project)) return project;
		if ((await requireBearerUser(request)).uid !== project.ownerUid) {
			throw new ApiError(403, 'token does not own this project');
		}
	}
	return project;
}

export async function authorizeTask(
	request: Request,
	taskId: string
): Promise<{ task: TaskRow; project: ProjectRow }> {
	const task = await getTaskRow(taskId);
	if (!task) throw new ApiError(404, 'task not found');
	const project = await authorizeProject(request, task.projectId);
	return { task, project };
}
