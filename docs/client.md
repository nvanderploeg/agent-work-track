# chronicle client, CLI and MCP contract

Builds on `docs/api.md` (types, HTTP routes, client files, discovery). Nothing here may throw into an agent's work: every failure becomes a warning.

## `@chronicle/client` (`packages/client/src/index.ts`)

```ts
export const DEFAULT_CANDIDATES = ['http://localhost:3280', 'https://chronicle.nanzero.com'];
export const UNREACHABLE_WARNING = 'chronicle unreachable — continuing untracked';

export interface ClientOptions {
	env?: Record<string, string | undefined>; // default process.env
	configDir?: string; // default `${XDG_CONFIG_HOME ?? ~/.config}/chronicle`, read from `env`
	fetch?: typeof fetch; // default globalThis.fetch
	candidates?: string[]; // default DEFAULT_CANDIDATES
	probeTimeoutMs?: number; // loopback hosts; default 300
	remoteProbeTimeoutMs?: number; // every other host; default 2000
	requestTimeoutMs?: number; // default 2000
	imageTimeoutMs?: number; // addImage uploads; default 15000
	runCommand?: (command: string, args: string[]) => Promise<string | null>; // default execFile, 15 s; null on failure
}

export type Result<T> = { ok: true; value: T } | { ok: false; warning: string };

export interface StepInput {
	key: string;
	title?: string;
	state?: string;
	note?: string;
	tags?: Tag[];
	agent?: AgentInfo;
	links?: Link[];
	subtasks?: StepInput[];
}

export interface DoctorReport {
	configDir: string;
	pinned: string | null; // CHRONICLE_URL, normalised
	probes: { server: string; ok: boolean; version?: string }[];
	server: string | null; // what discover() picked
	repoKey: string;
	registered: { projectId: string; name: string } | null; // registry entry for (server, repoKey)
	registryError: string | null; // why projects.json or tasks.json cannot be read
}

export interface ChronicleClient {
	discover(): Promise<string | null>;
	startTask(input: {
		title: string;
		summary?: string;
		state?: string;
		note?: string;
		steps?: StepInput[];
		agent?: AgentInfo;
		links?: Link[];
		prs?: PullRequest[];
		repo?: string; // default: `owner/name` of the cwd's origin remote
		branch?: string; // default: the cwd's checked-out branch
		project?: string; // project name on creation; renames the registered project when it differs
		cwd?: string; // default process.cwd()
	}): Promise<
		Result<{
			taskId: string;
			url: string; // from the server response
			server: string;
			projectId: string;
			projectUrl: string; // the task `url` minus `/t/<taskId>`
			createdProject: boolean;
		}>
	>;
	updateStep(input: {
		taskId: string;
		path: string;
		title?: string;
		state?: string;
		note?: string;
		tags?: Tag[];
		agent?: AgentInfo;
		links?: Link[];
		position?: number;
	}): Promise<Result<{ node: Node }>>;
	updateTask(input: {
		taskId: string;
		title?: string;
		summary?: string;
		state?: string;
		note?: string;
		agent?: AgentInfo;
		links?: Link[];
		prs?: PullRequest[];
	}): Promise<Result<{ task: Task }>>;
	syncPrs(input?: { taskIds?: string[] }): Promise<Result<{ checked: number; updated: string[] }>>;
	updateProject(input: {
		taskId?: string;
		cwd?: string;
		name?: string;
		notes?: string;
		links?: Link[];
	}): Promise<Result<{ project: Project; projectUrl: string }>>;
	addNotice(input: {
		taskId: string;
		kind: NoticeKind;
		text: string;
		path?: string;
	}): Promise<Result<{ notice: Notice }>>;
	addImage(input: {
		taskId: string;
		file: string; // any format sharp reads (PNG, JPEG, WebP, GIF first frame); relative to process.cwd()
		path?: string;
		caption?: string;
		review?: boolean; // also send a 512 px view the user is meant to look at
	}): Promise<Result<{ image: Image }>>;
	getTask(input: {
		taskId: string;
	}): Promise<Result<{ task: Task; nodes: Node[]; notices: Notice[]; url: string }>>;
	configure(input: {
		taskId?: string;
		cwd?: string;
		config?: ProjectConfig; // → PUT
		patch?: ConfigPatch; // → PATCH (ignored when config is given)
	}): Promise<Result<{ config: ProjectConfig; projectUrl: string }>>; // neither → read current config
	projectUrl(input: { taskId?: string; cwd?: string }): Promise<Result<{ url: string }>>;
	doctor(input?: { cwd?: string }): Promise<DoctorReport>;
}

export function createClient(options?: ClientOptions): ChronicleClient;
export function repoIdentity(cwd: string): Promise<{ repoKey: string; name: string }>;
export function gitRefs(cwd: string): Promise<{ repo?: string; branch?: string }>;
export function repoFromRemote(remote: string): string | undefined; // last two path segments, minus `.git`
```

