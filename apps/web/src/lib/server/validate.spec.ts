import { describe, expect, it } from 'vitest';
import { parseOwnerTarget } from './validate.ts';

const rejects = (body: Record<string, unknown>) =>
	expect(() => parseOwnerTarget(body)).toThrowError(expect.objectContaining({ status: 400 }));

describe('parseOwnerTarget', () => {
	it('takes a uid as given', () => {
		expect(parseOwnerTarget({ uid: 'abc123-XYZ' })).toEqual({ uid: 'abc123-XYZ' });
		expect(parseOwnerTarget({ uid: 'x'.repeat(128) })).toEqual({ uid: 'x'.repeat(128) });
	});

	it('trims and lowercases an email', () => {
		expect(parseOwnerTarget({ email: '  Ann@Example.COM ' })).toEqual({ email: 'ann@example.com' });
	});

	it('wants exactly one of uid or email', () => {
		rejects({});
		rejects({ uid: 'a', email: 'a@b.c' });
	});

	it('refuses malformed uids', () => {
		rejects({ uid: '' });
		rejects({ uid: 'x'.repeat(129) });
		rejects({ uid: 'has space' });
		rejects({ uid: 'new\nline' });
		rejects({ uid: 5 });
	});

	it('refuses malformed emails', () => {
		rejects({ email: '' });
		rejects({ email: 'no-at-sign' });
		rejects({ email: 'a b@c.d' });
		rejects({ email: 42 });
	});
});
