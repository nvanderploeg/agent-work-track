export type StateKind = 'pending' | 'active' | 'review' | 'blocked' | 'failed' | 'done';
export type Animation = 'none' | 'pulse' | 'shimmer' | 'blink' | 'spin';
export type Theme = 'system' | 'light' | 'dark';

export interface StateDef {
	key: string;
	label: string;
	color: string;
	kind: StateKind;
	icon?: string;
	animation?: Animation;
}

export interface ProjectConfig {
	theme: Theme;
	initialState: string;
	states: StateDef[];
}

export interface ConfigPatch {
	theme?: Theme;
	initialState?: string;
	states?: (Partial<StateDef> & { key: string })[];
}

export interface Tag {
	text: string;
	color?: string;
}

export interface AgentInfo {
	tool?: string;
	model?: string;
	effort?: string;
	tokens?: number;
}

export interface Link {
	url: string;
	label?: string;
}

export type PrState = 'draft' | 'open' | 'merged' | 'closed';
export type PrChecks = 'pending' | 'passing' | 'failing';
export type PrReview = 'pending' | 'approved' | 'changes_requested';

export interface PullRequest {
	url: string;
	number?: number;
	title?: string;
	state?: PrState;
	checks?: PrChecks;
	review?: PrReview;
}

export interface Project {
	id: string;
	name: string;
	notes: string;
	links: Link[];
	config: ProjectConfig;
	owned: boolean;
	public: boolean;
	createdAt: string;
	lastWriteAt: string;
}

export interface Task {
	id: string;
	projectId: string;
	title: string;
	summary: string;
	state: string;
	note: string;
	agent: AgentInfo | null;
	links: Link[];
	prs: PullRequest[];
	public: boolean;
	repo: string | null;
	branch: string | null;
	createdAt: string;
	updatedAt: string;
	stateSince: string;
	finishedAt: string | null;
}

export interface Node {
	taskId: string;
	path: string;
	parentPath: string | null;
	key: string;
	depth: number;
	title: string;
	state: string;
	note: string;
	tags: Tag[];
	agent: AgentInfo | null;
	links: Link[];
	position: number;
	createdAt: string;
	updatedAt: string;
	stateSince: string;
}

export type NoticeKind = 'assumption' | 'caveat';

export interface Notice {
	id: string;
	taskId: string;
	path: string | null;
	kind: NoticeKind;
	text: string;
	createdAt: string;
}

// The bytes live only in the server's memory and expire; this record outlives them.
export interface Image {
	id: string;
	taskId: string;
	path: string | null;
	caption: string;
	review: boolean; // has a 512 px view the user is meant to look at
	width: number; // of the largest stored size
	height: number;
	createdAt: string;
}

export interface Snapshot {
	project: Project;
	tasks: Task[];
	nodes: Node[];
	notices: Notice[];
	images: Image[];
	lastSeq: number;
}

export interface ChronicleEvent {
	seq: number;
	type: 'config' | 'project' | 'task' | 'node' | 'notice' | 'image';
	taskId: string | null;
	path: string | null;
	payload: { config: ProjectConfig } | Project | Task | Node | Notice | Image;
	at: string;
}
