import { expect, test } from '@playwright/test';

const TOKEN = 'e2e-admin-token-0123456789';

test('admin portal: sign in, see a Project, export it, delete it', async ({ page, request }) => {
	const created = await request.post('/api/projects', { data: { name: 'Admin e2e project' } });
	const project = await created.json();

	await page.goto('/admin');
	await page.getByTestId('token').fill('wrong-token');
	await page.getByTestId('login-submit').click();
	await expect(page.getByTestId('message')).toBeVisible();
	await expect(page.getByTestId('stats')).toHaveCount(0);

	await page.getByTestId('token').fill(TOKEN);
	await page.getByTestId('login-submit').click();
	await expect(page.getByTestId('stats')).toBeVisible();
	const row = page.locator(`[data-testid="project"][data-id="${project.id}"]`);
	await expect(row).toContainText('Admin e2e project');

	const cookies = await page.context().cookies();
	expect(cookies.find((c) => c.name === 'chronicle_admin')).toMatchObject({
		httpOnly: true,
		sameSite: 'Strict'
	});

	const download = page.waitForEvent('download');
	await page.getByTestId('export').click();
	expect((await download).suggestedFilename()).toMatch(/^chronicle-.*\.zip$/);

	await row.getByTestId('delete').click();
	await page.getByTestId('delete-confirm').fill('not the name');
	await page.getByTestId('delete-submit').click();
	await expect(page.getByTestId('message')).toContainText('exactly');
	await page.getByTestId('delete-confirm').fill(`Admin e2e project (${project.id.slice(0, 8)})`);
	await page.getByTestId('delete-submit').click();
	await expect(row).toHaveCount(0);
	expect((await request.get(`/api/projects/${project.id}`)).status()).toBe(404);

	await page.getByTestId('logout').click();
	await expect(page.getByTestId('login-form')).toBeVisible();
});

test('admin API takes the token as a Bearer header and refuses anything else', async ({
	request
}) => {
	expect((await request.get('/api/admin/export')).status()).toBe(401);
	const exported = await request.get('/api/admin/export', {
		headers: { authorization: `Bearer ${TOKEN}` }
	});
	expect(exported.status()).toBe(200);
	expect(exported.headers()['content-type']).toBe('application/zip');
	expect((await exported.body()).subarray(0, 2).toString()).toBe('PK');
});

test('encoded spellings of admin paths do not skip the gate', async ({ request }) => {
	for (const path of ['/%61pi/admin/stats', '/api/%61dmin/stats', '/%2561pi/admin/stats']) {
		const response = await request.get(path, { maxRedirects: 0 });
		expect(response.status(), path).not.toBe(200);
	}
	const del = await request.delete('/%61pi/admin/projects/11111111-1111-4111-8111-111111111111');
	expect(del.status()).toBe(401);
});
