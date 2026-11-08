# chronicle API contract

Every package builds against this file. When behaviour and this file disagree, this file wins until it is changed.

## Domain

- **Project** — a dashboard page. `id` is a UUID v4 and doubles as the public view URL (`/p/<id>`). A secret **write key** is returned once at creation; the server stores only its sha256 hex.
- **Task** — one multi-step job on a project. Server-generated UUID v4. Has its own explicit state, set by agents.
- **Node** — a step or subtask in a task's tree, addressed by a **path** of agent-chosen keys joined by `/` (`chunk-2`, `chunk-2/tests`). Depth 1 = step.
- **State** — a key from the project config. Each state has a **kind**.
- **Notice** — an assumption or caveat an agent flags on a task or one of its nodes. Append-only; review marks live in the viewer's browser, never on the server.
- **Image** — a JPEG an agent attaches to a task or one of its nodes. The record is stored; the bytes live only in server memory and expire (see § Images).

## Types

```ts
type StateKind = 'pending' | 'active' | 'review' | 'blocked' | 'failed' | 'done'; // review: waiting on people, never stale
type Animation = 'none' | 'pulse' | 'shimmer' | 'blink' | 'spin';
type Theme = 'system' | 'light' | 'dark';

interface StateDef {
	key: string; // /^[a-z0-9_-]{1,32}$/, unique within a config
	label: string; // non-empty
	color: string; // /^[#a-zA-Z0-9(),.%\s-]{1,64}$/
	kind: StateKind;
	icon?: string; // up to 4 characters, rendered as text
	animation?: Animation; // default 'none'
}

interface ProjectConfig {
	theme: Theme;
	initialState: string; // must be a key in states
	states: StateDef[]; // non-empty, ordered as the legend shows them
}

// PATCH body: fields present replace; states merge by key.
interface ConfigPatch {
	theme?: Theme;
	initialState?: string;
	states?: (Partial<StateDef> & { key: string })[]; // existing key → fields merged; new key → must be a full StateDef, appended
}

interface Tag {
	text: string; // non-empty
	color?: string; // same pattern as StateDef.color
}

// Who did the work. Fields merge on write: a later write can add tokens alone.
interface AgentInfo {
	tool?: string; // ≤ 64 chars: 'claude-code', 'codex'
	model?: string; // ≤ 64 chars
	effort?: string; // ≤ 64 chars: 'high', 'xhigh'
	tokens?: number; // non-negative integer, usually sent when the work finishes
}

interface Link {
	url: string; // http(s), ≤ 2048 chars
	label?: string; // ≤ 100 chars
}

interface PullRequest {
	url: string; // http(s), ≤ 2048 chars; GitHub `/pull/N` or GitLab `/-/merge_requests/N`
	number?: number; // positive integer
	title?: string; // ≤ 300 chars
	state?: 'draft' | 'open' | 'merged' | 'closed';
	checks?: 'pending' | 'passing' | 'failing';
	review?: 'pending' | 'approved' | 'changes_requested';
}

interface Project {
	id: string;
	name: string; // a three-word moniker when none was given
	notes: string; // '' when unset
	links: Link[]; // ≤ 20
	config: ProjectConfig;
	createdAt: string; // ISO 8601 UTC
	lastWriteAt: string;
}

interface Task {
	id: string;
	projectId: string;
	title: string;
	summary: string; // '' when unset
	state: string;
	note: string; // '' when unset
	agent: AgentInfo | null; // the lead agent
	links: Link[]; // ≤ 20
	prs: PullRequest[]; // ≤ 10; replaced whole on write
	repo: string | null; // 'owner/name', ≤ 255 chars
	branch: string | null; // ≤ 255 chars
	createdAt: string;
	updatedAt: string;
	stateSince: string; // last time `state` changed
	finishedAt: string | null; // set while state's kind is done or failed
}

interface Node {
	taskId: string;
	path: string; // segments /^[A-Za-z0-9._-]{1,64}$/, total ≤ 512 chars
	parentPath: string | null; // null at depth 1
	key: string; // last path segment
	depth: number; // 1 for a step
	title: string;
	state: string;
	note: string;
	tags: Tag[];
	agent: AgentInfo | null; // the agent working this node
	links: Link[];
	position: number;
	createdAt: string;
	updatedAt: string;
	stateSince: string;
}

interface Notice {
	id: string; // UUID v4
	taskId: string;
	path: string | null; // the node it belongs to; null for the task as a whole
	kind: 'assumption' | 'caveat';
	text: string; // non-empty, ≤ 2000 chars
	createdAt: string;
}

interface Image {
	id: string; // UUID v4
	taskId: string;
	path: string | null; // the node it belongs to; null for the task as a whole
	caption: string; // ≤ 300 chars, '' when unset
	review: boolean; // true when a 512 px `full` was uploaded: the user is meant to look at it
	width: number; // pixels of the largest stored size
	height: number;
	createdAt: string;
}

interface Snapshot {
	project: Project;
	tasks: Task[]; // ordered by createdAt desc
	nodes: Node[]; // all nodes of those tasks, ordered by taskId, depth, position
	notices: Notice[]; // all notices of those tasks, ordered by createdAt, id
	images: Image[]; // all image records of those tasks, expired or not, ordered by createdAt, id
	lastSeq: number; // highest event seq for this project, 0 if none
}

interface ChronicleEvent {
	seq: number;
	type: 'config' | 'project' | 'task' | 'node' | 'notice' | 'image';
	taskId: string | null;
	path: string | null;
	payload: { config: ProjectConfig } | Project | Task | Node | Notice | Image; // full row snapshot after the write
	at: string;
}
```

