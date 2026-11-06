import { once } from 'node:events';
import { createReadStream } from 'node:fs';
import { open as openFile } from 'node:fs/promises';
import { crc32, createDeflateRaw, createInflateRaw } from 'node:zlib';

const U32_MAX = 0xffffffff;
const EOCD_SIG = 0x06054b50;
const CEN_SIG = 0x02014b50;
const LOC_SIG = 0x04034b50;
const MAX_COMMENT = 0xffff;

export class ZipError extends Error {}

export interface ZipSource {
	name: string;
	data: AsyncIterable<Uint8Array>;
}

// Entries are pulled one at a time and each is drained before the next is requested, so a
// later entry may be derived from what an earlier one carried.
export async function* writeZip(entries: AsyncIterable<ZipSource>): AsyncGenerator<Buffer> {
	const central: Buffer[] = [];
	let offset = 0;
	const dosTime = 0;
	const dosDate = (1 << 5) | 1;

	for await (const entry of entries) {
		const name = Buffer.from(entry.name, 'utf8');
		const start = offset;
		const header = Buffer.alloc(30);
		header.writeUInt32LE(LOC_SIG, 0);
		header.writeUInt16LE(20, 4);
		header.writeUInt16LE(0x0808, 6);
		header.writeUInt16LE(8, 8);
		header.writeUInt16LE(dosTime, 10);
		header.writeUInt16LE(dosDate, 12);
		header.writeUInt16LE(name.length, 26);
		const head = Buffer.concat([header, name]);
		offset += head.length;
		yield head;

		const deflate = createDeflateRaw();
		const stop = new AbortController();
		let crc = 0;
		let size = 0;
		let packed = 0;
		const feed = (async () => {
			for await (const chunk of entry.data) {
				crc = crc32(chunk, crc);
				size += chunk.length;
				if (!deflate.write(chunk)) await once(deflate, 'drain', { signal: stop.signal });
			}
			deflate.end();
		})().catch((error) => deflate.destroy(error));
		try {
			for await (const out of deflate) {
				packed += out.length;
				offset += out.length;
				yield out as Buffer;
			}
		} finally {
			// Releases the source: a feeder parked on 'drain' would otherwise hold it forever.
			stop.abort();
			deflate.destroy();
			await feed;
		}
		if (size > U32_MAX || packed > U32_MAX || offset > U32_MAX) {
			throw new ZipError('bundle exceeds 4 GiB');
		}

		const descriptor = Buffer.alloc(16);
		descriptor.writeUInt32LE(0x08074b50, 0);
		descriptor.writeUInt32LE(crc, 4);
		descriptor.writeUInt32LE(packed, 8);
		descriptor.writeUInt32LE(size, 12);
		offset += descriptor.length;
		yield descriptor;

		const record = Buffer.alloc(46);
		record.writeUInt32LE(CEN_SIG, 0);
		record.writeUInt16LE(20, 4);
		record.writeUInt16LE(20, 6);
		record.writeUInt16LE(0x0808, 8);
		record.writeUInt16LE(8, 10);
		record.writeUInt16LE(dosTime, 12);
		record.writeUInt16LE(dosDate, 14);
		record.writeUInt32LE(crc, 16);
		record.writeUInt32LE(packed, 20);
		record.writeUInt32LE(size, 24);
		record.writeUInt16LE(name.length, 28);
		record.writeUInt32LE(start, 42);
		central.push(Buffer.concat([record, name]));
	}

	const directory = Buffer.concat(central);
	const end = Buffer.alloc(22);
	end.writeUInt32LE(EOCD_SIG, 0);
	end.writeUInt16LE(central.length, 8);
	end.writeUInt16LE(central.length, 10);
	end.writeUInt32LE(directory.length, 12);
	end.writeUInt32LE(offset, 16);
	yield directory;
	yield end;
}

export interface ZipEntry {
	name: string;
	size: number;
	packed: number;
	crc: number;
	method: number;
	offset: number;
}

export interface ZipLimits {
	maxEntries: number;
	maxEntryBytes: number;
	maxTotalBytes: number;
}

// Names are only ever matched against an allowlist, never joined to a path; this rejects the
// shapes that would be dangerous if a caller did extract.
export function checkEntryName(name: string): void {
	const bad =
		name === '' ||
		name.length > 255 ||
		name.includes('\0') ||
		name.includes('\\') ||
		name.startsWith('/') ||
		/^[A-Za-z]:/.test(name) ||
		name.split('/').some((part) => part === '' || part === '.' || part === '..');
	if (bad) throw new ZipError(`unsafe entry name ${JSON.stringify(name.slice(0, 80))}`);
}

