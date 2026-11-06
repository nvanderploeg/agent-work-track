import { describe, expect, it } from 'vitest';
import { isUnder, pathVariants } from './path.ts';

describe('isUnder', () => {
	it.each([
		'/api/admin/stats',
		'/%61pi/admin/stats',
		'/api/%61dmin/stats',
		'/%41PI/%41dmin/stats',
		'/%2561pi/admin/stats',
		'/%252561pi/admin/stats',
		'//api/admin/stats',
		'/api//admin/stats',
		'/api/admin/stats/',
		'/api%2Fadmin/stats',
		'/api/admin',
		'/API/ADMIN/export'
	])('reads %s as under /api/admin', (path) => {
		expect(isUnder(path, '/api/admin')).toBe(true);
	});

	it.each(['/%41dmin', '/ADMIN/', '//admin', '/%2561dmin', '/admin/'])(
		'reads %s as /admin',
		(path) => {
			expect(isUnder(path, '/admin')).toBe(true);
		}
	);

	it.each(['/api/administrator', '/p/abc', '/apis/admin', '/'])('leaves %s alone', (path) => {
		expect(isUnder(path, '/api/admin')).toBe(false);
		expect(isUnder(path, '/admin')).toBe(false);
	});

	it('treats a malformed escape as under every prefix, and pathVariants throws', () => {
		expect(isUnder('/%E0%A4%A', '/admin')).toBe(true);
		expect(() => pathVariants('/%zz')).toThrow();
		expect(isUnder('/%25252525252561pi/x', '/api')).toBe(true);
	});
});