Write semantics shared by tasks and nodes:

- `state` omitted on create → `config.initialState`. Unknown `state` → 400 `{ error, validStates: string[] }`.
- When `state` changes and `note` is omitted, `note` resets to `''`. `note` given (including `''`) always wins.
- `stateSince` moves only when `state` changes. `finishedAt` is set when the new state's kind is `done` or `failed`, cleared otherwise.
- Every write bumps the project's `lastWriteAt`, appends one event per changed row, and publishes it.

Node upsert semantics:

- Create when absent; update when present. `title` defaults to `key` on create.
- Missing ancestors are created first (title = key, state = initialState), each with its own event.
- A write that leaves a node in an `active`-kind state moves its task to the first `active` state when the task is in a `pending`-kind state (one extra task event).
- `position` given → set; omitted on create → `1 + max(position)` among siblings (0 when first); omitted on update → unchanged.
- `tags` and `links` given → replace the array; omitted → unchanged.
- `agent` given → its fields merge into the stored object; omitted → unchanged. Tasks follow the same rule.
- A write that changes nothing emits no event.

## HTTP

JSON in and out. Errors are `{ error: string }` (plus `validStates` for unknown states).
Writes (🔑) need `Authorization: Bearer <writeKey>` of the project that owns the target.

| Method | Path                                | Body                                             | Success                                               |
| ------ | ----------------------------------- | ------------------------------------------------ | ----------------------------------------------------- |
| GET    | `/api/health`                       | —                                                | 200 `{ service: 'chronicle', version, db: 'ok' }`; 503 `{ service, version, db: 'unavailable' }` |
| GET    | `/api/presets`                      | —                                                | 200 `{ presets: { name, config }[] }`                 |
| POST   | `/api/projects`                     | `{ name?, notes?, links?, preset?, config? }`    | 201 `{ id, name, writeKey, url, config }`             |
| GET    | `/api/projects/:id`                 | —                                                | 200 `Snapshot`                                        |
| PATCH 🔑 | `/api/projects/:id`                | `{ name?, notes?, links? }`                      | 200 `{ project }`                                     |
| PUT 🔑  | `/api/projects/:id/config`          | `ProjectConfig`                                  | 200 `{ config }`                                      |
| PATCH 🔑 | `/api/projects/:id/config`         | `ConfigPatch`                                    | 200 `{ config }`                                      |
| POST 🔑 | `/api/projects/:id/tasks`           | `{ title, summary?, state?, note?, agent?, links?, prs?, repo?, branch?, steps? }` | 201 `{ taskId, url, task, nodes }` |
| GET    | `/api/tasks/:taskId`                | —                                                | 200 `{ task, nodes, notices, images }`                |
| GET    | `/api/tasks/:taskId/events`         | query `path?`                                    | 200 `{ events: ChronicleEvent[] }` (seq asc; `path` filters to that node; `notice` and `image` events are left out) |
| PATCH 🔑 | `/api/tasks/:taskId`               | `{ title?, summary?, state?, note?, agent?, links?, prs?, repo?, branch? }` | 200 `{ task }`  |
| PUT 🔑  | `/api/tasks/:taskId/nodes/<path…>`  | `{ title?, state?, note?, tags?, agent?, links?, position? }` | 200 `{ node }`               |
| POST 🔑 | `/api/tasks/:taskId/notices`        | `{ kind, text, path? }`                          | 201 `{ notice }`                                      |
| POST 🔑 | `/api/tasks/:taskId/images`         | `{ thumb, full?, caption?, path? }`              | 201 `{ image }`                                       |
| GET    | `/api/images/:imageId/thumb.jpg`    | —                                                | 200 `image/jpeg`; 404 once expired                    |
| GET    | `/api/images/:imageId/full.jpg`     | —                                                | 200 `image/jpeg`; 404 once expired or when not `review` |
| GET    | `/api/projects/:id/stream`          | header `Last-Event-ID` or query `since`          | 200 `text/event-stream`                               |

