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

function checkKey(request: Request, project: ProjectRow): void {
	const match = /^Bearer\s+(\S+)\s*$/i.exec(request.headers.get('authorization') ?? '');
	if (!match) throw new ApiError(401, 'missing write key');
	const given = Buffer.from(hashWriteKey(match[1]), 'hex');
	const stored = Buffer.from(project.writeKeyHash, 'hex');
	if (given.length !== stored.length || !timingSafeEqual(given, stored)) {
		throw new ApiError(403, 'invalid write key');
	}
}

export async function authorizeProject(request: Request, projectId: string): Promise<ProjectRow> {
	const project = await getProjectRow(projectId);
	if (!project) throw new ApiError(404, 'project not found');
	if (project.ownerUid === null) {
		checkKey(request, project);
	} else if ((await requireBearerUser(request)).uid !== project.ownerUid) {
		throw new ApiError(403, 'token does not own this project');
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
