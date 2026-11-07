import { readFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import {
	createClient,
	type AgentInfo,
	type ConfigPatch,
	type Link,
	type DoctorReport,
	type ProjectConfig,
	type Result,
	type StepInput,
	type Tag,
	type Theme,
	type ChronicleClient
} from '@chronicle/client';

export interface RunIo {
	stdout: (s: string) => void;
	stderr: (s: string) => void;
	client?: ChronicleClient;
}

const USAGE = `usage:
  chronicle start <title> [--summary s] [--state k] [--note n] [--step key[/sub]=Title]... [--project name]
                  [--repo owner/name] [--branch b] [agent] [--link url[|label]]... [--pr url]... [--cwd dir]
  chronicle step <taskId> <path> [state] [--title t] [--note n] [--tag text[|color]]... [--position n]
                  [agent] [--link url[|label]]...
  chronicle task <taskId> [state] [--title t] [--summary s] [--note n] [agent] [--link url[|label]]... [--pr url]...
  chronicle notice <taskId> <assumption|caveat> <text> [--path p]
  chronicle image <taskId> <file> [--path p] [--caption c] [--review]
  chronicle sync [--task id]...
  chronicle project [--name n] [--notes s] [--link url[|label]]... [--task id] [--cwd dir]
  chronicle get <taskId>
  chronicle config [--file path.json] [--theme t] [--color state=color]... [--initial state] [--task id] [--cwd dir]
  chronicle url [taskId] [--cwd dir]
  chronicle doctor [--cwd dir]
  chronicle login [--label name]
  chronicle logout

  agent: [--tool claude-code|codex] [--model id] [--effort level] [--tokens n]`;

const AGENT_OPTIONS = {
	tool: { type: 'string' },
	model: { type: 'string' },
	effort: { type: 'string' },
	tokens: { type: 'string' },
	link: { type: 'string', multiple: true }
} as const;

class UsageError extends Error {}

function parse<const O extends NonNullable<Parameters<typeof parseArgs>[0]>['options']>(
	args: string[],
	options: O,
	positionals: [min: number, max: number]
) {
	let parsed;
	try {
		parsed = parseArgs({ args, options, allowPositionals: true, strict: true });
	} catch (error) {
		throw new UsageError(error instanceof Error ? error.message : String(error));
	}
	const count = parsed.positionals.length;
	if (count < positionals[0] || count > positionals[1]) {
		throw new UsageError('wrong number of arguments');
	}
	return parsed as {
		values: {
			[K in keyof O]?: O[K] extends { multiple: true }
				? string[]
				: O[K] extends { type: 'boolean' }
					? boolean
					: string;
		};
		positionals: string[];
	};
}

function splitPair(value: string, what: string): [string, string | undefined] {
	const at = value.indexOf('=');
	if (at < 0) return [value, undefined];
	if (at === 0) throw new UsageError(`bad ${what}: ${value}`);
	return [value.slice(0, at), value.slice(at + 1)];
}

function parseTag(value: string): Tag {
	const bar = value.indexOf('|');
	if (bar < 0) return { text: value };
	return { text: value.slice(0, bar), color: value.slice(bar + 1) };
}

function parseLink(value: string): Link {
	const bar = value.indexOf('|');
	if (bar < 0) return { url: value };
	return { url: value.slice(0, bar), label: value.slice(bar + 1) };
}

function parseAgent(values: {
	tool?: string;
	model?: string;
	effort?: string;
	tokens?: string;
}): AgentInfo | undefined {
	const agent: AgentInfo = {};
	if (values.tool !== undefined) agent.tool = values.tool;
	if (values.model !== undefined) agent.model = values.model;
	if (values.effort !== undefined) agent.effort = values.effort;
	if (values.tokens !== undefined) {
		if (!/^\d+$/.test(values.tokens)) throw new UsageError(`bad --tokens: ${values.tokens}`);
		agent.tokens = Number(values.tokens);
	}
	return Object.keys(agent).length ? agent : undefined;
}

// `--step a=A --step a/b=B` nests b under a; a missing parent is created with its key as title.
function parseSteps(values: string[] | undefined): StepInput[] | undefined {
	if (!values) return undefined;
	const roots: StepInput[] = [];
	for (const value of values) {
		const [path, title] = splitPair(value, '--step');
		let siblings = roots;
		const keys = path.split('/');
		keys.forEach((key, depth) => {
			if (key === '') throw new UsageError(`bad --step: ${value}`);
			let node = siblings.find((s) => s.key === key);
			if (!node) siblings.push((node = { key }));
			if (depth === keys.length - 1) {
				if (title) node.title = title;
			} else {
				siblings = node.subtasks ??= [];
			}
		});
	}
	return roots;
}

function parseColor(value: string): NonNullable<ConfigPatch['states']>[number] {
	const [key, color] = splitPair(value, '--color');
	if (color === undefined || color === '')
		throw new UsageError(`--color needs state=color: ${value}`);
	return { key, color };
}

function formatDoctor(report: DoctorReport): string {
	const probes = report.probes.map(
		(p) => `  ${p.server} ${p.ok ? `ok${p.version ? ` (v${p.version})` : ''}` : 'unreachable'}`
	);
	return [
		`config dir: ${report.configDir}`,
		`pinned: ${report.pinned ?? 'none'}`,
		'probes:',
		...(probes.length ? probes : ['  none']),
		`server: ${report.server ?? 'none'}`,
		`repo: ${report.repoKey}`,
		`registered: ${report.registered ? `${report.registered.name} (${report.registered.projectId})` : 'no'}`,
		`registry: ${report.registryError ?? 'ok'}`
	].join('\n');
}

export async function run(argv: string[], io: RunIo): Promise<number> {
	const client = io.client ?? createClient();
	const [command, ...rest] = argv;

	const finish = <T>(result: Result<T>, print: (value: T) => string): number => {
		if (!result.ok) {
			io.stderr(`chronicle: ${result.warning}`);
			return 0;
		}
		io.stdout(print(result.value));
		return 0;
	};

	try {
		switch (command) {
			case 'start': {
				const { values, positionals } = parse(
					rest,
					{
						summary: { type: 'string' },
						state: { type: 'string' },
						note: { type: 'string' },
						step: { type: 'string', multiple: true },
						project: { type: 'string' },
						pr: { type: 'string', multiple: true },
						repo: { type: 'string' },
						branch: { type: 'string' },
						cwd: { type: 'string' },
						...AGENT_OPTIONS
					},
					[1, 1]
				);
				const result = await client.startTask({
					title: positionals[0],
					summary: values.summary,
					state: values.state,
					note: values.note,
					steps: parseSteps(values.step),
					project: values.project,
					repo: values.repo,
					branch: values.branch,
					agent: parseAgent(values),
					links: values.link?.map(parseLink),
					prs: values.pr?.map((url) => ({ url })),
					cwd: values.cwd
				});
				return finish(result, (v) => `${v.taskId} ${v.url}`);
			}
			case 'step': {
				const { values, positionals } = parse(
					rest,
					{
						title: { type: 'string' },
						note: { type: 'string' },
						tag: { type: 'string', multiple: true },
						position: { type: 'string' },
						...AGENT_OPTIONS
					},
					[2, 3]
				);
				const position = values.position === undefined ? undefined : Number(values.position);
				if (position !== undefined && !/^-?\d+$/.test(values.position!)) {
					throw new UsageError(`bad --position: ${values.position}`);
				}
				const result = await client.updateStep({
					taskId: positionals[0],
					path: positionals[1],
					state: positionals[2],
					title: values.title,
					note: values.note,
					tags: values.tag?.map(parseTag),
					agent: parseAgent(values),
					links: values.link?.map(parseLink),
					position
				});
				return finish(result, (v) => `${v.node.path} ${v.node.state}`);
			}
			case 'task': {
				const { values, positionals } = parse(
					rest,
					{
						title: { type: 'string' },
						summary: { type: 'string' },
						note: { type: 'string' },
						pr: { type: 'string', multiple: true },
						...AGENT_OPTIONS
					},
					[1, 2]
				);
				const result = await client.updateTask({
					taskId: positionals[0],
					state: positionals[1],
					title: values.title,
					summary: values.summary,
					note: values.note,
					agent: parseAgent(values),
					links: values.link?.map(parseLink),
					prs: values.pr?.map((url) => ({ url }))
				});
				return finish(result, (v) => `${v.task.id} ${v.task.state}`);
			}
			case 'notice': {
				const { values, positionals } = parse(rest, { path: { type: 'string' } }, [3, 3]);
				const kind = positionals[1];
				if (kind !== 'assumption' && kind !== 'caveat') {
					throw new UsageError(`bad notice kind: ${kind}`);
				}
				const result = await client.addNotice({
					taskId: positionals[0],
					kind,
					text: positionals[2],
					path: values.path
				});
				return finish(result, (v) => `${v.notice.id} ${v.notice.kind}`);
			}
			case 'image': {
				const { values, positionals } = parse(
					rest,
					{
						path: { type: 'string' },
						caption: { type: 'string' },
						review: { type: 'boolean' }
					},
					[2, 2]
				);
				const result = await client.addImage({
					taskId: positionals[0],
					file: positionals[1],
					path: values.path,
					caption: values.caption,
					review: values.review
				});
				return finish(result, (v) => v.image.id);
			}
			case 'sync': {
				const { values } = parse(rest, { task: { type: 'string', multiple: true } }, [0, 0]);
				const result = await client.syncPrs({ taskIds: values.task });
				return finish(
					result,
					(v) => `checked ${v.checked}, updated ${v.updated.length ? v.updated.join(' ') : 'none'}`
				);
			}
			case 'project': {
				const { values } = parse(
					rest,
					{
						name: { type: 'string' },
						notes: { type: 'string' },
						link: { type: 'string', multiple: true },
						task: { type: 'string' },
						cwd: { type: 'string' }
					},
					[0, 0]
				);
				const result = await client.updateProject({
					taskId: values.task,
					cwd: values.cwd,
					name: values.name,
					notes: values.notes,
					links: values.link?.map(parseLink)
				});
				return finish(result, (v) => `${v.project.name} ${v.projectUrl}`);
			}
			case 'get': {
				const { positionals } = parse(rest, {}, [1, 1]);
				const result = await client.getTask({ taskId: positionals[0] });
				return finish(result, (v) => JSON.stringify(v));
			}
			case 'config': {
				const { values } = parse(
					rest,
					{
						file: { type: 'string' },
						theme: { type: 'string' },
						color: { type: 'string', multiple: true },
						initial: { type: 'string' },
						task: { type: 'string' },
						cwd: { type: 'string' }
					},
					[0, 0]
				);
				let config: ProjectConfig | undefined;
				if (values.file !== undefined) {
					try {
						config = JSON.parse(await readFile(values.file, 'utf8')) as ProjectConfig;
					} catch (error) {
						const message = error instanceof Error ? error.message : String(error);
						io.stderr(`chronicle: cannot read config ${values.file}: ${message}`);
						return 2;
					}
				}
				const patch: ConfigPatch = {};
				if (values.theme !== undefined) patch.theme = values.theme as Theme;
				if (values.initial !== undefined) patch.initialState = values.initial;
				if (values.color?.length) patch.states = values.color.map(parseColor);
				const result = await client.configure({
					taskId: values.task,
					cwd: values.cwd,
					config,
					patch: Object.keys(patch).length ? patch : undefined
				});
				return finish(result, (v) => JSON.stringify(v.config));
			}
			case 'url': {
				const { values, positionals } = parse(rest, { cwd: { type: 'string' } }, [0, 1]);
				const result = await client.projectUrl({ taskId: positionals[0], cwd: values.cwd });
				return finish(result, (v) => v.url);
			}
			case 'login': {
				const { values } = parse(rest, { label: { type: 'string' } }, [0, 0]);
				const result = await client.login({
					label: values.label,
					onCode: (code) =>
						io.stdout(`Open ${code.verificationUrl} and approve code ${code.userCode}`)
				});
				return finish(result, (v) => `logged in to ${v.server}`);
			}
			case 'logout': {
				parse(rest, {}, [0, 0]);
				const result = await client.logout();
				return finish(result, (v) =>
					v.revoked
						? `logged out of ${v.server}`
						: `logged out locally; ${v.server} was unreachable`
				);
			}
			case 'doctor': {
				const { values } = parse(rest, { cwd: { type: 'string' } }, [0, 0]);
				io.stdout(formatDoctor(await client.doctor({ cwd: values.cwd })));
				return 0;
			}
			case '--help':
			case '-h':
			case 'help':
				io.stdout(USAGE);
				return 0;
			default:
				throw new UsageError(
					command === undefined ? 'missing command' : `unknown command: ${command}`
				);
		}
	} catch (error) {
		if (error instanceof UsageError) {
			io.stderr(`chronicle: ${error.message}\n${USAGE}`);
			return 2;
		}
		io.stderr(`chronicle: ${error instanceof Error ? error.message : String(error)}`);
		return 0;
	}
}