- `POST /api/projects`: `name` defaults to a random three-word moniker (`Quiet Teal Otter`), returned in the body; `preset` defaults to `'build-it'`; `config`, when given, is used instead of the preset. Unknown preset or invalid config → 400. `url` = `<origin>/p/<id>`.
- `steps` on task create: `{ key, title?, state?, note?, tags?, agent?, links?, subtasks? }[]`, created as depth-1 nodes in array order; `subtasks` has the same shape and nests to any depth, each level in array order. Keys must be unique among siblings. `url` = `<origin>/p/<projectId>/t/<taskId>`.
- `PATCH /api/projects/:id` emits a `project` event carrying the whole `Project`.
- Every `POST`, `PUT` and `PATCH` under `/api` draws from a token bucket per client address: `CHRONICLE_WRITES_PER_WINDOW` (default 120) at once, refilled at that many per `CHRONICLE_WRITE_WINDOW_MS` (default 300 000); `0` disables it. An empty bucket → 429 `{ error: 'too many writes from this address; retry later' }` with `Retry-After: <whole seconds>`, before the body or key is checked.
- 401 `{ error: 'missing write key' }` with no bearer token; 403 `{ error: 'invalid write key' }` on mismatch; 404 `{ error: 'project not found' | 'task not found' }`; 400 for malformed ids, paths, or bodies.

## Admin

