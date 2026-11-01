import { readFile } from 'node:fs/promises';

export const THUMB_PX = 256;
export const FULL_PX = 512;
export const THUMB_MAX_BYTES = 64 * 1024;
export const FULL_MAX_BYTES = 192 * 1024;
const QUALITIES = [60, 45, 30];

export type Encoded = { ok: true; thumb: string; full?: string } | { ok: false; warning: string };

type Sharp = typeof import('sharp');

async function loadSharp(): Promise<Sharp | null> {
	try {
		const mod = (await import('sharp')) as unknown as { default?: Sharp };
		return mod.default ?? (mod as unknown as Sharp);
	} catch {
		return null;
	}
}

async function shrink(
	sharp: Sharp,
	input: Buffer,
	px: number,
	maxBytes: number
): Promise<Buffer | null> {
	for (const quality of QUALITIES) {
		const out = await sharp(input)
			.rotate()
			.resize(px, px, { fit: 'inside', withoutEnlargement: true })
			.flatten({ background: '#ffffff' })
			.jpeg({ quality, mozjpeg: true })
			.toBuffer();
		if (out.length <= maxBytes) return out;
	}
	return null;
}

export async function encodeImage(file: string, review: boolean): Promise<Encoded> {
	const sharp = await loadSharp();
	if (!sharp) {
		return {
			ok: false,
			warning: 'chronicle failed: image support unavailable (sharp did not load)'
		};
	}
	let input: Buffer;
	try {
		input = await readFile(file);
		await sharp(input).metadata();
	} catch {
		return { ok: false, warning: `chronicle failed: cannot read image ${file}` };
	}
	const tooBig = {
		ok: false as const,
		warning: `chronicle failed: ${file} does not compress under the image limit`
	};
	const thumb = await shrink(sharp, input, THUMB_PX, THUMB_MAX_BYTES);
	if (!thumb) return tooBig;
	if (!review) return { ok: true, thumb: thumb.toString('base64') };
	const full = await shrink(sharp, input, FULL_PX, FULL_MAX_BYTES);
	if (!full) return tooBig;
	return { ok: true, thumb: thumb.toString('base64'), full: full.toString('base64') };
}
