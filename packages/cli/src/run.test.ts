import { describe, it, expect, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ChronicleClient } from '@chronicle/client';
import { run } from './run.ts';

const UNREACHABLE = 'chronicle unreachable — continuing untracked';
const T = '2026-10-12T00:00:00.000Z';

const CONFIG = {
	theme: 'system' as const,
	initialState: 'queued',
	states: [
		{ key: 'queued', label: 'Not started', color: '#9ca3af', kind: 'pending' as const },
		{ key: 'done', label: 'Completed', color: '#22c55e', kind: 'done' as const }
	]
};

const TASK = {
	id: 'task-1',
	projectId: 'proj-1',
	title: 'Ship chunk 2',
	summary: '',
	state: 'done',
	note: '',
	createdAt: T,
	updatedAt: T,
	stateSince: T,
	finishedAt: T
};

const NODE = {
	taskId: 'task-1',
	path: 'chunk-2/tests',
	parentPath: 'chunk-2',
	key: 'tests',
	depth: 2,
	title: 'Tests',
	state: 'done',
	note: '',
	tags: [],
	position: 0,
	createdAt: T,
	updatedAt: T,
	stateSince: T
};

function fakeClient() {
	return {
		discover: vi.fn(),
		startTask: vi.fn(),
		updateStep: vi.fn(),
		updateTask: vi.fn(),
		updateProject: vi.fn(),
		syncPrs: vi.fn(),
		getTask: vi.fn(),
		addNotice: vi.fn(),
		addImage: vi.fn(),
		configure: vi.fn(),
		projectUrl: vi.fn(),
		doctor: vi.fn(),
		login: vi.fn(),
		logout: vi.fn()
	};
}

type FakeClient = ReturnType<typeof fakeClient>;

async function invoke(argv: string[], client: FakeClient) {
	const out: string[] = [];
	const err: string[] = [];
	const code = await run(argv, {
		stdout: (s) => out.push(s),
		stderr: (s) => err.push(s),
		client: client as unknown as ChronicleClient
	});
	return { code, stdout: out.join(''), stderr: err.join('') };
}

const tmpDirs: string[] = [];

function tmpJson(name: string, data: unknown): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-cli-'));
	tmpDirs.push(dir);
	const file = path.join(dir, name);
	fs.writeFileSync(file, JSON.stringify(data));
	return file;
}

