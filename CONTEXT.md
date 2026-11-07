# chronicle

A live dashboard for agent work: agents report multi-step tasks to a project page, people watch it update. Terms below are binding vocabulary; the contracts are `docs/api.md` (types, HTTP, stream, client files), `docs/client.md` (client, CLI, MCP) and `docs/ui.md` (dashboard helpers). Where this file and a contract disagree, the contract wins.

## Language

**Project**:
A dashboard page. Its UUID is also the public view URL (`/p/<id>`). Holds a Config, Tasks and an event log. Optionally has an Owner.

**Write key**:
The secret returned once when a Project is created; the server keeps only its sha256. Whoever holds it can write; the public URL alone is read-only.

**Owner**:
The Firebase user whose `uid` a Project records. A Project with no Owner is anonymous: always public, written with its Write key as before.

**Public flag**:
On a Project, whether anyone with its URL may read it (an owned Project starts private). On a Task, whether anyone with its URL may read that Task though its Project is private. Never a way to write.

**Session**:
The `chronicle_session` cookie a signed-in browser holds, exchanged from a Firebase ID token and verified on every request. Proves who is reading; grants no writes.

**Task**:
One multi-step job on a Project, with its own explicit State set by agents. Identified by a server-generated UUID.

**Node**:
A Step or Subtask in a Task's tree. Addressed by Path; created on first write, along with any missing ancestors.

**Step**:
A Node at depth 1.

**Subtask**:
A Node at depth 2 or deeper, under a Step or another Subtask.

**Path**:
Agent-chosen keys joined by `/` that address a Node within a Task (`chunk-2`, `chunk-2/tests`).

**State**:
A key from the Project's Config, set on a Task or Node. Its label, color, icon and animation come from the Config; an unknown key renders with a fallback.

**Kind**:
The meaning of a State: `pending`, `active`, `review`, `blocked`, `failed` or `done`. Behaviour (finished, stale, settled) keys off Kind, never off the State key.

**Notice**:
An assumption or caveat an agent flags on a Task, or on one of its Nodes by Path. Append-only. A viewer marks each one approved or flagged in their own browser; the server holds no review state.

**Image**:
A screenshot or other picture an agent attaches to a Task, or to one of its Nodes by Path: a 256 px thumbnail, plus a 512 px view when it is marked for review. The server keeps the bytes in memory only and drops them once the Task has been finished or idle a while; the viewer's browser keeps what it already loaded.

**Admin token**:
The `ADMIN_TOKEN` secret that opens `/admin`, the portal for stats, deleting Projects, and exporting or importing a Bundle. Unset: the portal does not exist (404). Unrelated to a Write key.

**Bundle**:
The zip an export produces and an import consumes: `manifest.json` and `db.ndjson`, a consistent logical dump of every Project (with its Owner and Public flag) and its Tasks, Nodes, Notices and Events. Never holds Images. Importing one replaces all data.

**Tag**:
Short colored text attached to a Node, such as `round 2`.

**Agent info**:
The tool, model, effort and token count of whoever works a Task (the lead agent) or a Node (a subagent). Fields merge on write; a card totals the tokens of its Task and Nodes.

**Link**:
A URL with an optional label on a Project, Task or Node: the ticket, PR, board or doc the work refers to.

**PR**:
A pull or merge request on a Task, with its state, checks and review decision. A Task waits in a `review`-kind State while its PRs are open; `review` never goes Stale.

**PR watcher**:
The MCP server's loop (and `chronicle sync`) that refreshes open PRs through `gh` or `glab` and finishes a Task in review once all its PRs merged.

**Moniker**:
The three-word name (`Quiet Teal Otter`) a Project gets when created without one. Tells projects apart; not unique.

**Notes**:
Free text on a Project saying what its work is for.

**Preset**:
A named starting Config. `build-it` is the default.

**Config**:
A Project's theme, initial State and ordered State definitions. Replaced whole or patched, and the change is itself an Event.

**Event**:
A full-row snapshot after a write (Config, Task or Node), numbered by a per-Project `seq`.

**seq**:
The Project-wide event counter. A client that remembers the last `seq` it saw can resume without gaps.

**Stream**:
`GET /api/projects/:id/stream`, server-sent Events with replay from a `seq`.

**Idle**:
A Stream with no writes for the idle window ends with an `idle` event; the page stops following until reloaded.

**Stale**:
A Task not in a `done` or `failed` Kind whose newest update, across itself and its Nodes, is older than the stale window. A display judgement made in the browser.

**Registry**:
`projects.json` and `tasks.json` in the client config dir: which Project a repo reports to, with its Write key, and which server and Project each Task belongs to.

**Handle**:
A Task's Registry entry (`server`, `projectId`). Later writes go to the Handle's server and never re-run Discovery.

**Discovery**:
How the client picks a server at task start: the pinned `CHRONICLE_URL` if set, else the first healthy probe of the local tracker, then the hosted one.

**Pin**:
Setting `CHRONICLE_URL`. Discovery then uses that server only and never falls back.
