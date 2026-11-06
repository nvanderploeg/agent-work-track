import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { checkEntryName, readDirectory, readEntry, writeZip, ZipError } from './zip.ts';

const LIMITS = { maxEntries: 8, maxEntryBytes: 1 << 20, maxTotalBytes: 1 << 21 };

let dir: string;
beforeEach(async () => {
	dir = await mkdtemp(join(tmpdir(), 'zipspec-'));
});
afterEach(() => rm(dir, { recursive: true, force: true }));

async function build(files: Record<string, string | Buffer>): Promise<string> {
	async function* entries() {
		for (const [name, data] of Object.entries(files)) {
			yield {
				name,
				data: (async function* () {
					yield Buffer.from(data);
				})()
			};
		}
	}
	const parts: Buffer[] = [];
	for await (const chunk of writeZip(entries())) parts.push(chunk);
	const path = join(dir, 'a.zip');
	await writeFile(path, Buffer.concat(parts));
	return path;
}

async function read(path: string, name: string): Promise<string> {
	const entry = (await readDirectory(path, LIMITS)).find((e) => e.name === name)!;
	const parts: Buffer[] = [];
	for await (const chunk of readEntry(path, entry)) parts.push(chunk);
	return Buffer.concat(parts).toString();
}

describe('zip', () => {
	it('round-trips entries, including empty and large ones', async () => {
		const big = 'x'.repeat(300_000) + 'é';
		const path = await build({ 'a.txt': 'hello', 'empty.txt': '', 'big.txt': big });
		expect(await read(path, 'a.txt')).toBe('hello');
		expect(await read(path, 'empty.txt')).toBe('');
		expect(
			createHash('sha256')
				.update(await read(path, 'big.txt'))
				.digest('hex')
		).toBe(createHash('sha256').update(big).digest('hex'));
	});

	it.each(['../evil', 'a/../../evil', '/etc/passwd', 'C:/evil', 'a\\b', 'a//b', './a', 'a\0b', ''])(
		'refuses the entry name %j',
		async (name) => {
			expect(() => checkEntryName(name)).toThrow(ZipError);
			const path = await build({ [name]: 'x' });
			await expect(readDirectory(path, LIMITS)).rejects.toThrow(ZipError);
		}
	);

	it('refuses an entry that declares more than the limit', async () => {
		const path = await build({ 'a.txt': 'x'.repeat(2000) });
		await expect(readDirectory(path, { ...LIMITS, maxEntryBytes: 1000 })).rejects.toThrow(
			/too large/
		);
		await expect(readDirectory(path, { ...LIMITS, maxTotalBytes: 1000 })).rejects.toThrow(
			/too large/
		);
	});

	it('refuses too many entries and non-zip input', async () => {
		const path = await build({ a: '1', b: '2', c: '3' });
		await expect(readDirectory(path, { ...LIMITS, maxEntries: 2 })).rejects.toThrow(/too many/);
		const junk = join(dir, 'junk.zip');
		await writeFile(junk, 'not a zip at all');
		await expect(readDirectory(junk, LIMITS)).rejects.toThrow(/not a zip/);
	});

	it('stops a bomb whose header understates its size', async () => {
		const path = await build({ 'a.txt': 'y'.repeat(100_000) });
		const [entry] = await readDirectory(path, LIMITS);
		const lying = { ...entry, size: 10 };
		await expect(async () => {
			for await (const chunk of readEntry(path, lying)) void chunk;
		}).rejects.toThrow(/larger than declared/);
	});

	it('fails a flipped byte in the stored data', async () => {
		const path = await build({ 'a.txt': 'z'.repeat(5000) });
		const [entry] = await readDirectory(path, LIMITS);
		const bytes = Buffer.from(await (await import('node:fs/promises')).readFile(path));
		bytes[entry.offset + 30 + 5 + 3] ^= 0xff;
		await writeFile(path, bytes);
		await expect(read(path, 'a.txt')).rejects.toThrow(ZipError);
	});
});

describe('empty entries', () => {
	it('reads a stored entry with packed=0 and size=0 without opening an empty range', async () => {
		const path = join(dir, 'raw.zip');
		const name = Buffer.from('e');
		const local = Buffer.alloc(30);
		local.writeUInt32LE(0x04034b50, 0);
		local.writeUInt16LE(name.length, 26);
		const central = Buffer.alloc(46);
		central.writeUInt32LE(0x02014b50, 0);
		central.writeUInt16LE(name.length, 28);
		const end = Buffer.alloc(22);
		end.writeUInt32LE(0x06054b50, 0);
		end.writeUInt16LE(1, 8);
		end.writeUInt16LE(1, 10);
		end.writeUInt32LE(46 + name.length, 12);
		end.writeUInt32LE(30 + name.length, 16);
		await writeFile(path, Buffer.concat([local, name, central, name, end]));
		const entries = await readDirectory(path, LIMITS);
		const chunks: Buffer[] = [];
		for await (const chunk of readEntry(path, entries[0])) chunks.push(chunk);
		expect(chunks).toEqual([]);
	});
});
