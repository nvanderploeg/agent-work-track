import { ApiError } from '#lib/server/api.ts';
import { jpegSize } from '#lib/server/jpeg.ts';
import { COLOR_PATTERN, isObject, validateConfig } from '#lib/server/config.ts';
import { moniker } from '#lib/server/moniker.ts';
import { PRESETS } from '#lib/server/presets.ts';
import type { AgentInfo, Link, NoticeKind, ProjectConfig, PullRequest, Tag } from '#lib/types.ts';

const MAX_TEXT = 10_000;
const MAX_NAME = 255;
const MAX_PATH = 512;
const SEGMENT = /^[A-Za-z0-9._-]{1,64}$/;
const INT32_MAX = 2_147_483_647;
const MAX_LINKS = 20;
const MAX_URL = 2048;
const MAX_LABEL = 100;
const MAX_AGENT_FIELD = 64;
const MAX_REF = 255;
const MAX_PRS = 10;
const PR_STATES = ['draft', 'open', 'merged', 'closed'] as const;
const PR_CHECKS = ['pending', 'passing', 'failing'] as const;
const NOTICE_KINDS = ['assumption', 'caveat'] as const;
const MAX_NOTICE = 2000;
const MAX_CAPTION = 300;
const IMAGE_LIMITS = {
	thumb: { side: 256, bytes: 64 * 1024 },
	full: { side: 512, bytes: 192 * 1024 }
} as const;
const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;
const PR_REVIEWS = ['pending', 'approved', 'changes_requested'] as const;

type Body = Record<string, unknown>;

export interface NodeInput {
	title?: string;
	state?: string;
	note?: string;
	tags?: Tag[];
	agent?: AgentInfo;
	links?: Link[];
	position?: number;
}

export interface StepInput extends NodeInput {
	key: string;
	subtasks?: StepInput[];
}

export interface TaskPatch {
	title?: string;
	summary?: string;
	state?: string;
	note?: string;
	agent?: AgentInfo;
	links?: Link[];
	prs?: PullRequest[];
	repo?: string;
	branch?: string;
}

export interface TaskInput extends TaskPatch {
	title: string;
	steps?: StepInput[];
}

export interface NoticeInput {
	kind: NoticeKind;
	text: string;
	path: string | null;
}

export interface ImageInput {
	thumb: Buffer;
	full: Buffer | null;
	caption: string;
	path: string | null;
	width: number;
	height: number;
}

export interface ProjectPatch {
	name?: string;
	notes?: string;
	links?: Link[];
}

function text(body: Body, field: string, opts: { nonEmpty?: boolean; max?: number } = {}) {
	const value = body[field];
	if (value === undefined) return undefined;
	const max = opts.max ?? MAX_TEXT;
	if (typeof value !== 'string' || value.length > max || (opts.nonEmpty && value === '')) {
		throw new ApiError(
			400,
			`${field} must be a ${opts.nonEmpty ? 'non-empty ' : ''}string of at most ${max} characters`
		);
	}
	return value;
}

function stateField(body: Body): string | undefined {
	const value = body.state;
	if (value === undefined) return undefined;
	if (typeof value !== 'string') throw new ApiError(400, 'state must be a string');
	return value;
}

function tags(body: Body): Tag[] | undefined {
	const value = body.tags;
	if (value === undefined) return undefined;
	if (!Array.isArray(value)) throw new ApiError(400, 'tags must be an array');
	return value.map((raw, index) => {
		if (!isObject(raw) || typeof raw.text !== 'string' || raw.text === '') {
			throw new ApiError(400, `tags[${index}].text must be a non-empty string`);
		}
		const tag: Tag = { text: raw.text };
		if (raw.color !== undefined) {
			if (typeof raw.color !== 'string' || !COLOR_PATTERN.test(raw.color)) {
				throw new ApiError(400, `tags[${index}].color must match ${COLOR_PATTERN}`);
			}
			tag.color = raw.color;
		}
		return tag;
	});
}

function agent(body: Body): AgentInfo | undefined {
	const value = body.agent;
	if (value === undefined) return undefined;
	if (!isObject(value)) throw new ApiError(400, 'agent must be an object');
	const info: AgentInfo = {};
	for (const field of ['tool', 'model', 'effort'] as const) {
		const v = text(value, field, { nonEmpty: true, max: MAX_AGENT_FIELD });
		if (v !== undefined) info[field] = v;
	}
	if (value.tokens !== undefined) {
		if (!Number.isSafeInteger(value.tokens) || (value.tokens as number) < 0) {
			throw new ApiError(400, 'agent.tokens must be a non-negative integer');
		}
		info.tokens = value.tokens as number;
	}
	return info;
}

