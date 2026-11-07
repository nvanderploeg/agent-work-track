import { randomBytes } from 'node:crypto';
import { chmod, mkdir, open, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { setTimeout as sleep } from 'node:timers/promises';
import { dirname, join } from 'node:path';

export interface ProjectEntry {
	projectId: string;
	writeKey: string;
	name: string;
	projectUrl?: string;
}

export interface TaskHandle {
	server: string;
	projectId: string;
	projectUrl?: string;
}

// The Runestone login file, shared by every Runestone tool on the machine. The refresh token
// never expires on its own, so the file is as sensitive as a password.
export interface Login {
	refreshToken: string;
	uid: string;
	email?: string;
	projectId: string;
}

export type ProjectsFile = Record<string, Record<string, ProjectEntry>>;
export type TasksFile = Record<string, TaskHandle>;

export function own<T>(record: Record<string, T> | undefined, key: string): T | undefined {
	return record && Object.hasOwn(record, key) ? record[key] : undefined;
}

// Throw rather than read a damaged registry as empty: the next write would drop every write key in it.
async function readJson<T>(path: string): Promise<Record<string, T>> {
	let text: string;
	try {
		text = await readFile(path, 'utf8');
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {};
		throw new Error(`cannot read ${path}`, { cause: error });
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		parsed = undefined;
	}
	if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
		throw new Error(`${path} is not a JSON object; fix or delete it`);
	}
	return parsed as Record<string, T>;
}

async function tightenDir(dir: string): Promise<void> {
	try {
		if (((await stat(dir)).mode & 0o077) !== 0) await chmod(dir, 0o700);
	} catch {
		// absent or not ours: nothing to tighten
	}
}

export async function readLogin(path: string): Promise<Login | null> {
	await tightenDir(dirname(path));
	let parsed: unknown;
	try {
		parsed = JSON.parse(await readFile(path, 'utf8'));
	} catch {
		return null;
	}
	const login = parsed as Partial<Login> | null;
	if (
		typeof login?.refreshToken !== 'string' ||
		typeof login.uid !== 'string' ||
		typeof login.projectId !== 'string'
	) {
		return null;
	}
	return {
		refreshToken: login.refreshToken,
		uid: login.uid,
		...(typeof login.email === 'string' && { email: login.email }),
		projectId: login.projectId
	};
}

export const writeLogin = (path: string, login: Login): Promise<void> => writeJson(path, login);

export const removeLogin = (path: string): Promise<void> =>
	unlink(path).catch((error: NodeJS.ErrnoException) => {
		if (error.code !== 'ENOENT') throw error;
	});

async function writeJson(path: string, data: unknown): Promise<void> {
	await mkdir(dirname(path), { recursive: true, mode: 0o700 });
	await tightenDir(dirname(path));
	const tmp = join(dirname(path), `.tmp-${process.pid}-${randomBytes(6).toString('hex')}`);
	try {
		await writeFile(tmp, JSON.stringify(data, null, 2) + '\n', { mode: 0o600 });
		await rename(tmp, path);
	} catch (error) {
		await unlink(tmp).catch(() => {});
		throw error;
	}
}

const LOCK_WAIT_MS = 3000;
const LOCK_STALE_MS = 10_000;
const queues = new Map<string, Promise<unknown>>();

async function acquireFileLock(lockPath: string): Promise<(() => Promise<void>) | null> {
	await mkdir(dirname(lockPath), { recursive: true, mode: 0o700 });
	const deadline = Date.now() + LOCK_WAIT_MS;
	while (Date.now() < deadline) {
		try {
			const handle = await open(lockPath, 'wx', 0o600);
			return async () => {
				await handle.close().catch(() => {});
				await unlink(lockPath).catch(() => {});
			};
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== 'EEXIST') return null;
			const age = await stat(lockPath).then(
				(s) => Date.now() - s.mtimeMs,
				() => 0
			);
			if (age > LOCK_STALE_MS) await unlink(lockPath).catch(() => {});
			else await sleep(20);
		}
	}
	return null;
}

// A lock that cannot be taken in time is skipped: tracking must never block the agent.
function withLock<T>(lockPath: string, run: () => Promise<T>): Promise<T> {
	const previous = queues.get(lockPath) ?? Promise.resolve();
	const next = previous.then(async () => {
		const release = await acquireFileLock(lockPath);
		try {
			return await run();
		} finally {
			await release?.();
		}
	});
	const settled = next.catch(() => {});
	queues.set(lockPath, settled);
	void settled.then(() => {
		if (queues.get(lockPath) === settled) queues.delete(lockPath);
	});
	return next;
}

export type Resolved<F> = { ok: true; entry: ProjectEntry; created: boolean } | F;

export function createStore(configDir: string) {
	const projectsPath = join(configDir, 'projects.json');
	const tasksPath = join(configDir, 'tasks.json');
	const lockPath = join(configDir, '.lock');

	async function putProject(server: string, repoKey: string, entry: ProjectEntry): Promise<void> {
		const projects = await readJson<ProjectsFile[string]>(projectsPath);
		projects[server] = { ...own(projects, server), [repoKey]: entry };
		await writeJson(projectsPath, projects);
	}

	return {
		readProjects: () => readJson<ProjectsFile[string]>(projectsPath),
		assertReadable: async () => {
			await readJson(projectsPath);
			await readJson(tasksPath);
		},
		readTasks: () => readJson<TaskHandle>(tasksPath),
		saveProject: (server: string, repoKey: string, entry: ProjectEntry) =>
			withLock(lockPath, () => putProject(server, repoKey, entry)),
		saveTask: (taskId: string, handle: TaskHandle) =>
			withLock(lockPath, async () => {
				const tasks = await readJson<TaskHandle>(tasksPath);
				tasks[taskId] = handle;
				await writeJson(tasksPath, tasks);
			}),
		// `replacing` names an entry the server rejected; it is replaced only if still current.
		resolveProject: <F>(
			server: string,
			repoKey: string,
			create: () => Promise<{ ok: true; entry: ProjectEntry } | F>,
			replacing?: ProjectEntry
		): Promise<Resolved<F>> =>
			withLock(lockPath, async () => {
				const current = own(
					own(await readJson<ProjectsFile[string]>(projectsPath), server),
					repoKey
				);
				if (current && current.projectId !== replacing?.projectId) {
					return { ok: true as const, entry: current, created: false };
				}
				const made = await create();
				if (typeof made !== 'object' || made === null || !('ok' in made) || made.ok !== true) {
					return made as F;
				}
				const { entry } = made as { ok: true; entry: ProjectEntry };
				await putProject(server, repoKey, entry).catch(() => {});
				return { ok: true as const, entry, created: true };
			})
	};
}
