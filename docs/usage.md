# chronicle usage

Reference for running, driving and extending chronicle. The [README](../README.md) covers what it
is and the quick start.

## Install

### Prerequisites

- Node.js 22 or newer
- pnpm 11, via corepack: `corepack enable` (ships with Node)
- Docker with the compose plugin, to run the local tracker (optional if you point at another
  server)
- Claude Code and/or Codex on `PATH`, if you want the MCP server registered for them

### Steps

```sh
git clone https://github.com/nvanderploeg/chronicle
cd chronicle
scripts/install.sh --with-server
```

The script installs dependencies (`pnpm install --frozen-lockfile`), builds the client, CLI and MCP
packages, links the skills and CLI, registers the MCP server, and with `--with-server` starts the
local tracker on <http://localhost:3280> and waits for it to be healthy. It is safe to re-run.

| Flag            | Effect                                                                                                                  |
| --------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `--with-server` | Run `docker compose up -d` (PostgreSQL and the app) and wait for `http://localhost:3280/api/health`.                         |
| `--replace`     | Move conflicting paths aside to `<name>.bak-<timestamp>` and re-register the MCP server, instead of skipping them.      |
| `--allow-tools` | Add `mcp__chronicle__*` to `permissions.allow` in `~/.claude/settings.json`, so Claude Code stops asking for each tool. |
| `--hooks`       | Add Claude Code hooks to `~/.claude/settings.json` that keep a session's chronicle task current once chronicle is in use (see below). |
| `--skip-mcp`    | Do not register the MCP server with Claude Code or Codex (skills and CLI are still linked).                             |
| `--dry-run`     | Print what would happen and change nothing.                                                                             |

Without `--replace`, anything already at a destination that is not ours is left alone and reported
as `skip`.

### What it changes

| Where                                        | What                                                                              |
| -------------------------------------------- | --------------------------------------------------------------------------------- |
| `~/.agents/skills/chronicle`                 | Symlink to this checkout's `skills/chronicle`.                                    |
| `~/.claude/skills/chronicle`                 | Symlink to the `~/.agents/skills` entry.                                          |
| `~/.local/bin/chronicle`                     | Symlink to the built CLI. Add `~/.local/bin` to `PATH` if the installer warns.    |
| Claude Code user config                      | `claude mcp add -s user chronicle -- node <checkout>/packages/mcp/dist/index.js`. |
| `~/.codex/config.toml`                       | A `[mcp_servers.chronicle]` block (only if `codex` is on `PATH`).                 |
| `~/.config/chronicle/install.json`           | A manifest of the above, so uninstall removes exactly what install added.         |
| `~/.claude/settings.json`                    | Only with `--allow-tools` or `--hooks`; the original is backed up first.          |

### Hooks

With `--hooks`, Claude Code runs `chronicle hook` on four events. A session that never loads chronicle hears nothing from them. Once it does, they keep the task in front of the agent; they never block work, except to return a subagent launch once (below).

| Situation | What the agent is told |
| --- | --- |
| Loaded the skill or the tools, no `start_task` yet | Start the task and print its link, before more work. On the first three tool calls, then every fifth, and on each prompt. |
| Task open, a user prompt arrives | The task id and link; keep it current, finish with `update_task`. |
| Task open, 12 tool calls with no chronicle write | No update in 12 calls; update the step or finish the task. |
| Task open, context compacted or session resumed | The task id and link; call `get_task` before writing. |
| Task open, a subagent brief without the task id | The launch is returned once with the line to add; the same brief sent again goes through. |

A task set to `done`, `failed`, `needs_input` or `review` silences them until it is reopened; so does a `start_task` that warns the server is unreachable. State lives in `~/.config/chronicle/sessions/<session id>.json` and is pruned after two weeks.

The checkout is referenced in place, not copied. Do not move it after installing; re-run the
installer if you do.

### Verify

