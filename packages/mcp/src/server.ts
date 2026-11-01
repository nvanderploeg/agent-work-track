import { spawn } from 'node:child_process';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import {
	createClient,
	type AgentInfo,
	type Result,
	type StepInput,
	type ChronicleClient
} from '@chronicle/client';
import { z } from 'zod';

const tag = z.object({ text: z.string().min(1), color: z.string().optional() });

const agent = z
	.object({
		tool: z.string().optional(),
		model: z.string().optional(),
		effort: z.string().optional(),
		tokens: z.number().int().nonnegative().optional()
	})
	.describe(
		'Who is doing the work: tool (claude-code, codex), model id, effort level, and tokens used, sent when finished.'
	);

const link = z.object({ url: z.string(), label: z.string().optional() });
const links = z
	.array(link)
	.describe('Tickets and references: issue, PR, Trello card, doc. Replaces the whole list.');

const prs = z
	.array(
		z.object({
			url: z.string(),
			number: z.number().int().positive().optional(),
			title: z.string().optional(),
			state: z.enum(['draft', 'open', 'merged', 'closed']).optional(),
			checks: z.enum(['pending', 'passing', 'failing']).optional(),
			review: z.enum(['pending', 'approved', 'changes_requested']).optional()
		})
	)
	.describe(
		'Pull or merge requests for the task. Sending just the url is enough: status is filled in from gh or glab. Replaces the whole list.'
	);

const step: z.ZodType<StepInput> = z.lazy(() =>
	z.object({
		key: z.string(),
		title: z.string().optional(),
		state: z.string().optional(),
		note: z.string().optional(),
		tags: z.array(tag).optional(),
		agent: agent.optional(),
		links: links.optional(),
		subtasks: z.array(step).optional()
	})
);

const stateDef = z.object({
	key: z.string(),
	label: z.string(),
	color: z.string(),
	kind: z.enum(['pending', 'active', 'review', 'blocked', 'failed', 'done']),
	icon: z.string().optional(),
	animation: z.enum(['none', 'pulse', 'shimmer', 'blink', 'spin']).optional()
});

const theme = z.enum(['system', 'light', 'dark']);

const projectConfig = z.object({
	theme,
	initialState: z.string(),
	states: z.array(stateDef)
});

const configPatch = z.object({
	theme: theme.optional(),
	initialState: z.string().optional(),
	states: z.array(stateDef.partial().extend({ key: z.string() })).optional()
});

// Map an MCP client's self-reported name to a tool name; unknown clients stay unnamed.
function toolFromClient(name: string | undefined): string | undefined {
	if (!name) return undefined;
	if (/claude/i.test(name)) return 'claude-code';
	if (/codex/i.test(name)) return 'codex';
	return undefined;
}

function respond<T>(result: Result<T>): CallToolResult {
	const text = result.ok ? JSON.stringify(result.value) : `chronicle: ${result.warning}`;
	return { content: [{ type: 'text', text }] };
}

export type Opener = (url: string) => void;

// Fire and forget: a missing opener or display must never surface to the agent.
export function openInBrowser(url: string): void {
	if (process.env.CHRONICLE_OPEN === '0') return;
	const [cmd, args] =
		process.platform === 'darwin'
			? ['open', [url]]
			: process.platform === 'win32'
				? ['cmd', ['/c', 'start', '', url]]
				: ['xdg-open', [url]];
	try {
		const child = spawn(cmd, args, { detached: true, stdio: 'ignore' });
		child.on('error', () => {});
		child.unref();
	} catch {
		// tracking is best effort
	}
}

export interface WatchOptions {
	intervalMs?: number;
	soonMs?: number;
}

// Keeps PR status on the dashboard current while an agent is connected. Every failure is
// swallowed: the watcher must never disturb the agent's session.
function createWatcher(
	client: ChronicleClient,
	{ intervalMs = 180_000, soonMs = 5_000 }: WatchOptions
) {
	let running = false;
	const sync = async (taskIds?: string[]) => {
		if (running) return;
		running = true;
		try {
			await client.syncPrs(taskIds ? { taskIds } : {});
		} catch {
			// tracking is best effort
		} finally {
			running = false;
		}
	};
	const timers: ReturnType<typeof setTimeout>[] = [];
	const unref = <T extends ReturnType<typeof setTimeout>>(timer: T) => {
		timer.unref?.();
		timers.push(timer);
		return timer;
	};
	if (intervalMs > 0) {
		unref(setTimeout(() => void sync(), Math.min(soonMs, intervalMs)));
		unref(setInterval(() => void sync(), intervalMs));
	}
	return {
		soon: (taskId: string) => {
			if (intervalMs > 0) unref(setTimeout(() => void sync([taskId]), soonMs));
		},
		stop: () => timers.forEach((t) => clearTimeout(t))
	};
}

