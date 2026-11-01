---
name: chronicle
description: "Track multi-step work live on a chronicle dashboard. Use when starting work with 3 or more distinct steps that will run more than a few minutes or uses subagents; not for single-step answers, quick edits or pure Q&A."
---

# Chronicle

A chronicle dashboard shows a task as steps and nested subtasks, live. The site is view-only; you write through tools. A failed write never blocks, delays or fails the real work. Once a task exists, keeping it current is part of the work: a person is watching it instead of your transcript.

## Pick the channel

1. The MCP tools `start_task`, `update_step`, `update_task`, `update_project`, `add_notice`, `add_image`, `get_task`, `configure`. In Claude Code they are `mcp__chronicle__*` and may be deferred: load them with ToolSearch, query `chronicle`. Codex sees them as tools of server `chronicle`.
2. Otherwise the `chronicle` CLI, if it is on PATH.
3. Neither: skip tracking silently and do the work.

## Track the work

1. **Start first.** Call `start_task` before any research, file reads or other work; research is a step of the plan, not a reason to wait. Pass a title, a one-line summary and every step you already know, with the subtasks you already know nested under `subtasks`. They show as not started, so a viewer sees the whole plan and what is left. Keys are short and stable (`step-1`, or a slug like `parser`); they are the addresses every later write uses. Also pass:
   - `agent`: your `tool` (`claude-code`, `codex`), `model` id and `effort` level.
   - `links`: the ticket or issue the work is for (GitHub, Trello, Linear, Jira) and any spec or doc it follows.
   - `project`: a short human name for this repo's project (`Billing API`). Without one the project gets a random three-word name. Pass it on the first task in a repo, and again only to rename.

   `repo` and `branch` are read from git; pass them only to override. With three or four tasks running, these fields are what tell the cards apart.
2. **Hand over the link.** In your next message to the user, before any of the real work, print the returned `url` as a link. The MCP server opens it in their browser; with the CLI, try once yourself (`xdg-open`, `open` or `start`, in the background, output discarded). Do this once per task, not on later updates.
3. **Write every state change.** `update_step` each time a step or subtask changes state, hits a blocker, or produces something worth naming (a commit, a PR, a failing check), with a short `note`. Do not narrate progress within a state. Writes are rate limited per machine (120 per 5 minutes by default), and every agent on the machine shares that budget. A state change clears the note unless you pass one. Subtasks are nodes below a step: `path: "step-1/tests"` creates it, and any missing ancestor. Use `tags` for short facts (`round 2`, `worktree`); model and tool go in `agent`, not tags.
4. **Hand off.** Any agent holding the `taskId` may write any node; the last write wins. Put `chronicle: task <taskId>` and the node path the subagent works under in every subagent brief. A subagent sets `agent` (tool, model, effort) on its node when it starts, and adds subtasks under that path.
5. **Flag what the user should check.** When you assume something the task did not state, or ship with a limitation (a skipped test, a workaround, a guess at intent), call `add_notice` with `kind: assumption` or `caveat` and one plain sentence of `text`, plus `path` when it belongs to a step. It shows as an alert on the task and in the Notices tab, so it survives several tasks finishing at once. Keep it for things worth a human's decision, not progress notes.
6. **Show, don't describe.** When a screenshot or rendered output says it better than a note (a UI change, a chart, a failing visual test), attach the file with `add_image`, plus `path` and a short `caption`. Set `review: true` only when the user should look at it closely; it gets a larger view. Images expire soon after the task finishes or goes idle, so they are for watching the work, not a record of it.
7. **Re-sync.** After context compaction, call `get_task` for the real state of every node before writing again.
8. **Review.** When the work becomes a pull or merge request, set the task to `review` with `update_task` and pass `prs: [{ url }]`. The URL is enough: status, checks and review are filled in from `gh` or `glab` when they are installed and signed in, and kept current while the MCP server runs. When every PR merges, the task moves to `done` on its own. Without `gh` or `glab`, update `prs` yourself as the PR changes.
9. **Finish.** Before you hand finished or stuck work back to the user, set the task's state with `update_task` to a done-, failed- or blocked-kind state: `done`, `failed` or `needs_input` in the default preset. Never end a turn with the work over and the task still active. Entering a done-kind state makes the dashboard celebrate and collapse the task into a badge. In the same call, add the PR or result to `links`; `links` replaces the list, so resend the ticket too. Add `agent: { tokens }` with the tokens you used, if you know them. Each subagent reports its own `tokens` on its node when it finishes. `agent` fields merge, so send only what is new.
10. **Project notes.** When the repo's goal or context is worth a viewer knowing (what this push is for, who is waiting on it), set it once with `update_project` `notes`, and project-wide `links` (board, repo, spec).

States are keys from the project's config. The default preset:

| key | meaning | kind |
|---|---|---|
| `queued` | not started (initial) | pending |
| `planning` | being planned | active |
| `in_work` | being built | active |
| `testing` | being verified | active |
| `review` | PR open, waiting on reviewers | review |
| `needs_input` | waiting on a person | blocked |
| `failed` | gave up | failed |
| `done` | completed | done |

The task has its own state; set it explicitly, it does not follow the steps.

## Reminders

A system reminder starting with `chronicle:` comes from hooks that watch this session's task. Act on it in your next tool call: start the task, update the step it names, or call `get_task`.

## Warnings

A tool answer starting with `chronicle:` is a warning (unreachable server, unknown task, unknown state). Continue the real work and do not retry. An unknown-state warning lists the valid states; use one of them next time.

## CLI

```
chronicle start "<title>" --summary "<s>" --project "Billing API" \
  --step step-1="Title" --step step-1/tests="Tests" --step step-2="Title" \
  --tool claude-code --model <id> --effort high --link "https://github.com/o/r/issues/7|#7"   # prints: <taskId> <url>
chronicle step <taskId> <path> <state> --note "<n>" --tag "round 2" --model <id>
chronicle task <taskId> review --pr "<pr url>" --tokens 182000
chronicle task <taskId> done --note "<n>" --link "<issue url>"
chronicle sync                                       # refresh PR status once (cron-friendly)
chronicle project --notes "<goal and context>" --link "https://trello.com/b/...|board"
chronicle get <taskId>                                                                  # prints JSON
```

## Configure

Colors, states and theme change through `configure` (CLI: `chronicle config`), as a patch that merges states by key:

```
configure { patch: { states: [{ key: 'in_work', color: '#14b8a6' }] } }
chronicle config --color in_work=#14b8a6
```

A new state key needs a full definition (`key`, `label`, `color`, `kind`). `configure` with no `patch` or `config` reads the current config.