function links(body: Body): Link[] | undefined {
	const value = body.links;
	if (value === undefined) return undefined;
	if (!Array.isArray(value) || value.length > MAX_LINKS) {
		throw new ApiError(400, `links must be an array of at most ${MAX_LINKS}`);
	}
	return value.map((raw, index) => {
		if (!isObject(raw)) throw new ApiError(400, `links[${index}] must be an object`);
		const url = raw.url;
		if (typeof url !== 'string' || url.length > MAX_URL || !/^https?:\/\/\S+$/i.test(url)) {
			throw new ApiError(400, `links[${index}].url must be an http(s) URL`);
		}
		const link: Link = { url };
		const label = text(raw, 'label', { nonEmpty: true, max: MAX_LABEL });
		if (label !== undefined) link.label = label;
		return link;
	});
}

function oneOf<T extends string>(
	raw: Body,
	field: string,
	at: string,
	allowed: readonly T[]
): T | undefined {
	const value = raw[field];
	if (value === undefined) return undefined;
	if (typeof value !== 'string' || !allowed.includes(value as T)) {
		throw new ApiError(400, `${at}.${field} must be one of ${allowed.join(', ')}`);
	}
	return value as T;
}

function prs(body: Body): PullRequest[] | undefined {
	const value = body.prs;
	if (value === undefined) return undefined;
	if (!Array.isArray(value) || value.length > MAX_PRS) {
		throw new ApiError(400, `prs must be an array of at most ${MAX_PRS}`);
	}
	return value.map((raw, index) => {
		const at = `prs[${index}]`;
		if (!isObject(raw)) throw new ApiError(400, `${at} must be an object`);
		const url = raw.url;
		if (typeof url !== 'string' || url.length > MAX_URL || !/^https?:\/\/\S+$/i.test(url)) {
			throw new ApiError(400, `${at}.url must be an http(s) URL`);
		}
		if (
			raw.number !== undefined &&
			(!Number.isSafeInteger(raw.number) || (raw.number as number) < 1)
		) {
			throw new ApiError(400, `${at}.number must be a positive integer`);
		}
		return defined({
			url,
			number: raw.number as number | undefined,
			title: text(raw, 'title', { nonEmpty: true, max: 300 }),
			state: oneOf(raw, 'state', at, PR_STATES),
			checks: oneOf(raw, 'checks', at, PR_CHECKS),
			review: oneOf(raw, 'review', at, PR_REVIEWS)
		});
	});
}

function position(body: Body): number | undefined {
	const value = body.position;
	if (value === undefined) return undefined;
	if (!Number.isInteger(value) || Math.abs(value as number) > INT32_MAX) {
		throw new ApiError(400, 'position must be an integer');
	}
	return value as number;
}

function defined<T extends object>(value: T): T {
	return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as T;
}

export function parseNodeBody(body: Body): NodeInput {
	return defined({
		title: text(body, 'title', { nonEmpty: true }),
		state: stateField(body),
		note: text(body, 'note'),
		tags: tags(body),
		agent: agent(body),
		links: links(body),
		position: position(body)
	});
}

function parseSteps(raw: unknown, at: string, parentPath: string): StepInput[] {
	if (!Array.isArray(raw)) throw new ApiError(400, `${at} must be an array`);
	const keys = new Set<string>();
	return raw.map((item, index) => {
		const where = `${at}[${index}]`;
		if (!isObject(item)) throw new ApiError(400, `${where} must be an object`);
		if (typeof item.key !== 'string' || !SEGMENT.test(item.key)) {
			throw new ApiError(400, `${where}.key must match ${SEGMENT}`);
		}
		if (keys.has(item.key)) throw new ApiError(400, `duplicate step key "${item.key}"`);
		keys.add(item.key);
		const path = parentPath ? `${parentPath}/${item.key}` : item.key;
		if (path.length > MAX_PATH) throw new ApiError(400, `${where} path is too long`);
		const { title, state, note, tags, agent, links } = parseNodeBody(item);
		const subtasks =
			item.subtasks === undefined
				? undefined
				: parseSteps(item.subtasks, `${where}.subtasks`, path);
		return defined({ key: item.key, title, state, note, tags, agent, links, subtasks });
	});
}