export function createServer(
	client: ChronicleClient = createClient(),
	watch: WatchOptions = {
		intervalMs: Number(process.env.CHRONICLE_PR_SYNC_MS ?? 180_000)
	},
	open: Opener = openInBrowser
): McpServer {
	const server = new McpServer({ name: 'chronicle', version: '0.1.0' });
	const watcher = createWatcher(client, watch);
	const close = server.close.bind(server);
	server.close = async () => {
		watcher.stop();
		await close();
	};

	server.registerTool(
		'start_task',
		{
			description:
				"Start tracking a multi-step task on this repo's chronicle dashboard, before any research or other work, and return its url; the server opens it in the user's browser, and you print it to the user as a link in your next message. List every known step, with known subtasks under `subtasks`, so the plan shows up front.",
			inputSchema: {
				title: z.string(),
				summary: z.string().optional(),
				state: z.string().optional(),
				note: z.string().optional(),
				steps: z.array(step).optional(),
				agent: agent.optional(),
				links: links.optional(),
				prs: prs.optional(),
				repo: z.string().optional(),
				branch: z.string().optional(),
				project: z
					.string()
					.optional()
					.describe("Human name for this repo's project; renames it if it differs."),
				cwd: z.string().optional()
			}
		},
		async (args) => {
			const tool = args.agent?.tool ?? toolFromClient(server.server.getClientVersion()?.name);
			const withTool: AgentInfo | undefined = tool ? { ...args.agent, tool } : args.agent;
			const result = await client.startTask(withTool ? { ...args, agent: withTool } : args);
			if (result.ok) open(result.value.url);
			if (result.ok && args.prs?.length) watcher.soon(result.value.taskId);
			return respond(result);
		}
	);

	server.registerTool(
		'update_step',
		{
			description:
				"Set a step's or subtask's state, note or tags by path (`step-1`, `step-1/tests`), creating it and any missing parents.",
			inputSchema: {
				taskId: z.string(),
				path: z.string(),
				title: z.string().optional(),
				state: z.string().optional(),
				note: z.string().optional(),
				tags: z.array(tag).optional(),
				agent: agent.optional(),
				links: links.optional(),
				position: z.number().int().optional()
			}
		},
		async (args) => respond(await client.updateStep(args))
	);

	server.registerTool(
		'update_task',
		{
			description:
				"Set the task's own state, title, summary or note; finish the task with a done, failed or needs_input state.",
			inputSchema: {
				taskId: z.string(),
				title: z.string().optional(),
				summary: z.string().optional(),
				state: z.string().optional(),
				note: z.string().optional(),
				agent: agent.optional(),
				links: links.optional(),
				prs: prs.optional()
			}
		},
		async (args) => {
			const result = await client.updateTask(args);
			if (result.ok && args.prs?.length) watcher.soon(args.taskId);
			return respond(result);
		}
	);

	server.registerTool(
		'add_notice',
		{
			description:
				'Flag an assumption you made or a caveat the user should check, so it shows as an alert on the task and in the Notices tab; one notice per call, with `path` when it belongs to a step.',
			inputSchema: {
				taskId: z.string(),
				kind: z.enum(['assumption', 'caveat']),
				text: z.string().min(1),
				path: z.string().optional()
			}
		},
		async (args) => respond(await client.addNotice(args))
	);

	server.registerTool(
		'add_image',
		{
			description:
				'Attach a screenshot or other image file to the task, or to a step by `path`, as a thumbnail on the dashboard; set `review` only when the user should look at it closely. Images expire from the server soon after the task finishes or goes idle.',
			inputSchema: {
				taskId: z.string(),
				file: z.string().min(1),
				path: z.string().optional(),
				caption: z.string().max(300).optional(),
				review: z.boolean().optional()
			}
		},
		async (args) => respond(await client.addImage(args))
	);

	server.registerTool(
		'update_project',
		{
			description:
				"Rename this repo's project or set its notes (goals, context a viewer needs) and project-wide links (board, repo, spec).",
			inputSchema: {
				taskId: z.string().optional(),
				cwd: z.string().optional(),
				name: z.string().optional(),
				notes: z.string().optional(),
				links: links.optional()
			}
		},
		async (args) => respond(await client.updateProject(args))
	);

	server.registerTool(
		'get_task',
		{
			description:
				'Return the current task and its nodes; call this after context compaction to recover progress.',
			inputSchema: { taskId: z.string() }
		},
		async (args) => respond(await client.getTask(args))
	);

	server.registerTool(
		'configure',
		{
			description:
				"Read or change the project's states, colors and theme; `patch` merges states by key, `config` replaces the whole config.",
			inputSchema: {
				taskId: z.string().optional(),
				cwd: z.string().optional(),
				config: projectConfig.optional(),
				patch: configPatch.optional()
			}
		},
		async (args) => respond(await client.configure(args))
	);

	return server;
}