Also export the `Tag`, `AgentInfo`, `Link`, `Project`, `Task`, `Node`, `Image`, `ProjectConfig`, `ConfigPatch`, `StateDef` types exactly as `docs/api.md` defines them.

Behaviour:

- **discover** — server URLs are normalised by trimming whitespace and trailing `/`. `CHRONICLE_URL` set and non-empty → probe it alone; healthy → it, else `null`; the candidates are never tried. Otherwise the first healthy candidate in order, else `null`. Healthy = `GET <server>/api/health` answers 2xx with JSON `service === 'chronicle'` within `probeTimeoutMs` when the host is loopback (`localhost`, `*.localhost`, `127.*`, `[::1]`), else within `remoteProbeTimeoutMs`.
- **startTask** — `discover()`; `null` → `{ ok: false, warning: UNREACHABLE_WARNING }`. Look up `projects.json[server][repoKey]`; absent → `POST /api/projects` with `{ name: project }` when `project` is given, else `{}`, and save the entry with the returned `name` and `url` as `projectUrl` (`createdProject: true`). Present with a `name` other than a given `project` → `PATCH /api/projects/:id { name }` and save the new name; a failed rename is ignored. Then `POST /api/projects/:id/tasks` with `Authorization: Bearer <writeKey>`, body `{ title, summary, state, note, steps, agent, links, repo, branch }` (omit undefined fields). `repo` and `branch` default to `gitRefs(cwd)`; `agent.tool` defaults to `'claude-code'` when `env.CLAUDECODE === '1'`. If that answers 401, 403 or 404, create a fresh project, overwrite the registry entry, and retry once (`createdProject: true`). Save `tasks.json[taskId] = { server, projectId, projectUrl }`.
- **updateStep / updateTask / addNotice / getTask** — need `tasks.json[taskId]`; absent → `{ ok: false, warning: 'unknown task <taskId> on this machine — continuing untracked' }`. The write key is the `projects.json[handle.server]` entry whose `projectId` matches. They use `handle.server` only — no discovery. Each path segment is URI-encoded; `/` separators are kept. `getTask`'s `url` = `${projectUrl}/t/${taskId}`, and its `notices` is `[]` when the server sends none. `addNotice` is `POST /api/tasks/:taskId/notices` with `{ kind, text, path }`.
- **addImage** — same handle rules as `addNotice`. Shrinks `file` with `sharp` (EXIF-rotated, alpha flattened onto white, metadata stripped, never enlarged) to fit 256×256 as `thumb` and, when `review`, 512×512 as `full`; mozjpeg at quality 60, then 45, then 30 until `thumb` ≤ 64 KiB and `full` ≤ 192 KiB, else `chronicle failed: <file> does not compress under the image limit`. Then `POST /api/tasks/:taskId/images` with `{ thumb, full, caption, path }` as base64. `sharp` is imported lazily: missing or failing to load → `chronicle failed: image support unavailable (sharp did not load)`; an unreadable file → `chronicle failed: cannot read image <file>`.
- **configure / projectUrl / updateProject** — the project comes from the `taskId` handle when given, else from `projects.json[discover()][repoKey(cwd)]`. Neither → `{ ok: false, warning: 'no chronicle project for this repo yet — start a task first' }`. Every returned link starts with the project's `projectUrl` from the handle or registry entry, else `${server}/p/${projectId}`.
- **Rate limit** — a 429 whose `Retry-After` is at most 5 s is waited out and the request sent once more; a longer or missing one is reported like any other rejection.
- **Failures** — network error, timeout (`requestTimeoutMs`) or 5xx → `UNREACHABLE_WARNING`. Other non-2xx → `chronicle rejected the update: <error>`, plus ` (valid states: a, b, c)` when the body has `validStates`. Methods never throw or reject.
- **Files** — `projects.json` and `tasks.json` in `configDir` (layout in `docs/api.md`). A missing file reads as `{}`. An unreadable file, or one that is not a JSON object, is never overwritten: the call returns `chronicle failed: <path> is not a JSON object; fix or delete it` (or `cannot read <path>`) before contacting a server, and `startTask` checks both files first. Writes create `configDir` (0700) and write to a temp file then rename, mode 0600.
- **syncPrs** — for each task (`taskIds`, default every task in `tasks.json`): `getTask`; skip tasks without PRs; a task whose PRs are all `merged` or `closed` is skipped for the rest of the client's life. Otherwise refresh each open PR with `fetchPr` and merge the result over the stored entry. When every PR is `merged` and the task's state has kind `review`, also set the first done-kind state with note `merged` (config read through `configure`). `updateTask` only when the PRs or state changed. `checked` counts tasks with an open PR.
- **fetchPr(url, run)** — GitHub (`/<owner>/<repo>/pull/<n>`): `gh pr view <url> --json number,title,state,isDraft,reviewDecision,statusCheckRollup`. GitLab (`/<project>/-/merge_requests/<n>`): `glab mr view <n> --repo <project> --output json` (host prefixed for self-hosted). Maps to `PullRequest`; any check failed → `failing`, else any still running → `pending`, else `passing`; no checks → omitted. Unknown forge, missing or signed-out CLI, or unparseable output → `null`.
- **updateProject** — needs the write key of the resolved project (else the no-project or unknown-task warning); `PATCH /api/projects/:id` with the given `name`, `notes`, `links`.
- **gitRefs** — `git remote get-url origin` through `repoFromRemote`, and `git symbolic-ref --short -q HEAD`; anything git cannot answer (no repo, no remote, detached HEAD) is omitted.
- **repoIdentity** — `git -C <cwd> rev-parse --path-format=absolute --git-common-dir`; success → `repoKey` = that path, `name` = basename of its parent when the path's basename is `.git`, else basename of the path. Failure (not a repo / no git) → `repoKey` = `realpath(cwd)`, `name` = its basename.

