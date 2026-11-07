import { access } from 'node:fs/promises';
import { homedir, hostname } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { DEFAULT_CANDIDATES, createDiscovery } from './discovery.ts';
import {
	createStore,
	own,
	readLogin,
	removeLogin,
	writeLogin,
	type ProjectEntry
} from './files.ts';
import { UNREACHABLE_WARNING, compact, request, type Failure, type RequestInit } from './http.ts';
import { encodeImage } from './image.ts';
import { fetchPr, isFinalPr, prTarget, runCommand } from './prs.ts';
import { gitRefs, repoFromRemote, repoIdentity } from './repo.ts';
import type {
	AgentInfo,
	ClientOptions,
	DoctorReport,
	Image,
	Node,
	Notice,
	Project,
	ProjectConfig,
	Result,
	Task,
	ChronicleClient
} from './types.ts';

export type * from './types.ts';
export {
	DEFAULT_CANDIDATES,
	UNREACHABLE_WARNING,
	fetchPr,
	gitRefs,
	prTarget,
	repoFromRemote,
	repoIdentity
};

const NO_PROJECT_WARNING = 'no chronicle project for this repo yet — start a task first';

const LOGIN_LAPSED_WARNING =
	'chronicle login lapsed — run `chronicle login` to track this project; continuing untracked';

const lapsed: Failure = { ok: false, warning: LOGIN_LAPSED_WARNING };

const unknownTask = (taskId: string): Failure => ({
	ok: false,
	warning: `unknown task ${taskId} on this machine — continuing untracked`
});

// Firebase's two token endpoints answer in different casings.
interface IdentityReply {
	idToken?: string;
	refreshToken?: string;
	expiresIn?: string;
	id_token?: string;
	refresh_token?: string;
	expires_in?: string;
}

// The Firebase ID token's own claims: who signed in and for which project.
function claimsOf(idToken: string | undefined) {
	try {
		const payload = JSON.parse(Buffer.from(idToken!.split('.')[1], 'base64url').toString('utf8'));
		const { sub: uid, aud: projectId, email } = payload;
		if (typeof uid !== 'string' || typeof projectId !== 'string') return null;
		return { uid, projectId, email: typeof email === 'string' ? email : undefined };
	} catch {
		return null;
	}
}

const unreachable: Failure = { ok: false, warning: UNREACHABLE_WARNING };

// Longer waits are reported, not slept through: tracking must never stall the agent.
const MAX_RATE_LIMIT_WAIT_MS = 5000;

interface Target {
	server: string;
	projectId: string;
	key: string | undefined;
	owned: boolean;
	projectUrl: string;
}

// Build links from the server's replies, never from `server`: the address we reach it on may not be its public origin.
function projectUrlFrom(taskUrl: string, taskId: string, fallback: string): string {
	const suffix = `/t/${taskId}`;
	return taskUrl.endsWith(suffix) ? taskUrl.slice(0, -suffix.length) : fallback;
}

const taskPath = (taskId: string) => `/api/tasks/${encodeURIComponent(taskId)}`;

// Name the tool an agent runs in when the caller did not, from what the tool sets in its shell.
function withTool(
	agent: AgentInfo | undefined,
	env: Record<string, string | undefined>
): AgentInfo | undefined {
	if (agent?.tool || env.CLAUDECODE !== '1') return agent;
	return { ...agent, tool: 'claude-code' };
}

async function guard<T>(run: () => Promise<Result<T>>): Promise<Result<T>> {
	try {
		const result = await run();
		return result.ok ? result : { ok: false, warning: result.warning };
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return { ok: false, warning: `chronicle failed: ${message}` };
	}
}

