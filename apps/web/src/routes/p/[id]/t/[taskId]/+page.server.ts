import { error } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';
import { ApiError, parseId } from '#lib/server/api.ts';
import { snapshot } from '#lib/server/store.ts';

export const load: PageServerLoad = async ({ params }) => {
	let projectId: string;
	let taskId: string;
	try {
		projectId = parseId(params.id, 'project');
		taskId = parseId(params.taskId, 'task');
	} catch (e) {
		if (e instanceof ApiError) error(404, 'Task not found');
		throw e;
	}
	const result = await snapshot(projectId);
	const task = result?.tasks.find((t) => t.id === taskId);
	if (!result || !task) error(404, 'Task not found');
	return {
		snapshot: {
			...result,
			tasks: [task],
			nodes: result.nodes.filter((n) => n.taskId === taskId),
			notices: result.notices.filter((n) => n.taskId === taskId),
			images: result.images.filter((i) => i.taskId === taskId)
		},
		taskId,
		now: Date.now()
	};
};
