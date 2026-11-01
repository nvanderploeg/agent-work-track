# chronicle dashboard helpers contract

Pure functions in `apps/web/src/lib/ui/dashboard.ts`, used by the dashboard components. Types are from `apps/web/src/lib/types.ts` (as in `docs/api.md`). No DOM, no timers, no I/O.

```ts
export interface DashboardState {
	project: Project;
	tasks: Task[]; // createdAt desc, id desc on ties
	nodes: Node[];
	notices: Notice[];
	images: Image[];
	lastSeq: number;
}

export const FALLBACK_COLOR = '#9ca3af';
export const STALE_MS = 4 * 60 * 60 * 1000;

export function applyEvent(state: DashboardState, event: ChronicleEvent): DashboardState;
export function stateOf(config: ProjectConfig, key: string): StateDef;
export function kindOf(config: ProjectConfig, key: string): StateKind;
export function taskBucket(task: Task, config: ProjectConfig): 'badge' | 'card';
export function isStale(task: Task, nodes: Node[], config: ProjectConfig, now: number, staleMs?: number): boolean;
export function childrenOf(nodes: Node[], taskId: string, parentPath: string | null): Node[];
export function subtreeStates(nodes: Node[], taskId: string, path: string): string[];
export type NoticeStatus = 'unread' | 'approved' | 'flagged'; // kept per browser in localStorage
export function noticesOf(notices: Notice[], taskId: string): Notice[];
export function needsReview(status: NoticeStatus): boolean;
export function imagesOf(images: Image[], taskId: string, path: string | null): Image[];
export function justFinished(prev: Task | undefined, next: Task, config: ProjectConfig): boolean;
export function allSettled(tasks: Task[], config: ProjectConfig): boolean;
export function formatElapsed(fromIso: string, now: number): string;
export function runtimeOf(task: Task, now: number): string;
export function stepProgress(nodes: Node[], taskId: string, config: ProjectConfig): { done: number; total: number };
```

- **applyEvent** — returns a new state; never mutates its input. An event with `seq <= state.lastSeq` returns `state` unchanged (same reference). Otherwise `lastSeq = event.seq` and: `config` → `project.config` replaced; `task` → upsert by `id`, keeping the ordering rule; `node` → upsert by (`taskId`, `path`). Node order in `state.nodes` is not significant.
- **stateOf** — the config's `StateDef` for `key`; unknown key → `{ key, label: key, color: FALLBACK_COLOR, kind: 'pending', icon: '?', animation: 'none' }`.
- **kindOf** — `stateOf(config, key).kind`.
- **taskBucket** — `'badge'` when the task state's kind is `done` or `failed`, else `'card'`.
- **isStale** — false when the task's kind is `done` or `failed`. Otherwise true when `now - latest > staleMs` (default `STALE_MS`), where `latest` is the newest `updatedAt` among the task and its own nodes (nodes with another `taskId` are ignored).
- **childrenOf** — nodes of that task whose `parentPath` equals `parentPath` (`null` = steps), sorted by `position` asc, then `path` asc.
- **subtreeStates** — `state` of every descendant of `path` in that task (not the node itself), in `depth` asc, then `position` asc, then `path` asc order.
- **applyEvent, notice** — a `notice` event appends its `Notice` unless one with that `id` is already present.
- **applyEvent, image** — an `image` event appends its `Image` unless one with that `id` is already present.
- **imagesOf** — the images of that task attached at `path` (`null` = the task itself), in input order.
- **noticesOf** — the notices of that task, in input order.
- **needsReview** — false for `approved`, true otherwise. A task shows its alert while any of its notices needs review.
- **justFinished** — true when `next`'s kind is `done` and `prev` is undefined-or-not-done. Used to trigger the green flash; a task first seen already done (on page load) is handled by the caller passing `prev` = the same task, so it returns false.
- **allSettled** — true when `tasks` is non-empty and every task's kind is `done` or `failed`.
- **formatElapsed** — elapsed `now - Date.parse(fromIso)`, floored, negative treated as 0: under 60 s → `'<n>s'`; under 60 min → `'<n>m'`; under 24 h → `'<h>h'` or `'<h>h <m>m'` when minutes > 0; otherwise `'<d>d'` or `'<d>d <h>h'` when hours > 0. Examples: 0 → `'0s'`, 59 999 ms → `'59s'`, 60 000 → `'1m'`, 3 600 000 → `'1h'`, 3 900 000 → `'1h 5m'`, 90 000 000 → `'1d 1h'`.
- **runtimeOf** — `formatElapsed` from `task.createdAt` to `task.finishedAt`, or to `now` while unfinished.
- **stepProgress** — Steps (depth 1) of that task whose State is `done`-kind, over all its Steps. Subtasks are not counted.

Also in `ui/meta.ts` and `ui/markdown.ts`:

```ts
export function tokensByModel(tasks: Task[], nodes: Node[]): { model: string; tokens: number }[];
export function taskMarkdown(task: Task, nodes: Node[], notices: Notice[], config: ProjectConfig, now: number): string;
```

- **tokensByModel** — tokens of the tasks' `agent` and of their nodes' `agent`, summed per `agent.model` (`'unknown'` when absent), largest first; ties by model name. Nodes of tasks not in `tasks` and agents without tokens are ignored.
- **taskMarkdown** — a task as markdown for pasting: a facts line (state, steps done, runtime, agent, tokens), summary, note, nested Steps with state and note, the task's Notices, Links and PRs. Empty sections are omitted.

## Images on the board

A Task card shows its task-level Images, and each Node row its own, as a strip of 256 px thumbnails (`/api/images/<id>/thumb.jpg`) drawn small. A `review` Image has an accent ring and a `review` mark. Clicking one opens a single lightbox (`<dialog>`, Esc or backdrop closes) with `full.jpg` for a `review` Image, else `thumb.jpg`, and the caption. An Image whose request fails is marked expired in the `Board` (`expired`), so every strip and the lightbox show it as expired from then on; the browser cache keeps whatever it already loaded.

