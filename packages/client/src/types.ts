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

export interface ClientOptions {
	env?: Record<string, string | undefined>;
	configDir?: string;
	loginFile?: string; // default `${XDG_CONFIG_HOME ?? ~/.config}/runestone/login.json`
	fetch?: typeof fetch;
	candidates?: string[];
	probeTimeoutMs?: number;
	remoteProbeTimeoutMs?: number;
	requestTimeoutMs?: number;
	imageTimeoutMs?: number;
	loginPollMs?: number;
	identityUrls?: { signIn: string; refresh: string };
	runCommand?: (command: string, args: string[]) => Promise<string | null>;
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
	pinned: string | null;
	probes: { server: string; ok: boolean; version?: string }[];
	server: string | null;
	repoKey: string;
	registered: { projectId: string; name: string } | null;
	registryError: string | null;
}

export interface LoginCode {
	userCode: string;
	verificationUrl: string;
	expiresIn: number;
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
		repo?: string;
		branch?: string;
		project?: string;
		cwd?: string;
	}): Promise<
		Result<{
			taskId: string;
			url: string;
			server: string;
			projectId: string;
			projectUrl: string;
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
		file: string;
		path?: string;
		caption?: string;
		review?: boolean;
	}): Promise<Result<{ image: Image }>>;
	getTask(input: {
		taskId: string;
	}): Promise<Result<{ task: Task; nodes: Node[]; notices: Notice[]; url: string }>>;
	configure(input: {
		taskId?: string;
		cwd?: string;
		config?: ProjectConfig;
		patch?: ConfigPatch;
	}): Promise<Result<{ config: ProjectConfig; projectUrl: string }>>;
	projectUrl(input: { taskId?: string; cwd?: string }): Promise<Result<{ url: string }>>;
	doctor(input?: { cwd?: string }): Promise<DoctorReport>;
	/**
	 * Device login: asks the server for a code, passes it to `onCode`, then waits for the user to
	 * approve it signed in and trades the Firebase custom token it is handed for a refresh token
	 * and stores that. Projects created afterwards are owned by that user.
	 */
	login(input?: {
		label?: string;
		onCode?: (code: LoginCode) => void;
	}): Promise<Result<{ server: string }>>;
	/** Signs every tool of the user out at Firebase (best effort) and forgets the local credential. */
	logout(): Promise<Result<{ server: string; revoked: boolean }>>;
}