Not part of the Project API: no Write key. All of it answers 404 when `ADMIN_TOKEN`
is unset. Sign in at `/admin`, or send `Authorization: Bearer <ADMIN_TOKEN>`; a cookie session
must send `x-csrf-token` on anything but `GET`. Five failed sign-ins per address lock it out for 15
minutes (429 with `Retry-After`). Endpoints and the Bundle format are in
[`usage.md`](usage.md#admin-portal-and-migrating-hosts).

## Images

- Upload: `thumb` is base64 of a baseline or progressive JPEG at most 256×256 px and 64 KiB; `full`, when given, at most 512×512 px and 192 KiB. Anything else → 400 naming the field. The server never decodes pixels; it reads the size from the JPEG frame header. `review` = `full` was given; `width`/`height` come from `full` when given, else `thumb`. `path` is checked like a Notice's and need not exist.
- The upload writes the record and an `image` event like any other write (`lastWriteAt`, rate limit).
- Cache: the bytes of every live image share one in-memory budget, `CHRONICLE_IMAGE_CACHE_BYTES` (default 83 886 080, 80 MiB). An upload that overflows it evicts the oldest images first. A restart drops every image.
- Expiry, per task: a task in a `done`- or `failed`-kind state expires its images `CHRONICLE_IMAGE_FINISHED_MS` (default 600 000) after `finishedAt`; any other task, `CHRONICLE_IMAGE_IDLE_MS` (default 1 800 000) after its last event of any type. A task that leaves a final state falls back to the idle rule.
- An expired or evicted image answers 404 `{ error: 'image expired' }`; its record stays.
- Bytes are served with `content-type: image/jpeg` and `cache-control: private, max-age=604800, immutable`, so a viewer that loaded an image keeps it after the server drops it.

## Stream

`GET /api/projects/:id/stream` (404 JSON for an unknown project). Headers: `content-type: text/event-stream`, `cache-control: no-cache`, `x-accel-buffering: no`.

- Replay: with `Last-Event-ID: N` or `?since=N`, first send every project event with `seq > N` in order, then live events. Without either, live only.
- Event frame: `id: <seq>\nevent: <type>\ndata: <JSON payload>\n\n` — `payload` as in `ChronicleEvent`.
- Opening: `: ok\n\n` as soon as the stream opens, before any replay.
- Heartbeat: `: ping\n\n` every `CHRONICLE_HEARTBEAT_MS` (default 25 000).
- Idle: deadline = max(project `lastWriteAt`, stream open time) + `CHRONICLE_IDLE_MS` (default 14 400 000); each published write resets it. At the deadline send `event: idle\ndata: {}\n\n` and close the stream.
- Reset: when an admin import or Project deletion replaces the data, send `event: reset\ndata: {}\n\n` and close; the page reloads. While an import runs, other `/api` requests answer 503 with `Retry-After`.

## Presets

`build-it` (default): `theme: 'system'`, `initialState: 'queued'`.

| key         | label       | color     | kind    | icon | animation |
| ----------- | ----------- | --------- | ------- | ---- | --------- |
| queued      | Not started | `#9ca3af` | pending | ○    | none      |
| planning    | Planning    | `#f97316` | active  | ◔    | shimmer   |
| in_work     | In work     | `#eab308` | active  | ◑    | pulse     |
| testing     | Testing     | `#a855f7` | active  | ◕    | pulse     |
| review      | In review   | `#7dd3fc` | review  | ◎    | none      |
| needs_input | Needs input | `#ef4444` | blocked | !    | blink     |
| failed      | Failed      | `#ef4444` | failed  | ✕    | none      |
| done        | Completed   | `#22c55e` | done    | ✓    | none      |

## Client files

Under `$XDG_CONFIG_HOME/chronicle` (default `~/.config/chronicle`), written atomically with mode 0600:

- `projects.json` — `{ [server]: { [repoKey]: { projectId, writeKey, name, projectUrl? } } }`. `projectUrl` is the `url` the server returned at creation. `repoKey` = absolute `git rev-parse --path-format=absolute --git-common-dir` of the cwd, or the cwd's realpath outside git. `name` = the project name the server returned or a later rename set.
- `tasks.json` — `{ [taskId]: { server, projectId, projectUrl? } }`. `projectUrl` is the task `url` minus `/t/<taskId>`.

Discovery: `CHRONICLE_URL` set → only that server, never another. Otherwise probe `http://localhost:3280` then `https://chronicle.nanzero.com` with `GET /api/health` (300 ms timeout for a loopback host, 2 s for any other; needs 2xx and `service === 'chronicle'`), at every task start. Updates go to the server in the task's handle.

`startTask` sends `repo` (`owner/name` from the `origin` remote) and `branch` (`git symbolic-ref --short HEAD`) of the cwd unless given, and `agent.tool = 'claude-code'` when `CLAUDECODE=1` and no tool was given. It sends `name` on project creation only when the caller passed `project`; a later `project` that differs from the registry entry renames the project once.

## Server log

One logfmt line per event on stdout: `<ISO time> <event> key=value…`. Events: `image.evict` (`project task image reason=finished|idle|budget`), `stream.open` (`project ip since`), `stream.close` (`project ip reason=client|idle|error seconds`), `ratelimit` (`ip method path retry_after`), `api.fail` (`ip method path status error`), `error` (unhandled, with stack), `project.create` (`id name ip`), `task.finish` (`project task state seconds tool model tokens`). Write keys and bodies are never logged.