export function parseTaskPatch(body: Body): TaskPatch {
	return defined({
		title: text(body, 'title', { nonEmpty: true }),
		summary: text(body, 'summary'),
		state: stateField(body),
		note: text(body, 'note'),
		agent: agent(body),
		links: links(body),
		prs: prs(body),
		repo: text(body, 'repo', { nonEmpty: true, max: MAX_REF }),
		branch: text(body, 'branch', { nonEmpty: true, max: MAX_REF })
	});
}

export function parseTaskCreate(body: Body): TaskInput {
	const title = text(body, 'title', { nonEmpty: true });
	if (title === undefined) throw new ApiError(400, 'title is required');
	return defined({
		...parseTaskPatch(body),
		title,
		steps: body.steps === undefined ? undefined : parseSteps(body.steps, 'steps', '')
	});
}

export function parseNoticeBody(body: Body): NoticeInput {
	const kind = oneOf(body, 'kind', 'notice', NOTICE_KINDS);
	if (kind === undefined) throw new ApiError(400, 'kind is required');
	const noticeText = text(body, 'text', { nonEmpty: true, max: MAX_NOTICE });
	if (noticeText === undefined) throw new ApiError(400, 'text is required');
	const path = body.path;
	if (path !== undefined && typeof path !== 'string') {
		throw new ApiError(400, 'path must be a string');
	}
	if (path !== undefined) parsePath(path);
	return { kind, text: noticeText, path: path ?? null };
}

function jpegField(body: Body, field: keyof typeof IMAGE_LIMITS) {
	const value = body[field];
	if (value === undefined) return undefined;
	const { side, bytes } = IMAGE_LIMITS[field];
	const problem = `${field} must be a base64 JPEG of at most ${side}×${side} px and ${bytes / 1024} KiB`;
	if (
		typeof value !== 'string' ||
		value.length > Math.ceil(bytes / 3) * 4 ||
		value.length % 4 !== 0 ||
		!BASE64.test(value)
	) {
		throw new ApiError(400, problem);
	}
	const data = Buffer.from(value, 'base64');
	const size = jpegSize(data);
	if (!size || data.length > bytes || size.width > side || size.height > side) {
		throw new ApiError(400, problem);
	}
	return { data, ...size };
}

export function parseImageBody(body: Body): ImageInput {
	const thumb = jpegField(body, 'thumb');
	if (thumb === undefined) throw new ApiError(400, 'thumb is required');
	const full = jpegField(body, 'full');
	const caption = text(body, 'caption', { max: MAX_CAPTION }) ?? '';
	const path = body.path;
	if (path !== undefined && typeof path !== 'string') {
		throw new ApiError(400, 'path must be a string');
	}
	if (path !== undefined) parsePath(path);
	const largest = full ?? thumb;
	return {
		thumb: thumb.data,
		full: full?.data ?? null,
		caption,
		path: path ?? null,
		width: largest.width,
		height: largest.height
	};
}

export function parsePath(raw: string | null | undefined): string[] {
	const segments = (raw ?? '').split('/');
	if (
		raw === null ||
		raw === undefined ||
		raw.length > MAX_PATH ||
		!segments.every((segment) => SEGMENT.test(segment))
	) {
		throw new ApiError(400, 'malformed node path');
	}
	return segments;
}

export function parseProjectPatch(body: Body): ProjectPatch {
	return defined({
		name: text(body, 'name', { nonEmpty: true, max: MAX_NAME }),
		notes: text(body, 'notes'),
		links: links(body)
	});
}

export function parseProjectCreate(body: Body): {
	name: string;
	notes: string;
	links: Link[];
	config: ProjectConfig;
} {
	const patch = parseProjectPatch(body);
	const fields = {
		name: patch.name ?? moniker(),
		notes: patch.notes ?? '',
		links: patch.links ?? []
	};
	let preset: ProjectConfig | undefined;
	if (body.preset !== undefined) {
		if (typeof body.preset !== 'string' || !Object.hasOwn(PRESETS, body.preset)) {
			throw new ApiError(400, 'unknown preset');
		}
		preset = PRESETS[body.preset];
	}
	if (body.config !== undefined) {
		const result = validateConfig(body.config);
		if (!result.ok) throw new ApiError(400, result.error);
		return { ...fields, config: result.config };
	}
	return { ...fields, config: structuredClone(preset ?? PRESETS['build-it']) };
}