```sh
chronicle doctor      # config dir, pin, server probes, repo registration
claude mcp list       # should list chronicle and report it connected
curl http://localhost:3280/api/health
```

`chronicle doctor` prints which server discovery picks (`server: http://localhost:3280`). Before
the first task in a repo, `registered: no` is normal.

### Uninstall

```sh
scripts/uninstall.sh --dry-run   # preview
scripts/uninstall.sh             # remove links, MCP registrations and the allowlist entry
scripts/uninstall.sh --purge     # also delete projects.json and tasks.json (write keys!)
```

Uninstall touches only what `install.json` recorded for this checkout. Backups (`*.bak-*`) are
listed, never restored or deleted. It does not stop the tracker; use `docker compose down`.

## Tracking work

### Agents track work on their own

The `chronicle` skill tells an agent to open a task when it starts work with three or more steps
that will run more than a few minutes or uses subagents. It does not fire for one-step answers or
quick edits. The agent then:

1. calls `start_task` with a title, one-line summary and planned steps, and shows you the returned
   dashboard link once;
2. calls `update_step` at each transition (state, short note, tags);
3. finishes the task with `update_task` set to `done`, `failed` or `needs_input`.

The first task in a repo creates a project named after the repo and remembers its write key; later
tasks in the same repo reuse it. Subagents get the `taskId` in their brief and write under their
own node path, so parallel workers show up as parallel rows.

![Drilling into a task and opening per-node history](captures/timeline.gif)

### MCP tools

| Tool             | Input                                                                                                        | Does                                                           |
| ---------------- | ------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------- |
| `start_task`     | `title`, `summary?`, `state?`, `note?`, `steps?`, `agent?`, `links?`, `project?`, `repo?`, `branch?`, `cwd?` | Open a task on this repo's project; returns `taskId`, `url`.   |
| `update_step`    | `taskId`, `path`, `title?`, `state?`, `note?`, `tags?`, `agent?`, `links?`, `position?`                      | Upsert a step or subtask by path (`chunk-2`, `chunk-2/tests`). |
| `update_task`    | `taskId`, `title?`, `summary?`, `state?`, `note?`, `agent?`, `links?`                                        | Change the task itself.                                        |
| `update_project` | `taskId?`, `cwd?`, `name?`, `notes?`, `links?`                                                               | Rename the project, set its notes and project-wide links.      |
| `add_notice`     | `taskId`, `kind` (`assumption`\|`caveat`), `text`, `path?`                                                   | Flag an assumption or caveat; shows as an alert on the task and in the Notices tab. |
| `add_image`      | `taskId`, `file`, `path?`, `caption?`, `review?`                                                             | Attach a screenshot as a thumbnail; `review` adds a 512 px view for the user. Expires after the task finishes or idles. |
| `get_task`       | `taskId`                                                                                                     | Read a task, its nodes and notices back (use after context compaction). |
| `configure`      | `taskId?`, `cwd?`, `config?`, `patch?`                                                                       | Read, replace or patch the project's states, colors, theme.    |

A failure comes back as a text answer starting with `chronicle:` (unreachable, unknown task,
unknown state with the list of valid ones); the agent carries on. Details: [`client.md`](client.md).

While connected, the MCP server checks open PRs every 3 minutes through `gh` or `glab` and writes
only what changed. Set `CHRONICLE_PR_SYNC_MS` in its environment to change the interval, or `0` to
turn it off.

### CLI

