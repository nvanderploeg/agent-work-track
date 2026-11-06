const MAX_DECODES = 5;

export class MalformedPath extends Error {}

const tidy = (path: string) =>
	path
		.toLowerCase()
		.replace(/\/{2,}/g, '/')
		.replace(/\/+$/, '') || '/';

/** The path as written and after each round of percent-decoding, lowercased with slashes collapsed. Throws MalformedPath on a bad escape or nesting past the cap. */
export function pathVariants(pathname: string): string[] {
	const variants = new Set<string>();
	let current = pathname;
	for (let round = 0; round <= MAX_DECODES; round++) {
		variants.add(tidy(current));
		let next: string;
		try {
			next = decodeURIComponent(current);
		} catch {
			throw new MalformedPath();
		}
		if (next === current) return [...variants];
		current = next;
	}
	throw new MalformedPath();
}

/** True when any reading of the path lies at or under `prefix`; a malformed path counts as under. */
export function isUnder(pathname: string, prefix: string): boolean {
	try {
		return pathVariants(pathname).some((v) => v === prefix || v.startsWith(`${prefix}/`));
	} catch {
		return true;
	}
}
