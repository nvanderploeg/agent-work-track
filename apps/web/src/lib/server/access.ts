import { ApiError } from '#lib/server/api.ts';
import type { Viewer } from '#lib/server/identity.ts';
import { getProjectRow, getTaskRow, type ProjectRow, type TaskRow } from '#lib/server/store.ts';
import { viewerOf } from '#lib/server/viewer.ts';

export const isOwner = (project: ProjectRow, viewer: Viewer | null): boolean =>
	project.ownerUid !== null && viewer?.uid === project.ownerUid;

const isPublic = (project: ProjectRow): boolean => project.ownerUid === null || project.public;

// The session is only checked when the Project is private: anonymous traffic never touches Firebase.
async function mayOpenProject(request: Request, project: ProjectRow): Promise<boolean> {
	return isPublic(project) || isOwner(project, await viewerOf(request));
}

/** 404 rather than 403 so a private Project looks like one that does not exist. */
export async function readableProject(request: Request, projectId: string): Promise<ProjectRow> {
	const project = await getProjectRow(projectId);
	if (!project || !(await mayOpenProject(request, project))) {
		throw new ApiError(404, 'project not found');
	}
	return project;
}

/** `wholeProject` is false when only the Task is readable: it is public inside a private Project. */
export async function readableTask(
	request: Request,
	taskId: string
): Promise<{ task: TaskRow; project: ProjectRow; wholeProject: boolean }> {
	const task = await getTaskRow(taskId);
	const project = task && (await getProjectRow(task.projectId));
	if (!task || !project) throw new ApiError(404, 'task not found');
	const wholeProject = await mayOpenProject(request, project);
	if (!wholeProject && !task.public) throw new ApiError(404, 'task not found');
	return { task, project, wholeProject };
}