```sh
id=$(chronicle start "Add rate limiting" --summary "Token bucket per API key" --project "Demo API" \
      --step chunk-1="Token bucket core" --step chunk-1/tests="Tests" --step chunk-2="Apply limits" \
      --tool claude-code --model claude-opus-5-5 --effort high \
      --link "https://github.com/me/repo/issues/41" | cut -d' ' -f1)

chronicle step "$id" chunk-1 in_work --note "implementing" --tag "round 1" --model claude-sonnet-5-5
chronicle step "$id" chunk-1/tests testing
chronicle notice "$id" assumption "Dates are UTC" --path chunk-1
chronicle image "$id" ./shots/login.png --path chunk-1 --caption "New login form" --review
chronicle step "$id" chunk-1 done --note "a1b2c3d Add token bucket" --tokens 48200
chronicle task "$id" needs_input --note "Limit per key or per IP?"
chronicle task "$id" review --pr "https://github.com/me/repo/pull/42" --tokens 88000
chronicle sync             # refresh PR status; the MCP server does this every 3 minutes
chronicle project --notes "Hardening the API before v2" --link "https://trello.com/b/abc|board"

chronicle get "$id"        # JSON of the task and its nodes
chronicle url "$id"        # the task page; without an id, the project page
chronicle doctor
```

`start` prints `<taskId> <url>`. A state change clears the note unless you pass `--note`.

### With an orchestrator

When the `chronicle` skill or MCP tools are available, an orchestrating skill can mirror its run onto the
dashboard: chunks become steps with `deps:` tags, prework and workers move
them through planning and in work, a parallel test agent becomes `chunk-N/tests`, a repair round
adds `round 2` and `opus` tags, a one-way-door Stop sets the step and task to `needs_input` with the
question as the note, and the commit sets `done` with `<short sha> <subject>`. The dashboards above
are `scripts/simulate.mjs` replaying exactly that mapping.

### Open and share the dashboard

`start_task` returns the task URL (`<server>/p/<projectId>/t/<taskId>`); `chronicle url` prints the
project or task URL any time. Anyone with a dashboard link can watch; nobody can change anything
from the browser. The write key is returned once at project creation and stored in
`~/.config/chronicle/projects.json` (mode 0600). Share the link, never the key, and never commit
the registry files.

![A project page that has gone idle](captures/idle.gif)

A page with no writes for the idle window (four hours by default) stops following and offers to
reload.

## Configure

States, colors and the theme live in the project config and change live on open pages.

```sh
chronicle config                                  # read the current config
chronicle config --theme dark                     # system | light | dark
chronicle config --color in_work=#14b8a6          # recolor one state (patch)
chronicle config --initial planning               # state new nodes start in
chronicle config --file my-config.json            # replace the whole config
chronicle config --task <taskId> --color failed=#b91c1c   # target a task's project
```

The `configure` MCP tool takes the same thing as `patch`, which merges states by key; a new state
key needs a full definition (`key`, `label`, `color`, `kind`):

```
configure { patch: { states: [{ key: 'in_work', color: '#14b8a6' }] } }
```

### The default preset

New projects use `build-it` unless `POST /api/projects` names another preset or a `config`. It
starts nodes in `queued` with the `system` theme.

| Key           | Label       | Color     | Kind      | Icon | Animation |
| ------------- | ----------- | --------- | --------- | ---- | --------- |
| `queued`      | Not started | `#9ca3af` | `pending` | ○    | none      |
| `planning`    | Planning    | `#f97316` | `active`  | ◔    | shimmer   |
| `in_work`     | In work     | `#eab308` | `active`  | ◑    | pulse     |
| `testing`     | Testing     | `#a855f7` | `active`  | ◕    | pulse     |
| `needs_input` | Needs input | `#ef4444` | `blocked` | !    | blink     |
| `failed`      | Failed      | `#ef4444` | `failed`  | ✕    | none      |
| `done`        | Completed   | `#22c55e` | `done`    | ✓    | none      |

Task state is set explicitly and does not follow its steps. Entering a `done`-kind state flashes the
card and collapses it into a badge; a `failed`-kind state becomes a red badge.

### Which server

At each task start the client picks a server in this order and uses the first healthy one (a
`GET /api/health` answering with `service: "chronicle"` within 300 ms for a loopback address, 2 s
for any other):

1. `CHRONICLE_URL`, when set. This is a pin: only that server is tried, never another.
2. `http://localhost:3280`, the local tracker.
3. `https://chronicle.nanzero.com`, the hosted one.

