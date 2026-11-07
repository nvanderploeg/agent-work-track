import { error } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';
import { ApiError, parseId } from '#lib/server/api.ts';
import { readableTask } from '#lib/server/access.ts';
import { snapshot } from '#lib/server/store.ts';

export const load: PageServerLoad = async ({ params, request, setHeaders }) => {
	let projectId: string;
	let taskId: string;
	let wholeProject: boolean;
	try {
		projectId = parseId(params.id, 'project');
		taskId = parseId(params.taskId, 'task');
		const readable = await readableTask(request, taskId);
		if (readable.project.id !== projectId) error(404, 'Task not found');
		wholeProject = readable.wholeProject;
	} catch (e) {
		if (e instanceof ApiError) error(404, 'Task not found');
		throw e;
	}
	const result = await snapshot(projectId);
	const task = result?.tasks.find((t) => t.id === taskId);
	if (!result || !task) error(404, 'Task not found');
	if (!result.project.public) setHeaders({ 'cache-control': 'private, no-store' });
	// A reader of just this Task learns nothing else about its Project.
	const project = wholeProject
		? result.project
		: { ...result.project, name: 'Shared task', notes: '', links: [] };
	return {
		snapshot: {
			...result,
			project,
			tasks: [task],
			nodes: result.nodes.filter((n) => n.taskId === taskId),
			notices: result.notices.filter((n) => n.taskId === taskId),
			images: result.images.filter((i) => i.taskId === taskId)
		},
		taskId,
		backLink: wholeProject,
		now: Date.now()
	};
};
