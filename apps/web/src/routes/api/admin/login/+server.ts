import type { RequestHandler } from './$types';
import { adminAuth } from '#lib/server/admin/auth.ts';

export const POST: RequestHandler = (event) => adminAuth.login(event);