## `chronicle` CLI (`packages/cli`)

`src/run.ts` exports `run(argv: string[], io: { stdout: (s: string) => void; stderr: (s: string) => void; client?: ChronicleClient }): Promise<number>`; `src/index.ts` calls it with `process.argv.slice(2)` and exits with its code. Parse with `node:util` `parseArgs`.

```
chronicle start <title> [--summary s] [--state k] [--note n] [--step key[/sub]=Title]... [--project name]
                [--repo owner/name] [--branch b] [agent] [--link url[|label]]... [--cwd dir]
    stdout: "<taskId> <url>"
chronicle step <taskId> <path> [state] [--title t] [--note n] [--tag text[|color]]... [--position n]
                [agent] [--link url[|label]]...
    stdout: "<path> <state>"
chronicle task <taskId> [state] [--title t] [--summary s] [--note n] [agent] [--link url[|label]]... [--pr url]...
    stdout: "<taskId> <state>"
chronicle sync [--task id]...
    syncPrs once. stdout: "checked <n>, updated <ids|none>"
chronicle project [--name n] [--notes s] [--link url[|label]]... [--task id] [--cwd dir]
    stdout: "<name> <projectUrl>"
chronicle get <taskId>
    stdout: JSON of { task, nodes, url }
chronicle config [--file path.json] [--theme t] [--color state=color]... [--initial state] [--task id] [--cwd dir]
    --file → PUT that config; --theme/--color/--initial → PATCH; nothing → read. stdout: JSON config
chronicle url [taskId] [--cwd dir]
    stdout: the task URL with a taskId, else the project URL
chronicle doctor [--cwd dir]
    stdout: human-readable DoctorReport
chronicle hook
    reads one Claude Code hook event on stdin; stdout: hook JSON or nothing; always exit 0
```

