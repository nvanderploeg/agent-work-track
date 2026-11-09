import { normaliseServer, request } from './http.ts';

export const DEFAULT_CANDIDATES = ['http://localhost:3280', 'https://chronicle.merc.camp'];

function isLoopback(server: string): boolean {
	try {
		const host = new URL(server).hostname;
		return (
			host === 'localhost' || host.endsWith('.localhost') || host === '[::1]' || /^127\./.test(host)
		);
	} catch {
		return false;
	}
}

export interface Probe {
	server: string;
	ok: boolean;
	version?: string;
}

export function createDiscovery(opts: {
	fetch: typeof fetch;
	env: Record<string, string | undefined>;
	candidates: string[];
	probeTimeoutMs: number;
	remoteProbeTimeoutMs: number;
}) {
	const pinned = normaliseServer(opts.env.CHRONICLE_URL ?? '') || null;
	const targets = pinned ? [pinned] : opts.candidates.map(normaliseServer).filter(Boolean);

	async function probe(server: string): Promise<Probe> {
		const reply = await request<{ service?: unknown; version?: unknown } | null>(
			opts.fetch,
			isLoopback(server) ? opts.probeTimeoutMs : opts.remoteProbeTimeoutMs,
			`${server}/api/health`,
			{ method: 'GET' }
		);
		if (!reply.ok || reply.body?.service !== 'chronicle') return { server, ok: false };
		return typeof reply.body.version === 'string'
			? { server, ok: true, version: reply.body.version }
			: { server, ok: true };
	}

	return {
		pinned,
		async discover(): Promise<string | null> {
			for (const server of targets) {
				if ((await probe(server)).ok) return server;
			}
			return null;
		},
		probeAll: (): Promise<Probe[]> => Promise.all(targets.map(probe))
	};
}
