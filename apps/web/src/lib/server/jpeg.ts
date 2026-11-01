const SOF = new Set([0xc0, 0xc1, 0xc2]);

// Reads the frame header only; pixels are never decoded.
export function jpegSize(data: Buffer): { width: number; height: number } | null {
	if (data.length < 4 || data[0] !== 0xff || data[1] !== 0xd8) return null;
	let at = 2;
	while (at + 4 <= data.length) {
		if (data[at] !== 0xff) return null;
		const marker = data[at + 1];
		if (marker === 0xff) {
			at++;
			continue;
		}
		const length = data.readUInt16BE(at + 2);
		if (length < 2) return null;
		if (SOF.has(marker)) {
			if (at + 9 > data.length) return null;
			const height = data.readUInt16BE(at + 5);
			const width = data.readUInt16BE(at + 7);
			return width > 0 && height > 0 ? { width, height } : null;
		}
		if (marker === 0xda || marker === 0xd9) return null;
		at += 2 + length;
	}
	return null;
}