export function createClient(options: ClientOptions = {}): ChronicleClient {
	const env = options.env ?? process.env;
	const run = options.runCommand ?? runCommand;
	// Tasks whose PRs have all merged or closed: nothing left to watch in this process.
	const settledPrs = new Set<string>();
	const fetchFn = options.fetch ?? globalThis.fetch;
	const requestTimeoutMs = options.requestTimeoutMs ?? 2000;
	const imageTimeoutMs = options.imageTimeoutMs ?? 15_000;
	const configDir =
		options.configDir ?? join(env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'chronicle');
	const store = createStore(configDir);
	const loginFile =
		options.loginFile ??
		join(env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'runestone', 'login.json');
	const discovery = createDiscovery({
		fetch: fetchFn,
		env,
		candidates: options.candidates ?? DEFAULT_CANDIDATES,
		probeTimeoutMs: options.probeTimeoutMs ?? 300,
		remoteProbeTimeoutMs: options.remoteProbeTimeoutMs ?? 2000
	});

	async function send<T>(
		server: string,
		path: string,
		init: RequestInit,
		timeoutMs = requestTimeoutMs
	) {
		const reply = await request<T>(fetchFn, timeoutMs, `${server}${path}`, init);
		if (
			reply.ok ||
			reply.status !== 429 ||
			reply.retryAfterMs === undefined ||
			reply.retryAfterMs > MAX_RATE_LIMIT_WAIT_MS
		) {
			return reply;
		}
		await sleep(reply.retryAfterMs);
		return request<T>(fetchFn, timeoutMs, `${server}${path}`, init);
	}

	// Owned Projects carry no write key; the user's API token for that server writes them.
	const idTokens = new Map<string, { idToken: string; refreshToken: string; expiresAt: number }>();
	const webKeys = new Map<string, { apiKey: string; projectId: string }>();
	const identity = options.identityUrls ?? {
		signIn: 'https://identitytoolkit.googleapis.com/v1/accounts:signInWithCustomToken',
		refresh: 'https://securetoken.googleapis.com/v1/token'
	};
	const EXPIRY_MARGIN_MS = 60_000;

	async function identityCall(
		url: string,
		apiKey: string,
		init: globalThis.RequestInit
	): Promise<IdentityReply | undefined> {
		try {
			const res = await fetchFn(`${url}?key=${encodeURIComponent(apiKey)}`, {
				...init,
				signal: AbortSignal.timeout(requestTimeoutMs * 4)
			});
			return res.ok ? ((await res.json()) as IdentityReply) : undefined;
		} catch {
			return undefined;
		}
	}

	async function webKeyFor(server: string): Promise<{ apiKey: string; projectId: string } | null> {
		const known = webKeys.get(server);
		if (known) return known;
		const reply = await send<{ apiKey: string; projectId: string }>(server, '/api/auth/config', {
			method: 'GET'
		});
		if (!reply.ok) return null;
		webKeys.set(server, reply.body);
		return reply.body;
	}

	// The Firebase ID token this machine sends as the bearer, refreshed shortly before it expires.
	// The login file is read on every call: another Runestone tool may have replaced it.
	async function tokenFor(server: string): Promise<string | undefined> {
		const login = await readLogin(loginFile);
		if (!login) return undefined;
		const cached = idTokens.get(server);
		if (
			cached &&
			cached.refreshToken === login.refreshToken &&
			cached.expiresAt - Date.now() > EXPIRY_MARGIN_MS
		) {
			return cached.idToken;
		}
		const web = await webKeyFor(server);
		if (!web || web.projectId !== login.projectId) return undefined;
		const body = await identityCall(identity.refresh, web.apiKey, {
			method: 'POST',
			headers: { 'content-type': 'application/x-www-form-urlencoded' },
			body: new URLSearchParams({
				grant_type: 'refresh_token',
				refresh_token: login.refreshToken
			}).toString()
		});
		if (!body?.id_token) return undefined;
		const refreshToken = body.refresh_token || login.refreshToken;
		idTokens.set(server, {
			idToken: body.id_token,
			refreshToken,
			expiresAt: Date.now() + Number(body.expires_in ?? 3600) * 1000
		});
		if (refreshToken !== login.refreshToken) {
			const current = await readLogin(loginFile);
			if (current?.refreshToken === login.refreshToken) {
				await writeLogin(loginFile, { ...current, refreshToken }).catch(() => {});
			}
		}
		return body.id_token;
	}

	async function keyFor(
		server: string,
		entry: ProjectEntry | undefined
	): Promise<string | undefined> {
		return entry?.writeKey || (await tokenFor(server));
	}

	async function createProject(
		server: string,
		name: string | undefined,
		replacingOwned = false
	): Promise<{ ok: true; entry: ProjectEntry } | Failure> {
		const token = await tokenFor(server);
		if (
			!token &&
			(replacingOwned ||
				(await access(loginFile).then(
					() => true,
					() => false
				)))
		) {
			return lapsed;
		}
		const reply = await send<{ id: string; writeKey?: string; name?: string; url?: string }>(
			server,
			'/api/projects',
			{ method: 'POST', key: token, body: compact({ name }) }
		);
		if (!reply.ok) return reply;
		const { id, writeKey = '', url } = reply.body;
		return {
			ok: true,
			entry: {
				projectId: id,
				writeKey,
				name: reply.body.name ?? name ?? '',
				projectUrl: url || `${server}/p/${id}`
			}
		};
	}

	async function renameProject(
		server: string,
		repoKey: string,
		entry: ProjectEntry,
		name: string
	): Promise<ProjectEntry> {
		const reply = await send<{ project: Project }>(
			server,
			`/api/projects/${encodeURIComponent(entry.projectId)}`,
			{ method: 'PATCH', key: await keyFor(server, entry), body: { name } }
		);
		if (!reply.ok) return entry;
		const renamed = { ...entry, name: reply.body.project.name };
		await store.saveProject(server, repoKey, renamed).catch(() => {});
		return renamed;
	}

	async function targetFromTask(taskId: string): Promise<Result<Target>> {
		const handle = own(await store.readTasks(), taskId);
		if (!handle) return unknownTask(taskId);
		const forServer = own(await store.readProjects(), handle.server) ?? {};
		const entry = Object.values(forServer).find((e) => e?.projectId === handle.projectId);
		return {
			ok: true,
			value: {
				server: handle.server,
				projectId: handle.projectId,
				key: await keyFor(handle.server, entry),
				owned: entry?.writeKey === '',
				projectUrl:
					handle.projectUrl ?? entry?.projectUrl ?? `${handle.server}/p/${handle.projectId}`
			}
		};
	}

	async function targetFromRepo(cwd: string | undefined): Promise<Result<Target>> {
		const server = await discovery.discover();
		if (!server) return unreachable;
		const { repoKey } = await repoIdentity(cwd ?? process.cwd());
		const entry = own(own(await store.readProjects(), server), repoKey);
		if (!entry) return { ok: false, warning: NO_PROJECT_WARNING };
		return {
			ok: true,
			value: {
				server,
				projectId: entry.projectId,
				key: await keyFor(server, entry),
				owned: entry.writeKey === '',
				projectUrl: entry.projectUrl ?? `${server}/p/${entry.projectId}`
			}
		};
	}

	const targetFor = (input: { taskId?: string; cwd?: string }) =>
		input.taskId === undefined ? targetFromRepo(input.cwd) : targetFromTask(input.taskId);

	async function writeTarget(taskId: string): Promise<Result<Target & { key: string }>> {
		const target = await targetFromTask(taskId);
		if (!target.ok) return target;
		if (!target.value.key) return target.value.owned ? lapsed : unknownTask(taskId);
		return { ok: true, value: { ...target.value, key: target.value.key } };
	}

	const api: ChronicleClient = {
		login,
		logout,
		discover: () => discovery.discover().catch(() => null),

		startTask: (input) =>
			guard(async () => {
				const server = await discovery.discover();
				if (!server) return unreachable;
				const cwd = input.cwd ?? process.cwd();
				const { repoKey } = await repoIdentity(cwd);
				await store.assertReadable();

				const resolved = await store.resolveProject(server, repoKey, () =>
					createProject(server, input.project)
				);
				if (!resolved.ok) return resolved;
				let entry = resolved.entry;
				let createdProject = resolved.created;
				if (!createdProject && input.project && input.project !== entry.name) {
					entry = await renameProject(server, repoKey, entry, input.project);
				}

				const refs = await gitRefs(cwd);
				const body = compact({
					title: input.title,
					summary: input.summary,
					state: input.state,
					note: input.note,
					steps: input.steps,
					agent: withTool(input.agent, env),
					links: input.links,
					prs: input.prs,
					repo: input.repo ?? refs.repo,
					branch: input.branch ?? refs.branch
				});
				const post = async (e: ProjectEntry) =>
					send<{ taskId: string; url: string }>(
						server,
						`/api/projects/${encodeURIComponent(e.projectId)}/tasks`,
						{ method: 'POST', key: await keyFor(server, e), body }
					);

				if (!createdProject && !entry.writeKey && !(await keyFor(server, entry))) return lapsed;

				let reply = await post(entry);
				const owned = !entry.writeKey;
				const rejected = owned ? [404] : [401, 403, 404];
				if (!reply.ok && !createdProject && rejected.includes(reply.status ?? 0)) {
					const replaced = await store.resolveProject(
						server,
						repoKey,
						() => createProject(server, input.project, owned),
						entry
					);
					if (!replaced.ok) return replaced;
					entry = replaced.entry;
					createdProject = replaced.created;
					reply = await post(entry);
				}
				if (!reply.ok) return reply;

				const { taskId, url } = reply.body;
				const projectUrl = projectUrlFrom(
					url,
					taskId,
					entry.projectUrl ?? `${server}/p/${entry.projectId}`
				);
				await store
					.saveTask(taskId, { server, projectId: entry.projectId, projectUrl })
					.catch(() => {});
				return {
					ok: true,
					value: { taskId, url, server, projectId: entry.projectId, projectUrl, createdProject }
				};
			}),

		updateStep: (input) =>
			guard(async () => {
				const target = await writeTarget(input.taskId);
				if (!target.ok) return target;
				const { server, key } = target.value;
				const path = input.path.split('/').map(encodeURIComponent).join('/');
				const reply = await send<{ node: Node }>(
					server,
					`${taskPath(input.taskId)}/nodes/${path}`,
					{
						method: 'PUT',
						key,
						body: compact({
							title: input.title,
							state: input.state,
							note: input.note,
							tags: input.tags,
							agent: input.agent,
							links: input.links,
							position: input.position
						})
					}
				);
				return reply.ok ? { ok: true, value: { node: reply.body.node } } : reply;
			}),

		updateTask: (input) =>
			guard(async () => {
				const target = await writeTarget(input.taskId);
				if (!target.ok) return target;
				const { server, key } = target.value;
				const reply = await send<{ task: Task }>(server, taskPath(input.taskId), {
					method: 'PATCH',
					key,
					body: compact({
						title: input.title,
						summary: input.summary,
						state: input.state,
						note: input.note,
						agent: input.agent,
						links: input.links,
						prs: input.prs
					})
				});
				return reply.ok ? { ok: true, value: { task: reply.body.task } } : reply;
			}),

		syncPrs: (input = {}) =>
			guard(async () => {
				const ids = input.taskIds ?? Object.keys(await store.readTasks());
				const updated: string[] = [];
				let checked = 0;
				for (const taskId of ids) {
					if (settledPrs.has(taskId)) continue;
					const current = await api.getTask({ taskId });
					if (!current.ok) continue;
					const { task } = current.value;
					if (task.prs.length === 0) continue;
					if (task.prs.every(isFinalPr)) {
						settledPrs.add(taskId);
						continue;
					}
					checked += 1;
					const prs = await Promise.all(
						task.prs.map(async (pr) =>
							isFinalPr(pr) ? pr : { ...pr, ...((await fetchPr(pr.url, run)) ?? {}) }
						)
					);
					const state = prs.every((pr) => pr.state === 'merged')
						? await mergedState(taskId, task.state)
						: undefined;
					if (JSON.stringify(prs) === JSON.stringify(task.prs) && !state) continue;
					const write = await api.updateTask({
						taskId,
						prs,
						...(state ? { state, note: 'merged' } : {})
					});
					if (write.ok) updated.push(taskId);
				}
				return { ok: true, value: { checked, updated } };
			}),

		updateProject: (input) =>
			guard(async () => {
				const target = await targetFor(input);
				if (!target.ok) return target;
				const { server, projectId, key, projectUrl } = target.value;
				if (!key) {
					return input.taskId === undefined
						? { ok: false, warning: NO_PROJECT_WARNING }
						: unknownTask(input.taskId);
				}
				const reply = await send<{ project: Project }>(
					server,
					`/api/projects/${encodeURIComponent(projectId)}`,
					{
						method: 'PATCH',
						key,
						body: compact({ name: input.name, notes: input.notes, links: input.links })
					}
				);
				return reply.ok ? { ok: true, value: { project: reply.body.project, projectUrl } } : reply;
			}),

		addNotice: (input) =>
			guard(async () => {
				const target = await writeTarget(input.taskId);
				if (!target.ok) return target;
				const { server, key } = target.value;
				const reply = await send<{ notice: Notice }>(server, `${taskPath(input.taskId)}/notices`, {
					method: 'POST',
					key,
					body: compact({ kind: input.kind, text: input.text, path: input.path })
				});
				return reply.ok ? { ok: true, value: { notice: reply.body.notice } } : reply;
			}),

		addImage: (input) =>
			guard(async () => {
				const target = await writeTarget(input.taskId);
				if (!target.ok) return target;
				const { server, key } = target.value;
				const encoded = await encodeImage(input.file, input.review === true);
				if (!encoded.ok) return encoded;
				const reply = await send<{ image: Image }>(
					server,
					`${taskPath(input.taskId)}/images`,
					{
						method: 'POST',
						key,
						body: compact({
							thumb: encoded.thumb,
							full: encoded.full,
							caption: input.caption,
							path: input.path
						})
					},
					imageTimeoutMs
				);
				return reply.ok ? { ok: true, value: { image: reply.body.image } } : reply;
			}),

		getTask: (input) =>
			guard(async () => {
				const target = await targetFromTask(input.taskId);
				if (!target.ok) return target;
				const { server, projectUrl } = target.value;
				const reply = await send<{ task: Task; nodes: Node[]; notices?: Notice[] }>(
					server,
					taskPath(input.taskId),
					{ method: 'GET' }
				);
				if (!reply.ok) return reply;
				return {
					ok: true,
					value: {
						task: reply.body.task,
						nodes: reply.body.nodes,
						notices: reply.body.notices ?? [],
						url: `${projectUrl}/t/${input.taskId}`
					}
				};
			}),

		configure: (input) =>
			guard(async () => {
				const target = await targetFor(input);
				if (!target.ok) return target;
				const { server, projectId, key, projectUrl } = target.value;
				const base = `/api/projects/${encodeURIComponent(projectId)}`;

				const writing = input.config ?? input.patch;
				if (writing && !key) {
					return input.taskId === undefined
						? { ok: false, warning: NO_PROJECT_WARNING }
						: unknownTask(input.taskId);
				}

				if (input.config) {
					const reply = await send<{ config: ProjectConfig }>(server, `${base}/config`, {
						method: 'PUT',
						key,
						body: input.config
					});
					return reply.ok ? { ok: true, value: { config: reply.body.config, projectUrl } } : reply;
				}
				if (input.patch) {
					const reply = await send<{ config: ProjectConfig }>(server, `${base}/config`, {
						method: 'PATCH',
						key,
						body: input.patch
					});
					return reply.ok ? { ok: true, value: { config: reply.body.config, projectUrl } } : reply;
				}
				const reply = await send<{ project: { config: ProjectConfig } }>(server, base, {
					method: 'GET'
				});
				return reply.ok
					? { ok: true, value: { config: reply.body.project.config, projectUrl } }
					: reply;
			}),

		projectUrl: (input) =>
			guard(async () => {
				const target = await targetFor(input);
				if (!target.ok) return target;
				const url = target.value.projectUrl;
				return { ok: true, value: { url: input.taskId ? `${url}/t/${input.taskId}` : url } };
			}),

		async doctor(input = {}): Promise<DoctorReport> {
			const { repoKey } = await repoIdentity(input.cwd ?? process.cwd());
			const probes = await discovery.probeAll();
			const server = probes.find((p) => p.ok)?.server ?? null;
			let registryError: string | null = null;
			let entry: ProjectEntry | undefined;
			try {
				await store.assertReadable();
				entry = server ? own(own(await store.readProjects(), server), repoKey) : undefined;
			} catch (error) {
				registryError = error instanceof Error ? error.message : String(error);
			}
			return {
				configDir,
				pinned: discovery.pinned,
				probes,
				server,
				repoKey,
				registered: entry ? { projectId: entry.projectId, name: entry.name } : null,
				registryError
			};
		}
	};

	function login(input: Parameters<ChronicleClient['login']>[0] = {}) {
		return guard(async () => {
			const server = await discovery.discover();
			if (!server) return unreachable;
			const started = await send<{
				deviceCode: string;
				userCode: string;
				verificationUrl: string;
				expiresIn: number;
				interval: number;
			}>(server, '/api/auth/device', {
				method: 'POST',
				body: { label: input.label ?? `chronicle on ${hostname()}` }
			});
			if (!started.ok) return started;
			const { deviceCode, userCode, verificationUrl, expiresIn, interval } = started.body;
			input.onCode?.({ userCode, verificationUrl, expiresIn });
			const deadline = Date.now() + expiresIn * 1000;
			while (Date.now() < deadline) {
				await sleep(options.loginPollMs ?? interval * 1000);
				const polled = await send<{ status: string; customToken?: string; apiKey?: string }>(
					server,
					'/api/auth/device/token',
					{ method: 'POST', key: deviceCode }
				);
				if (!polled.ok) return polled;
				const { customToken, apiKey } = polled.body;
				if (customToken && apiKey) {
					const signedIn = await identityCall(identity.signIn, apiKey, {
						method: 'POST',
						headers: { 'content-type': 'application/json' },
						body: JSON.stringify({ token: customToken, returnSecureToken: true })
					});
					if (!signedIn?.refreshToken) {
						return { ok: false, warning: 'Firebase refused the login; try again' };
					}
					const claims = claimsOf(signedIn.idToken);
					if (!claims) return { ok: false, warning: 'Firebase refused the login; try again' };
					await writeLogin(loginFile, {
						refreshToken: signedIn.refreshToken,
						uid: claims.uid,
						...(claims.email && { email: claims.email }),
						projectId: claims.projectId
					});
					idTokens.set(server, {
						idToken: signedIn.idToken!,
						refreshToken: signedIn.refreshToken,
						expiresAt: Date.now() + Number(signedIn.expiresIn ?? 3600) * 1000
					});
					return { ok: true, value: { server } };
				}
			}
			return { ok: false, warning: 'login timed out before it was approved' };
		});
	}

	function logout() {
		return guard(async () => {
			const server = await discovery.discover();
			if (!server) return unreachable;
			if (!(await readLogin(loginFile))) return { ok: false, warning: 'not logged in' };
			const token = await tokenFor(server);
			const reply = token
				? await send(server, '/api/me/agents', { method: 'DELETE', key: token })
				: undefined;
			await removeLogin(loginFile);
			idTokens.clear();
			return { ok: true, value: { server, revoked: reply?.ok ?? false } };
		});
	}

	// A task waiting in a review-kind state moves to the first done-kind state once every PR merged.
	async function mergedState(taskId: string, state: string): Promise<string | undefined> {
		const read = await api.configure({ taskId });
		if (!read.ok) return undefined;
		const { states } = read.value.config;
		if (states.find((s) => s.key === state)?.kind !== 'review') return undefined;
		return states.find((s) => s.kind === 'done')?.key;
	}

	return api;
}
