const SEGMENT_MAX = 65_533;

function appSegment(size: number): Buffer {
	const segment = Buffer.alloc(4 + size);
	segment.writeUInt16BE(0xffe1, 0);
	segment.writeUInt16BE(2 + size, 2);
	return segment;
}

// A JPEG with a valid frame header and no scan data; enough for anything that reads only the header.
export function fakeJpeg(width: number, height: number, padding = 0): Buffer {
	const apps: Buffer[] = [];
	for (let left = padding; left > 0; left -= SEGMENT_MAX) {
		apps.push(appSegment(Math.min(left, SEGMENT_MAX)));
	}
	const sof = Buffer.from([0xff, 0xc0, 0x00, 0x0b, 0x08, 0, 0, 0, 0, 0x01, 0x01, 0x11, 0x00]);
	sof.writeUInt16BE(height, 5);
	sof.writeUInt16BE(width, 7);
	return Buffer.concat([Buffer.from([0xff, 0xd8]), ...apps, sof, Buffer.from([0xff, 0xd9])]);
}