If none answers, the agent continues untracked. Later writes for a task go to the server in that
task's handle (`~/.config/chronicle/tasks.json`) without probing again.

```sh
export CHRONICLE_URL=http://localhost:5180   # always use this server
```

## Run the server

**Compose (local tracker).** `docker compose up -d` (or `scripts/install.sh --with-server`) starts
PostgreSQL 17 and the app on <http://localhost:3280>; the app applies its migrations at boot.
`pnpm db:start` starts only the database, on `127.0.0.1:5436`.

**Dev mode.** With the database up:

```sh
pnpm install
pnpm db:start
pnpm --filter web dev --port 5180      # defaults DATABASE_URL to chronicle_dev on :5436
```

**Built app.** The migrations folder is resolved from the working directory, so run it from
`apps/web`:

```sh
pnpm --filter web build
cd apps/web
DATABASE_URL=postgres://chronicle:chronicle@127.0.0.1:5436/chronicle_dev \
ORIGIN=http://localhost:3000 PORT=3000 node build
```

| Variable                      | Meaning                                                                                                                                                                             |
| ----------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `DATABASE_URL`                | PostgreSQL connection string (`postgres://user:password@host:5432/database`). Required outside dev and test mode.                                                                                                                        |
| `ORIGIN`                      | Public origin the app is served at. The node adapter builds request URLs from it, so the `url` fields the API returns start with it.                                                |
| `PORT`                        | Port the built app listens on (default 3000).                                                                                                                                       |
| `CHRONICLE_IDLE_MS`           | Quiet time after the last write before a stream sends `idle` and closes. Default 14 400 000 (4 h).                                                                                  |
| `CHRONICLE_HEARTBEAT_MS`      | Interval between `: ping` keep-alives on a stream. Default 25 000.                                                                                                                  |
| `CHRONICLE_WRITES_PER_WINDOW` | Writes (`POST`/`PUT`/`PATCH` under `/api`) one client address may burst, refilled at this many per window; the rest get 429 with `Retry-After`. Default 120; 0 turns the limit off. |
| `CHRONICLE_WRITE_WINDOW_MS`   | The refill window. Default 300 000 (5 min).                                                                                                                                         |
| `ADMIN_TOKEN` | Turns on the admin portal. 16 to 256 characters, no spaces. Unset: `/admin` and `/api/admin/*` answer 404. See [Admin portal](#admin-portal-and-migrating-hosts). |
| `ADMIN_BACKUP_DIR` | Where the automatic pre-import Bundle goes; the newest five are kept. Default: the system temp directory. The image sets `/backups`, a volume in the compose files. |
| `ADMIN_MAX_BUNDLE_MB` | Largest Bundle an import accepts, in MiB of zip. Default 256; must be a positive number or the server will not start. The node adapter also caps request bodies at `BODY_SIZE_LIMIT` (image default `256M`; a bare `node build`: 512K), and nginx at `client_max_body_size`; the compose files derive `BODY_SIZE_LIMIT` from this variable, and nginx must be raised by hand. |
| `ADMIN_MAX_UNPACKED_MB` | Largest total unpacked size of a Bundle. Default 2048. |
| `ADDRESS_HEADER`              | Header the client address is read from behind a proxy (`x-real-ip` with the bundled nginx). Unset: the socket address.                                                              |

**External PostgreSQL.** Over a network you do not trust, use TLS and full verification:
`DATABASE_URL=postgres://user:pw@host:5432/chronicle?sslmode=verify-full`. The `pg` driver treats
`sslmode=require`, `prefer` and `verify-ca` as `verify-full` (certificate chain and hostname) and
warns; `sslmode=no-verify` turns verification off. Add `uselibpqcompat=true` for libpq semantics
instead (`require` then encrypts without verifying). A private CA goes in `sslrootcert=/path/ca.pem`.
The password must be URL-safe (hex, `openssl rand -hex 24`) because it is spliced into the URL.

**One replica.** Run exactly one app instance. The Bundle import freeze, `ADMIN_BACKUP_DIR` and the
SSE stream bus live in the process, so a second replica would miss events and could write during an
import. Migrations at boot are safe to race (advisory lock), but that is for rolling restarts only.

The local `compose.yaml` passes only `DATABASE_URL`, `ORIGIN` and `ADMIN_TOKEN` to the app; set the other
`CHRONICLE_*` variables when running the built app directly or through `deploy/compose.prod.yml`.
Compose reads `CHRONICLE_PORT` (host port, default 3280), `CHRONICLE_ORIGIN`, `POSTGRES_PASSWORD`
and `POSTGRES_PORT` from the environment.

## Simulate and captures

`scripts/simulate.mjs` is a zero-dependency Node script that plays a realistic build-it run through
the HTTP API: a four-chunk task with parallel chunks, a repair round, a one-way-door question, a PR
at the end, then a second task that fails and a third that finishes. It is how the captures above
were made.

```sh
node scripts/simulate.mjs                                   # new project on http://localhost:3280
node scripts/simulate.mjs --server http://localhost:5180 --speed 4
node scripts/simulate.mjs --project <id> --key <writeKey>   # replay into an existing project
node scripts/simulate.mjs --quiet                           # print only the dashboard URL
```

It prints the dashboard URL first, so open it before the run gets going. `--speed n` divides every
delay (one full run takes about 35 seconds at speed 1) and a non-2xx answer ends it with exit code 1.
`simulate({ server, speed, projectId, writeKey, log, onProject })` is also exported.

The Playwright suite in `e2e/` opens the live dashboard while the simulator runs and asserts that the
page reacts: cards appearing, state classes changing, tags, the needs-input block, the flash, the
badges, the frame flash, the timeline and the idle overlay. It starts its own dev server on port
5191 against the dev database, so the database must be up (`pnpm db:start`).

```sh
pnpm exec playwright install chromium   # once
pnpm e2e                                # run the suite (records video)
pnpm captures                           # run it, then rebuild docs/captures/*.gif and dashboard.png
```

`pnpm captures` needs `ffmpeg` on `PATH` and converts each test's video with a two-pass palette
(12 fps, 960 px wide; it lowers both if a GIF would exceed 6 MB).

## API

JSON in and out. Anyone can read; writes need `Authorization: Bearer <writeKey>` of the owning
project.

| Method    | Path                               | Notes                                              |
| --------- | ---------------------------------- | -------------------------------------------------- |
| GET       | `/api/health`                      | Service and database status.                       |
| GET       | `/api/presets`                     | Available state presets.                           |
| POST      | `/api/projects`                    | Create a project; returns `id`, `writeKey`, `url`. |
| GET       | `/api/projects/:id`                | Snapshot: project, tasks, nodes, notices, `lastSeq`. |
| PUT/PATCH | `/api/projects/:id/config`         | Replace or patch the config (key).                 |
| POST      | `/api/projects/:id/tasks`          | Create a task, optionally with steps (key).        |
| GET       | `/api/tasks/:taskId`               | A task, its nodes and notices.                     |
| GET       | `/api/tasks/:taskId/events`        | History, optionally for one node `path`.           |
| PATCH     | `/api/tasks/:taskId`               | Title, summary, state, note (key).                 |
| PUT       | `/api/tasks/:taskId/nodes/<path…>` | Upsert a step or subtask (key).                    |
| POST      | `/api/tasks/:taskId/notices`       | Flag an assumption or caveat (key).                |
| GET       | `/api/projects/:id/stream`         | SSE; resume with `Last-Event-ID` or `?since=`.     |

```sh
curl -s -X POST localhost:3280/api/projects -H 'content-type: application/json' -d '{"name":"demo"}'
# {"id":"…","writeKey":"…","url":"http://localhost:3280/p/…","config":{…}}
```

The full contract, with types, write semantics and the stream format, is in
[`docs/api.md`](api.md); the client, CLI and MCP contract is in
[`docs/client.md`](client.md) and the dashboard helpers are in [`docs/ui.md`](ui.md).

## Admin portal and migrating hosts

Set `ADMIN_TOKEN` (`openssl rand -hex 32`) and open `/admin`. Unset, `/admin` and every
`/api/admin/*` route answer 404, as if they did not exist.

- **Browser.** `/admin` shows a login form. A correct token sets the `chronicle_admin` cookie:
  `HttpOnly`, `SameSite=Strict`, `Secure` under an https `ORIGIN`, signed with a key derived from the
  token, valid eight hours. Changing the token ends every session.
- **curl.** `Authorization: Bearer <token>` on any `/api/admin` request.
- **CSRF.** A state-changing request authenticated by cookie must carry a matching `Origin` and the
  `x-csrf-token` header (the portal gets it from its page load). Bearer requests are exempt.
- **Path matching.** The gate reads the path as written and after each round of percent-decoding,
  lowercased, so `/%61pi/admin/...` is gated like `/api/admin/...`; a malformed escape is a 400.
  Each admin handler also checks for itself: 404 with no token configured, 401 without a verdict.
- **Body size.** `/api` bodies are read through a 4 MiB cap (the login body 1 KiB) however they
  arrive; only the import route streams a large body to disk.
- **Brute force.** Five failed attempts (login or Bearer) from one address lock it out for 15
  minutes (429 with `retry-after`). The token is compared in constant time.

| Method | Path                                           | Does                                                                          |
| ------ | ---------------------------------------------- | ----------------------------------------------------------------------------- |
| POST   | `/api/admin/login`                             | `{token}`; sets the cookie, returns `{ok, csrf}`                              |
| POST   | `/api/admin/logout`                            | clears the cookie                                                             |
| GET    | `/api/admin/stats`                             | version, database name and size, row counts, schema, migrations               |
| GET    | `/api/admin/projects`                          | Projects with Task count, `bytes` (payload held) and `lastActivityAt`         |
| DELETE | `/api/admin/projects/:id`                      | body `{confirm: "<Project name> (<first 8 of id>)"}`; cascades              |
| GET    | `/api/admin/export`                            | streams a Bundle (`application/zip`)                                          |
| POST   | `/api/admin/import?confirm=replace-everything` | body is the zip; replaces everything; add `&allow-empty=1` to accept a Bundle with no Projects                                          |

**Migrating to another host.**

```sh
curl -H "Authorization: Bearer $ADMIN_TOKEN" -o chronicle.zip https://old.example.com/api/admin/export
curl -H "Authorization: Bearer $ADMIN_TOKEN" -H 'content-type: application/zip' --data-binary @chronicle.zip \
  'https://new.example.com/api/admin/import?confirm=replace-everything'
```

Then point clients at the new URL (`CHRONICLE_URL`). Write keys are stored as sha256 only, so keys
agents already hold keep working. In the portal: Download bundle on the old host; on the new one
choose the file, type `replace everything`, press Replace everything.

**The Bundle** is a zip of `db.ndjson` and `manifest.json` (last, because the stream knows each
file's size and hash only after sending it):

```json
{
	"format": 1,
	"service": "chronicle",
	"appVersion": "0.1.0",
	"schema": "0000_baseline",
	"createdAt": "2026-11-06T17:00:00.000Z",
	"files": [{ "path": "db.ndjson", "size": 123, "sha256": "…" }]
}
```

`schema` is the latest drizzle migration tag the exporting build knew. Chronicle runs on PostgreSQL, so
there is no database file to copy: the export opens one `REPEATABLE READ` transaction
and streams every table through it, a single point in time while writes
continue. Each table is a header line `{"table","columns"}` followed by one JSON array per row;
JSON columns travel as the exact text the database holds and timestamps as UTC `YYYY-MM-DD HH:MM:SS.mmm`.
A Bundle exported by the MySQL build (schema `0000_init` to `0006_images`) imports as is.

Carried: Projects (with each Write key's sha256), Tasks, Nodes, Notices and Events (so `seq` and a
stream's replay stay meaningful). **Chronicle Images are not carried**: their bytes live in server
memory and expire, so an imported Task has none and the images table is emptied.

**Import** replaces everything, in this order:

1. Spool the upload to a private temp file, capped at `ADMIN_MAX_BUNDLE_MB`.
2. Validate before touching the database: zip structure, entry names (no `..`, absolute paths,
   backslashes or duplicates; entries are matched against an allowlist and never written to disk by
   name), declared and actual sizes (inflation stops at the declared size), zip CRCs, manifest
   `format` and `service`, the schema level, and the size and sha256 of every file.
3. Refuse a Bundle whose `schema` this build does not know (409, "newer than this build"). Older is
   accepted.
4. Freeze `/api` and wait up to 30 s for requests already running to finish (503 `retry` if they do not), so no write can commit between the backup and the swap. Then write the current database to a Bundle in `ADMIN_BACKUP_DIR` (newest five kept; the response names
   the file).
5. Scan `db.ndjson` once more: every table header present exactly once, rows the width of their
   header, and at least one Project unless `allow-empty=1`, so a rehashed empty file cannot wipe the
   server.
6. In one PostgreSQL transaction: delete every row, insert the Bundle's rows, commit. Any failure rolls
   back and the database is as it was; a row the schema refuses (bad reference, oversized value) is a 422 naming PostgreSQL's complaint, and the backup is removed. Steps after the commit (ending streams, dropping cached
   images) cannot fail the import; a failure there is returned as `warnings` in a 200. Timestamps travel as UTC text: every session runs with `timezone=UTC`.

The response is `{schema, appVersion, backup, rows, imagesDropped, warnings}`. **Images:** the
images table is wiped and not part of the backup either, so `imagesDropped` counts the records
lost; every cached image is dropped too (deleting a Project drops its cached images).

An older Bundle loads into the already-migrated tables: columns it lacks take their defaults and
columns this build dropped are ignored; a `NOT NULL` column without a default that the Bundle lacks
fails the import before anything is deleted. A future migration that adds one must teach the loader.

**Open connections.** From the backup until the commit, other `/api` requests answer 503 with
`retry-after` (`/api/health` stays up; so do import, login and logout, while the other admin routes
also answer 503). The connection pool is never replaced, so no handle goes stale. On commit
every open Project stream receives `event: reset` and closes; the dashboard reloads, because its
`seq` may not match the restored event log. Deleting a Project does the same to its streams.

## Deploy

The image is published as `ghcr.io/nvanderploeg/chronicle`. [`deploy/`](../deploy/README.md) holds
example production configuration: a compose stack, an env template, an nginx server block and an
auto-update timer.

## Development

```
apps/web/        SvelteKit app: dashboard pages, HTTP API, SSE stream, PostgreSQL via drizzle
packages/client/ discovery, registry files and HTTP calls (@chronicle/client)
packages/cli/    the chronicle command
packages/mcp/    the chronicle-mcp stdio server
skills/          the chronicle agent skill
scripts/         install, uninstall, simulate, captures
e2e/             Playwright capture suite
docs/            contracts (api.md, client.md, ui.md) and captures/
CONTEXT.md       domain vocabulary
```

```sh
pnpm install
pnpm check      # builds the packages, then type-checks every workspace
pnpm lint       # prettier --check and eslint
pnpm format     # prettier --write
pnpm test       # builds the packages, then runs every workspace's tests
```

`pnpm test` uses the compose database (`pnpm db:start`): the web tests run against
`chronicle_test` on `127.0.0.1:5436`. The contracts in `docs/` win over the code until they are
edited; [`CONTEXT.md`](../CONTEXT.md) holds the vocabulary.
