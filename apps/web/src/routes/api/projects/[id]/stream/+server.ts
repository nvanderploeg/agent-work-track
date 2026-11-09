import type { RequestHandler } from './$types';
import { ApiError, parseId, route } from '#lib/server/api.ts';
import { readableProject, readableTask } from '#lib/server/access.ts';
import { log } from '#lib/server/log.ts';
import { viewerOf } from '#lib/server/viewer.ts';
import { createProjectStream } from '#lib/server/stream.ts';

function parseSince(request: Request, url: URL): number | undefined {
	const raw = request.headers.get('last-event-id') || url.searchParams.get('since');
	if (!raw) return undefined;
	if (!/^\d+$/.test(raw)) throw new ApiError(400, 'malformed since');
	return Number(raw);
}

export const GET: RequestHandler = route(async ({ request, params, url, getClientAddress }) => {
	const projectId = parseId(params.id, 'project');
	const scoped = url.searchParams.get('task');
	let taskId: string | undefined;
	let wholeProject = false;
	if (scoped !== null) {
		taskId = parseId(scoped, 'task');
		const readable = await readableTask(request, taskId);
		if (readable.project.id !== projectId) throw new ApiError(404, 'task not found');
		wholeProject = readable.wholeProject;
	} else {
		await readableProject(request, projectId);
	}
	const viewer = await viewerOf(request).catch(() => null);
	const since = parseSince(request, url);
	const ip = getClientAddress();
	const openedAt = Date.now();
	const stream = await createProjectStream(projectId, {
		since,
		taskId,
		wholeProject,
		uid: viewer?.uid,
		onClose: (reason) =>
			log('stream.close', {
				project: projectId,
				ip,
				reason,
				seconds: Math.round((Date.now() - openedAt) / 1000)
			})
	});
	if (!stream) throw new ApiError(404, 'project not found');
	log('stream.open', { project: projectId, ip, since });
	return new Response(stream, {
		headers: {
			'content-type': 'text/event-stream',
			'cache-control': 'no-cache',
			'x-accel-buffering': 'no'
		}
	});
});