export async function readDirectory(path: string, limits: ZipLimits): Promise<ZipEntry[]> {
	const file = await openFile(path, 'r');
	try {
		const { size } = await file.stat();
		const tail = Math.min(size, 22 + MAX_COMMENT);
		const buffer = Buffer.alloc(tail);
		await file.read(buffer, 0, tail, size - tail);
		let at = -1;
		for (let i = tail - 22; i >= 0; i--) {
			if (buffer.readUInt32LE(i) === EOCD_SIG) {
				at = i;
				break;
			}
		}
		if (at < 0) throw new ZipError('not a zip file');
		const count = buffer.readUInt16LE(at + 10);
		const length = buffer.readUInt32LE(at + 12);
		const start = buffer.readUInt32LE(at + 16);
		if (count === 0xffff || length === U32_MAX || start === U32_MAX) {
			throw new ZipError('zip64 bundles are not supported');
		}
		if (count > limits.maxEntries) throw new ZipError('too many entries');
		if (start + length > size || length > 1 << 20) throw new ZipError('corrupt zip directory');

		const directory = Buffer.alloc(length);
		await file.read(directory, 0, length, start);
		const entries: ZipEntry[] = [];
		let total = 0;
		let p = 0;
		for (let i = 0; i < count; i++) {
			if (p + 46 > length || directory.readUInt32LE(p) !== CEN_SIG) {
				throw new ZipError('corrupt zip directory');
			}
			const flags = directory.readUInt16LE(p + 8);
			const method = directory.readUInt16LE(p + 10);
			const crc = directory.readUInt32LE(p + 16);
			const packed = directory.readUInt32LE(p + 20);
			const unpacked = directory.readUInt32LE(p + 24);
			const nameLength = directory.readUInt16LE(p + 28);
			const extra = directory.readUInt16LE(p + 30);
			const comment = directory.readUInt16LE(p + 32);
			const offset = directory.readUInt32LE(p + 42);
			if (p + 46 + nameLength > length) throw new ZipError('corrupt zip directory');
			const name = directory.toString('utf8', p + 46, p + 46 + nameLength);
			p += 46 + nameLength + extra + comment;
			checkEntryName(name);
			if (flags & 1) throw new ZipError('encrypted entries are not supported');
			if (method !== 0 && method !== 8) throw new ZipError(`unsupported compression in ${name}`);
			if (packed === U32_MAX || unpacked === U32_MAX || offset === U32_MAX) {
				throw new ZipError('zip64 bundles are not supported');
			}
			if (unpacked > limits.maxEntryBytes) throw new ZipError(`${name} is too large`);
			total += unpacked;
			if (total > limits.maxTotalBytes) throw new ZipError('bundle unpacks too large');
			if (offset + 30 + packed > size) throw new ZipError(`${name} runs past the end of the file`);
			entries.push({ name, size: unpacked, packed, crc, method, offset });
		}
		if (new Set(entries.map((entry) => entry.name)).size !== entries.length) {
			throw new ZipError('duplicate entry names');
		}
		return entries;
	} finally {
		await file.close();
	}
}

// Streams one entry's bytes. The inflate is capped at the declared size, and the stream errors
// if the length or CRC disagrees, so a lying header cannot expand past what the directory said.
export async function* readEntry(path: string, entry: ZipEntry): AsyncGenerator<Buffer> {
	const file = await openFile(path, 'r');
	let dataStart: number;
	try {
		const local = Buffer.alloc(30);
		await file.read(local, 0, 30, entry.offset);
		if (local.readUInt32LE(0) !== LOC_SIG)
			throw new ZipError(`corrupt local header for ${entry.name}`);
		dataStart = entry.offset + 30 + local.readUInt16LE(26) + local.readUInt16LE(28);
	} finally {
		await file.close();
	}
	if (entry.packed === 0) {
		if (entry.size > 0) throw new ZipError(`${entry.name} is empty on disk`);
		if (entry.crc !== 0) throw new ZipError(`${entry.name} fails its zip checksum`);
		return;
	}

	const raw = createReadStream(path, {
		start: dataStart,
		end: dataStart + entry.packed - 1
	});
	const inflate = createInflateRaw();
	raw.on('error', (error) => inflate.destroy(error));
	const source: AsyncIterable<Buffer> = entry.method === 8 ? raw.pipe(inflate) : raw;

	let produced = 0;
	let crc = 0;
	try {
		for await (const chunk of source) {
			produced += chunk.length;
			if (produced > entry.size) throw new ZipError(`${entry.name} is larger than declared`);
			crc = crc32(chunk, crc);
			yield chunk;
		}
	} catch (error) {
		if (error instanceof ZipError) throw error;
		throw new ZipError(`${entry.name} is corrupt`);
	} finally {
		raw.destroy();
		inflate.destroy();
	}
	if (produced !== entry.size || crc !== entry.crc) {
		throw new ZipError(`${entry.name} fails its zip checksum`);
	}
}