- agent = `[--tool t] [--model m] [--effort e] [--tokens n]`, sent as `agent` when any is given; `--tokens` must be a non-negative integer.
- `--pr url` (repeatable, `start` and `task`) → `prs: [{ url }]`.
- `--step key=Title` without `=Title` → title omitted. `--step a/b=B` nests `b` in `a`'s `subtasks`, creating `a` (title omitted) when no `--step a` came first. `--link "url|label"` → `{ url, label }`; no `|` → url only. `--tag "round 2|#a855f7"` → `{ text: 'round 2', color: '#a855f7' }`; no `|` → text only. `--color in_work=#14b8a6` → patch `states: [{ key: 'in_work', color: '#14b8a6' }]`. `--position` must be an integer (`--position=-1` for a negative one).
- `chronicle image <taskId> <file> [--path p] [--caption c] [--review]` → `addImage`; stdout `<imageId>`.
- `chronicle notice <taskId> <assumption|caveat> <text> [--path p]` → `addNotice`; any other kind is a usage error.
- A `Result` with `ok: false` → stderr `chronicle: <warning>` and exit 0.
- `hook` (`src/hook.ts`) never touches the server. It keeps per-session state in `<configDir>/sessions/<session_id>.json` and answers `SessionStart` (`compact`, `resume`), `UserPromptSubmit`, `PreToolUse` on `Agent` and `PostToolUse` as `docs/usage.md` § Hooks describes. Unparseable input, a missing `session_id` or any failure → no output.
- Unknown command, missing positional, or bad flag → usage text on stderr, exit 2.

## `chronicle-mcp` (`packages/mcp`)

`src/server.ts` exports `createServer(client?: ChronicleClient, watch?: WatchOptions, open?: Opener): McpServer` (from `@modelcontextprotocol/sdk`), server name `chronicle`. `src/index.ts` connects it over stdio. Tools, with zod input schemas mirroring the client inputs:

| Tool          | Input                                                                 | Client call  |
| ------------- | --------------------------------------------------------------------- | ------------ |
| `start_task`  | `{ title, summary?, state?, note?, steps?: StepInput[], agent?, links?, repo?, branch?, project?, cwd? }` | `startTask`  |
| `update_step` | `{ taskId, path, title?, state?, note?, tags?: Tag[], agent?, links?, position? }`   | `updateStep` |
| `update_task` | `{ taskId, title?, summary?, state?, note?, agent?, links?, prs? }`                  | `updateTask` |
| `update_project` | `{ taskId?, cwd?, name?, notes?, links? }`                                        | `updateProject` |
| `add_notice`  | `{ taskId, kind: 'assumption' \| 'caveat', text, path? }`              | `addNotice`  |
| `add_image`   | `{ taskId, file, path?, caption?, review? }`                          | `addImage`   |
| `get_task`    | `{ taskId }`                                                          | `getTask`    |
| `configure`   | `{ taskId?, cwd?, config?: ProjectConfig, patch?: ConfigPatch }`      | `configure`  |

- `ok: true` → one text content item, `JSON.stringify(value)`.
- `ok: false` → one text content item, `chronicle: <warning>`. Never `isError`.
- **PR watcher** — `createServer(client, { intervalMs, soonMs })`: `syncPrs()` once `soonMs` (default 5 s) after start, then every `intervalMs` (default `CHRONICLE_PR_SYNC_MS` or 180 000; `0` disables), and `syncPrs({ taskIds: [id] })` `soonMs` after a `start_task` or `update_task` that sent `prs`. One sync at a time; timers are unref'd and stopped on close; every failure is swallowed.
- `start_task` without `agent.tool` fills it from the MCP client's reported name: one containing `claude` → `claude-code`, `codex` → `codex`, anything else → left unset.
- **Opener** — `createServer(client, watch, open)`: after a `start_task` that returns `ok`, call `open(url)` once. The default spawns `open` (macOS), `cmd /c start` (Windows) or `xdg-open`, detached with output discarded, and does nothing when `CHRONICLE_OPEN=0`; every failure is swallowed.
- Each tool has a one-sentence description an agent can act on; `start_task`'s says to call it before any research or other work, that the server opens the `url`, and to print the `url` to the user.