afterEach(() => {
	for (const dir of tmpDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('start', () => {
	it('prints "<taskId> <url>" and exits 0', async () => {
		const client = fakeClient();
		client.startTask.mockResolvedValue({
			ok: true,
			value: {
				taskId: 'task-1',
				url: 'http://h/p/proj-1/t/task-1',
				server: 'http://h',
				projectId: 'proj-1',
				projectUrl: 'http://h/p/proj-1',
				createdProject: true
			}
		});

		const result = await invoke(['start', 'Ship chunk 2'], client);

		expect(result.code).toBe(0);
		expect(result.stdout.trim()).toBe('task-1 http://h/p/proj-1/t/task-1');
		expect(result.stderr).toBe('');
	});

	it('passes the title, summary, state, note and cwd flags to startTask', async () => {
		const client = fakeClient();
		client.startTask.mockResolvedValue({ ok: true, value: { taskId: 't', url: 'u' } });

		await invoke(
			[
				'start',
				'Ship chunk 2',
				'--summary',
				'the summary',
				'--state',
				'in_work',
				'--note',
				'started',
				'--cwd',
				'/work/repo'
			],
			client
		);

		expect(client.startTask).toHaveBeenCalledTimes(1);
		const [input] = client.startTask.mock.calls[0];
		expect(input).toMatchObject({
			title: 'Ship chunk 2',
			summary: 'the summary',
			state: 'in_work',
			note: 'started',
			cwd: '/work/repo'
		});
		expect(input.steps ?? []).toEqual([]);
	});

	it('turns bare --step keys and key=Title flags into steps, title omitted when bare', async () => {
		const client = fakeClient();
		client.startTask.mockResolvedValue({ ok: true, value: { taskId: 't', url: 'u' } });

		await invoke(['start', 'T', '--step', 'chunk-1=Chunk 1', '--step', 'chunk-2'], client);

		const [input] = client.startTask.mock.calls[0];
		expect(input.steps).toEqual([{ key: 'chunk-1', title: 'Chunk 1' }, { key: 'chunk-2' }]);
		expect(input.steps[1].title).toBeUndefined();
	});

	it('splits a --step value on its first "=" only', async () => {
		const client = fakeClient();
		client.startTask.mockResolvedValue({ ok: true, value: { taskId: 't', url: 'u' } });

		await invoke(['start', 'T', '--step', 'a=x=y'], client);

		const [input] = client.startTask.mock.calls[0];
		expect(input.steps).toEqual([{ key: 'a', title: 'x=y' }]);
	});

	it('prints the warning to stderr and exits 0 when the result is not ok', async () => {
		const client = fakeClient();
		client.startTask.mockResolvedValue({ ok: false, warning: UNREACHABLE });

		const result = await invoke(['start', 'T'], client);

		expect(result.code).toBe(0);
		expect(result.stderr.trim()).toBe(`chronicle: ${UNREACHABLE}`);
		expect(result.stdout).toBe('');
	});

	it('exits 2 with usage on stderr when the title is missing', async () => {
		const client = fakeClient();

		const result = await invoke(['start'], client);

		expect(result.code).toBe(2);
		expect(result.stderr).toMatch(/usage/i);
		expect(client.startTask).not.toHaveBeenCalled();
	});

	it('exits 2 with usage on stderr for an unknown flag', async () => {
		const client = fakeClient();

		const result = await invoke(['start', 'T', '--bogus', 'x'], client);

		expect(result.code).toBe(2);
		expect(result.stderr).toMatch(/usage/i);
		expect(client.startTask).not.toHaveBeenCalled();
	});
});

describe('step', () => {
	it('calls updateStep with every flag and prints "<path> <state>"', async () => {
		const client = fakeClient();
		client.updateStep.mockResolvedValue({ ok: true, value: { node: NODE } });

		const result = await invoke(
			[
				'step',
				'task-1',
				'chunk-2/tests',
				'done',
				'--title',
				'Write tests',
				'--note',
				'n',
				'--position',
				'3'
			],
			client
		);

		expect(result.code).toBe(0);
		expect(result.stdout.trim()).toBe('chunk-2/tests done');
		expect(client.updateStep).toHaveBeenCalledWith({
			taskId: 'task-1',
			path: 'chunk-2/tests',
			state: 'done',
			title: 'Write tests',
			note: 'n',
			position: 3
		});
	});

	it('omits state when the positional is absent', async () => {
		const client = fakeClient();
		client.updateStep.mockResolvedValue({ ok: true, value: { node: NODE } });

		await invoke(['step', 'task-1', 'chunk-2'], client);

		const [input] = client.updateStep.mock.calls[0];
		expect(input).toMatchObject({ taskId: 'task-1', path: 'chunk-2' });
		expect(input.state).toBeUndefined();
	});

	it('passes position 0 through as the number zero', async () => {
		const client = fakeClient();
		client.updateStep.mockResolvedValue({ ok: true, value: { node: NODE } });

		await invoke(['step', 'task-1', 'a', '--position', '0'], client);

		const [input] = client.updateStep.mock.calls[0];
		expect(input.position).toBe(0);
	});

	it('parses a bare --tag as text only', async () => {
		const client = fakeClient();
		client.updateStep.mockResolvedValue({ ok: true, value: { node: NODE } });

		await invoke(['step', 'task-1', 'a', '--tag', 'opus'], client);

		const [input] = client.updateStep.mock.calls[0];
		expect(input.tags).toEqual([{ text: 'opus' }]);
		expect(input.tags[0]).not.toHaveProperty('color');
	});

	it('parses "--tag text|color" into text and color, in flag order', async () => {
		const client = fakeClient();
		client.updateStep.mockResolvedValue({ ok: true, value: { node: NODE } });

		await invoke(['step', 'task-1', 'a', '--tag', 'round 2|#a855f7', '--tag', 'opus'], client);

		const [input] = client.updateStep.mock.calls[0];
		expect(input.tags).toEqual([{ text: 'round 2', color: '#a855f7' }, { text: 'opus' }]);
	});

	it('prints the warning to stderr and exits 0 when the result is not ok', async () => {
		const client = fakeClient();
		client.updateStep.mockResolvedValue({
			ok: false,
			warning: 'chronicle rejected the update: unknown state (valid states: queued, done)'
		});

		const result = await invoke(['step', 'task-1', 'a', 'nope'], client);

		expect(result.code).toBe(0);
		expect(result.stderr.trim()).toBe(
			'chronicle: chronicle rejected the update: unknown state (valid states: queued, done)'
		);
		expect(result.stdout).toBe('');
	});

	it.each(['1.5', '', ' ', '1e3', '0x10', 'abc'])(
		'exits 2 without calling the client when --position is %j, not an integer',
		async (value) => {
			const client = fakeClient();

			const result = await invoke(['step', 'task-1', 'a', '--position', value], client);

			expect(result.code).toBe(2);
			expect(result.stderr).toMatch(/bad --position/);
			expect(client.updateStep).not.toHaveBeenCalled();
		}
	);

	it('accepts a negative integer --position', async () => {
		const client = fakeClient();
		client.updateStep.mockResolvedValue({ ok: true, value: { node: NODE } });

		await invoke(['step', 'task-1', 'a', '--position=-2'], client);

		expect(client.updateStep.mock.calls[0][0].position).toBe(-2);
	});

	it('exits 2 with usage on stderr when the path is missing', async () => {
		const client = fakeClient();

		const result = await invoke(['step', 'task-1'], client);

		expect(result.code).toBe(2);
		expect(result.stderr).toMatch(/usage/i);
		expect(client.updateStep).not.toHaveBeenCalled();
	});
});

describe('task', () => {
	it('calls updateTask with every flag and prints "<taskId> <state>"', async () => {
		const client = fakeClient();
		client.updateTask.mockResolvedValue({ ok: true, value: { task: TASK } });

		const result = await invoke(
			['task', 'task-1', 'done', '--title', 'T', '--summary', 'S', '--note', 'N'],
			client
		);

		expect(result.code).toBe(0);
		expect(result.stdout.trim()).toBe('task-1 done');
		expect(client.updateTask).toHaveBeenCalledWith({
			taskId: 'task-1',
			state: 'done',
			title: 'T',
			summary: 'S',
			note: 'N'
		});
	});

	it('omits state when the positional is absent', async () => {
		const client = fakeClient();
		client.updateTask.mockResolvedValue({ ok: true, value: { task: TASK } });

		await invoke(['task', 'task-1', '--note', 'only a note'], client);

		const [input] = client.updateTask.mock.calls[0];
		expect(input).toMatchObject({ taskId: 'task-1', note: 'only a note' });
		expect(input.state).toBeUndefined();
	});

	it('prints the warning to stderr and exits 0 when the result is not ok', async () => {
		const client = fakeClient();
		client.updateTask.mockResolvedValue({ ok: false, warning: UNREACHABLE });

		const result = await invoke(['task', 'task-1', 'done'], client);

		expect(result.code).toBe(0);
		expect(result.stderr.trim()).toBe(`chronicle: ${UNREACHABLE}`);
		expect(result.stdout).toBe('');
	});

	it('exits 2 with usage on stderr when the taskId is missing', async () => {
		const client = fakeClient();

		const result = await invoke(['task'], client);

		expect(result.code).toBe(2);
		expect(result.stderr).toMatch(/usage/i);
		expect(client.updateTask).not.toHaveBeenCalled();
	});
});

describe('get', () => {
	it('prints the JSON of { task, nodes, url }', async () => {
		const value = { task: TASK, nodes: [NODE], url: 'http://h/p/proj-1/t/task-1' };
		const client = fakeClient();
		client.getTask.mockResolvedValue({ ok: true, value });

		const result = await invoke(['get', 'task-1'], client);

		expect(result.code).toBe(0);
		expect(JSON.parse(result.stdout)).toEqual(value);
		expect(client.getTask).toHaveBeenCalledWith({ taskId: 'task-1' });
	});

	it('prints the warning to stderr and exits 0 when the result is not ok', async () => {
		const client = fakeClient();
		client.getTask.mockResolvedValue({ ok: false, warning: UNREACHABLE });

		const result = await invoke(['get', 'task-1'], client);

		expect(result.code).toBe(0);
		expect(result.stderr.trim()).toBe(`chronicle: ${UNREACHABLE}`);
		expect(result.stdout).toBe('');
	});

	it('exits 2 with usage on stderr when the taskId is missing', async () => {
		const client = fakeClient();

		const result = await invoke(['get'], client);

		expect(result.code).toBe(2);
		expect(result.stderr).toMatch(/usage/i);
		expect(client.getTask).not.toHaveBeenCalled();
	});
});

describe('config', () => {
	it('reads the current config with no flags and prints it as JSON', async () => {
		const client = fakeClient();
		client.configure.mockResolvedValue({
			ok: true,
			value: { config: CONFIG, projectUrl: 'http://h/p/proj-1' }
		});

		const result = await invoke(['config'], client);

		expect(result.code).toBe(0);
		expect(JSON.parse(result.stdout)).toEqual(CONFIG);
		const [input] = client.configure.mock.calls[0];
		expect(input.config).toBeUndefined();
		expect(input.patch).toBeUndefined();
	});

	it('passes --task and --cwd through', async () => {
		const client = fakeClient();
		client.configure.mockResolvedValue({ ok: true, value: { config: CONFIG, projectUrl: 'u' } });

		await invoke(['config', '--task', 'task-1', '--cwd', '/work/repo'], client);

		expect(client.configure).toHaveBeenCalledWith({ taskId: 'task-1', cwd: '/work/repo' });
	});

	it('sends the --file JSON as the full config', async () => {
		const client = fakeClient();
		client.configure.mockResolvedValue({ ok: true, value: { config: CONFIG, projectUrl: 'u' } });
		const file = tmpJson('config.json', CONFIG);

		await invoke(['config', '--file', file], client);

		const [input] = client.configure.mock.calls[0];
		expect(input.config).toEqual(CONFIG);
		expect(input.patch).toBeUndefined();
	});

	it('sends --theme as a patch', async () => {
		const client = fakeClient();
		client.configure.mockResolvedValue({ ok: true, value: { config: CONFIG, projectUrl: 'u' } });

		await invoke(['config', '--theme', 'dark'], client);

		const [input] = client.configure.mock.calls[0];
		expect(input.patch).toEqual({ theme: 'dark' });
		expect(input.config).toBeUndefined();
	});

	it('sends --initial as a patch', async () => {
		const client = fakeClient();
		client.configure.mockResolvedValue({ ok: true, value: { config: CONFIG, projectUrl: 'u' } });

		await invoke(['config', '--initial', 'queued'], client);

		const [input] = client.configure.mock.calls[0];
		expect(input.patch).toEqual({ initialState: 'queued' });
	});

	it('turns each --color state=color into a states entry, in flag order', async () => {
		const client = fakeClient();
		client.configure.mockResolvedValue({ ok: true, value: { config: CONFIG, projectUrl: 'u' } });

		await invoke(['config', '--color', 'in_work=#14b8a6', '--color', 'done=#22c55e'], client);

		const [input] = client.configure.mock.calls[0];
		expect(input.patch).toEqual({
			states: [
				{ key: 'in_work', color: '#14b8a6' },
				{ key: 'done', color: '#22c55e' }
			]
		});
		expect(input.config).toBeUndefined();
	});

	it('combines --theme, --color and --initial into one patch', async () => {
		const client = fakeClient();
		client.configure.mockResolvedValue({ ok: true, value: { config: CONFIG, projectUrl: 'u' } });

		await invoke(
			['config', '--theme', 'light', '--color', 'in_work=#14b8a6', '--initial', 'in_work'],
			client
		);

		const [input] = client.configure.mock.calls[0];
		expect(input.patch).toEqual({
			theme: 'light',
			initialState: 'in_work',
			states: [{ key: 'in_work', color: '#14b8a6' }]
		});
	});

	it('prints the warning to stderr and exits 0 when the result is not ok', async () => {
		const client = fakeClient();
		client.configure.mockResolvedValue({
			ok: false,
			warning: 'no chronicle project for this repo yet — start a task first'
		});

		const result = await invoke(['config', '--theme', 'dark'], client);

		expect(result.code).toBe(0);
		expect(result.stderr.trim()).toBe(
			'chronicle: no chronicle project for this repo yet — start a task first'
		);
		expect(result.stdout).toBe('');
	});
});

describe('url', () => {
	it('prints the task URL when a taskId is given', async () => {
		const client = fakeClient();
		client.projectUrl.mockResolvedValue({ ok: true, value: { url: 'http://h/p/proj-1/t/task-1' } });

		const result = await invoke(['url', 'task-1'], client);

		expect(result.code).toBe(0);
		expect(result.stdout.trim()).toBe('http://h/p/proj-1/t/task-1');
		expect(client.projectUrl).toHaveBeenCalledWith({ taskId: 'task-1' });
	});

	it('prints the project URL when no taskId is given', async () => {
		const client = fakeClient();
		client.projectUrl.mockResolvedValue({ ok: true, value: { url: 'http://h/p/proj-1' } });

		const result = await invoke(['url'], client);

		expect(result.code).toBe(0);
		expect(result.stdout.trim()).toBe('http://h/p/proj-1');
		const [input] = client.projectUrl.mock.calls[0];
		expect(input.taskId).toBeUndefined();
	});

	it('passes --cwd through', async () => {
		const client = fakeClient();
		client.projectUrl.mockResolvedValue({ ok: true, value: { url: 'http://h/p/proj-1' } });

		await invoke(['url', '--cwd', '/work/repo'], client);

		expect(client.projectUrl).toHaveBeenCalledWith({ cwd: '/work/repo' });
	});

	it('prints the warning to stderr and exits 0 when the result is not ok', async () => {
		const client = fakeClient();
		client.projectUrl.mockResolvedValue({ ok: false, warning: UNREACHABLE });

		const result = await invoke(['url'], client);

		expect(result.code).toBe(0);
		expect(result.stderr.trim()).toBe(`chronicle: ${UNREACHABLE}`);
		expect(result.stdout).toBe('');
	});
});

describe('login and logout', () => {
	it('prints where to approve the code, then reports the server', async () => {
		const client = fakeClient();
		client.login.mockImplementation(async (input) => {
			input.onCode({
				userCode: 'ABCD-2345',
				verificationUrl: 'http://s/device?code=ABCD-2345',
				expiresIn: 600
			});
			return { ok: true, value: { server: 'http://s' } };
		});

		const result = await invoke(['login', '--label', 'laptop'], client);

		expect(client.login.mock.calls[0][0].label).toBe('laptop');
		expect(result.stdout).toBe(
			'Open http://s/device?code=ABCD-2345 and approve code ABCD-2345logged in to http://s'
		);
	});

	it('says when the server could not be told about a logout', async () => {
		const client = fakeClient();
		client.logout.mockResolvedValue({ ok: true, value: { server: 'http://s', revoked: false } });

		const result = await invoke(['logout'], client);

		expect(result.stdout).toBe('logged out locally; http://s was unreachable');
	});
});

describe('doctor', () => {
	it('passes --cwd through and prints the report in readable form', async () => {
		const client = fakeClient();
		client.doctor.mockResolvedValue({
			configDir: '/home/u/.config/chronicle',
			pinned: null,
			probes: [
				{ server: 'http://localhost:3280', ok: false },
				{ server: 'https://chronicle.merc.camp', ok: true, version: '9.9.9' }
			],
			server: 'https://chronicle.merc.camp',
			repoKey: '/work/agent-repo/.git',
			registered: { projectId: 'proj-77', name: 'agent-repo' }
		});

		const result = await invoke(['doctor', '--cwd', '/work/agent-repo'], client);

		expect(result.code).toBe(0);
		expect(client.doctor).toHaveBeenCalledWith({ cwd: '/work/agent-repo' });
		expect(result.stdout).toContain('/home/u/.config/chronicle');
		expect(result.stdout).toContain('https://chronicle.merc.camp');
		expect(result.stdout).toContain('http://localhost:3280');
		expect(result.stdout).toContain('/work/agent-repo/.git');
		expect(result.stdout).toContain('proj-77');
		expect(result.stdout).toContain('agent-repo');
	});

	it('runs without --cwd when none is given', async () => {
		const client = fakeClient();
		client.doctor.mockResolvedValue({
			configDir: '/c',
			pinned: 'http://pinned:1',
			probes: [{ server: 'http://pinned:1', ok: false }],
			server: null,
			repoKey: '/r',
			registered: null
		});

		const result = await invoke(['doctor'], client);

		expect(result.code).toBe(0);
		expect(result.stdout).toContain('http://pinned:1');
		expect(client.doctor.mock.calls[0][0]?.cwd).toBeUndefined();
	});
});

describe('notice', () => {
	it('sends the kind, text and path to addNotice and prints the id', async () => {
		const client = fakeClient();
		client.addNotice.mockResolvedValue({
			ok: true,
			value: { notice: { id: 'n-1', kind: 'assumption' } }
		});

		const result = await invoke(
			['notice', 'task-1', 'assumption', 'Assumed UTC', '--path', 'chunk-1'],
			client
		);

		expect(result.code).toBe(0);
		expect(result.stdout).toContain('n-1 assumption');
		expect(client.addNotice).toHaveBeenCalledWith({
			taskId: 'task-1',
			kind: 'assumption',
			text: 'Assumed UTC',
			path: 'chunk-1'
		});
	});

	it('exits 2 with usage for an unknown kind', async () => {
		const client = fakeClient();

		const result = await invoke(['notice', 'task-1', 'hunch', 'x'], client);

		expect(result.code).toBe(2);
		expect(client.addNotice).not.toHaveBeenCalled();
	});
});

describe('image', () => {
	it('sends the file, path, caption and review flag to addImage and prints the id', async () => {
		const client = fakeClient();
		client.addImage.mockResolvedValue({ ok: true, value: { image: { id: 'i-1' } } });

		const result = await invoke(
			['image', 'task-1', 'shot.png', '--path', 'ui', '--caption', 'Login', '--review'],
			client
		);

		expect(result.code).toBe(0);
		expect(result.stdout.trim()).toBe('i-1');
		expect(client.addImage).toHaveBeenCalledWith({
			taskId: 'task-1',
			file: 'shot.png',
			path: 'ui',
			caption: 'Login',
			review: true
		});
	});

	it('leaves review unset without --review', async () => {
		const client = fakeClient();
		client.addImage.mockResolvedValue({ ok: true, value: { image: { id: 'i-1' } } });

		await invoke(['image', 'task-1', 'shot.png'], client);

		expect(client.addImage.mock.calls[0][0].review).toBeUndefined();
	});

	it('exits 2 with usage when the file is missing', async () => {
		const client = fakeClient();

		const result = await invoke(['image', 'task-1'], client);

		expect(result.code).toBe(2);
		expect(client.addImage).not.toHaveBeenCalled();
	});
});

describe('usage errors', () => {
	const allMethods = [
		'discover',
		'startTask',
		'updateStep',
		'updateTask',
		'getTask',
		'configure',
		'projectUrl',
		'doctor'
	] as const;

	function expectNoCalls(client: FakeClient) {
		for (const name of allMethods) expect(client[name]).not.toHaveBeenCalled();
	}

	it('exits 2 with usage on stderr and nothing on stdout for an empty argv', async () => {
		const client = fakeClient();

		const result = await invoke([], client);

		expect(result.code).toBe(2);
		expect(result.stderr).toMatch(/usage/i);
		expect(result.stdout).toBe('');
		expectNoCalls(client);
	});

	it('exits 2 with usage that names every command for an unknown command', async () => {
		const client = fakeClient();

		const result = await invoke(['bogus'], client);

		expect(result.code).toBe(2);
		expect(result.stderr).toMatch(/usage/i);
		for (const command of ['start', 'step', 'task', 'get', 'config', 'url', 'doctor']) {
			expect(result.stderr).toContain(command);
		}
		expect(result.stdout).toBe('');
		expectNoCalls(client);
	});

	it.each([['get'], ['task'], ['step'], ['step', 'task-1'], ['start']])(
		'exits 2 with usage when "%s" is missing a positional',
		async (...argv) => {
			const client = fakeClient();

			const result = await invoke(argv, client);

			expect(result.code).toBe(2);
			expect(result.stderr).toMatch(/usage/i);
			expect(result.stdout).toBe('');
			expectNoCalls(client);
		}
	);

	it('exits 2 with usage for an unknown flag on get', async () => {
		const client = fakeClient();

		const result = await invoke(['get', 'task-1', '--nope'], client);

		expect(result.code).toBe(2);
		expect(result.stderr).toMatch(/usage/i);
		expectNoCalls(client);
	});
});

describe('warnings from every Result command', () => {
	it.each([
		['start', ['start', 'T'], 'startTask'],
		['step', ['step', 'task-1', 'a/b', 'done'], 'updateStep'],
		['task', ['task', 'task-1', 'done'], 'updateTask'],
		['notice', ['notice', 'task-1', 'caveat', 'x'], 'addNotice'],
		['image', ['image', 'task-1', 'shot.png'], 'addImage'],
		['get', ['get', 'task-1'], 'getTask'],
		['config', ['config', '--theme', 'dark'], 'configure'],
		['url', ['url', 'task-1'], 'projectUrl']
	] as const)(
		'%s prints "chronicle: <warning>" on stderr and exits 0',
		async (_name, argv, method) => {
			const client = fakeClient();
			client[method].mockResolvedValue({ ok: false, warning: UNREACHABLE });

			const result = await invoke([...argv], client);

			expect(result.code).toBe(0);
			expect(result.stderr.trim()).toBe(`chronicle: ${UNREACHABLE}`);
			expect(result.stdout).toBe('');
		}
	);
});

describe('agent info, links and nested steps', () => {
	const ok = { ok: true, value: { taskId: 't', url: 'u' } };

	it('nests --step a/b under a, creating a missing parent', async () => {
		const client = fakeClient();
		client.startTask.mockResolvedValue(ok);

		await invoke(['start', 'T', '--step', 'a=A', '--step', 'a/x=X', '--step', 'b/y/z=Z'], client);

		expect(client.startTask.mock.calls[0][0].steps).toEqual([
			{ key: 'a', title: 'A', subtasks: [{ key: 'x', title: 'X' }] },
			{ key: 'b', subtasks: [{ key: 'y', subtasks: [{ key: 'z', title: 'Z' }] }] }
		]);
	});

	it('passes agent, links, project, repo and branch flags to startTask', async () => {
		const client = fakeClient();
		client.startTask.mockResolvedValue(ok);

		await invoke(
			[
				'start',
				'T',
				'--tool',
				'codex',
				'--model',
				'gpt',
				'--effort',
				'high',
				'--link',
				'https://github.com/me/r/issues/1|#1',
				'--project',
				'Billing',
				'--repo',
				'me/r',
				'--branch',
				'b'
			],
			client
		);

		expect(client.startTask.mock.calls[0][0]).toMatchObject({
			agent: { tool: 'codex', model: 'gpt', effort: 'high' },
			links: [{ url: 'https://github.com/me/r/issues/1', label: '#1' }],
			project: 'Billing',
			repo: 'me/r',
			branch: 'b'
		});
	});

	it('sends --tokens as a number on task and step updates', async () => {
		const client = fakeClient();
		client.updateTask.mockResolvedValue({ ok: true, value: { task: { id: 't', state: 'done' } } });
		client.updateStep.mockResolvedValue({
			ok: true,
			value: { node: { path: 'a', state: 'done' } }
		});

		await invoke(['task', 't', 'done', '--tokens', '120000'], client);
		await invoke(
			['step', 't', 'a', 'done', '--model', 'haiku', '--link', 'https://x.test'],
			client
		);

		expect(client.updateTask.mock.calls[0][0].agent).toEqual({ tokens: 120000 });
		expect(client.updateStep.mock.calls[0][0]).toMatchObject({
			agent: { model: 'haiku' },
			links: [{ url: 'https://x.test' }]
		});
	});

	it('rejects a non-numeric --tokens with exit 2', async () => {
		const result = await invoke(['task', 't', '--tokens', 'lots'], fakeClient());

		expect(result.code).toBe(2);
		expect(result.stderr).toContain('bad --tokens: lots');
	});

	it('updates the project name, notes and links and prints the name and url', async () => {
		const client = fakeClient();
		client.updateProject.mockResolvedValue({
			ok: true,
			value: { project: { name: 'Billing' }, projectUrl: 'http://h/p/1' }
		});

		const result = await invoke(
			['project', '--name', 'Billing', '--notes', 'why', '--link', 'https://trello.com/b/x|board'],
			client
		);

		expect(client.updateProject).toHaveBeenCalledWith({
			taskId: undefined,
			cwd: undefined,
			name: 'Billing',
			notes: 'why',
			links: [{ url: 'https://trello.com/b/x', label: 'board' }]
		});
		expect(result.stdout.trim()).toBe('Billing http://h/p/1');
	});
});

describe('pull requests', () => {
	it('sends each --pr as a pr url on start and task', async () => {
		const client = fakeClient();
		client.startTask.mockResolvedValue({ ok: true, value: { taskId: 't', url: 'u' } });
		client.updateTask.mockResolvedValue({
			ok: true,
			value: { task: { id: 't', state: 'review' } }
		});

		await invoke(['start', 'T', '--pr', 'https://github.com/o/r/pull/1'], client);
		await invoke(['task', 't', 'review', '--pr', 'https://github.com/o/r/pull/1'], client);

		expect(client.startTask.mock.calls[0][0].prs).toEqual([
			{ url: 'https://github.com/o/r/pull/1' }
		]);
		expect(client.updateTask.mock.calls[0][0]).toMatchObject({
			state: 'review',
			prs: [{ url: 'https://github.com/o/r/pull/1' }]
		});
	});

	it('syncs PR status once and reports what it updated', async () => {
		const client = fakeClient();
		client.syncPrs.mockResolvedValue({ ok: true, value: { checked: 2, updated: ['t1'] } });

		const result = await invoke(['sync', '--task', 't1', '--task', 't2'], client);

		expect(client.syncPrs).toHaveBeenCalledWith({ taskIds: ['t1', 't2'] });
		expect(result.stdout.trim()).toBe('checked 2, updated t1');
	});
});
