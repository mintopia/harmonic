import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';

const FLOW = `name: flow-axe
description: imported
steps:
  - attempts:
      max: 1
      steps:
        - id: build
          run: npm test
`;

async function login(page: Page): Promise<void> {
  await page.goto('/');
  await page.locator('input[type="password"]').fill('verify-pass');
  await page.locator('button[type="submit"]').click();
  await page.waitForSelector('aside');
}

async function open(page: Page, path: string): Promise<void> {
  await page.goto(path);
  await page.waitForSelector('aside');
}

async function expectNoViolations(page: Page): Promise<void> {
  await page.waitForTimeout(500);
  const { violations } = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa']).analyze();
  expect(violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`)).toEqual([]);
}

test('settings, prompts and workflow editor pass axe wcag2a/aa at 1440 light', async ({ page }) => {
  await login(page);
  const workspace = await page.evaluate(
    async () =>
      (
        await fetch('/api/workspaces', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ name: 'axe-ws', workingDir: '/tmp' }),
        })
      ).json() as Promise<{ id: number }>,
  );

  const settings: Array<[string, string, string]> = [
    ['/settings', 'archive', 'deliver'],
    ['/settings', 'archive', 'export'],
    [`/workspace/${workspace.id}/settings`, 'archive', 'deliver'],
    [`/workspace/${workspace.id}/settings`, 'archive', 'export'],
    [`/workspace/${workspace.id}/settings`, 'execution', 'limits'],
    [`/workspace/${workspace.id}/settings`, 'execution', 'agent'],
    [`/workspace/${workspace.id}/settings`, 'execution', 'where'],
    [`/workspace/${workspace.id}/settings`, 'general', 'chats'],
  ];
  for (const [base, tab, step] of settings) {
    await open(page, `${base}?tab=${tab}&step=${step}`);
    await expectNoViolations(page);
  }

  await open(page, '/settings?tab=prompts&step=find');
  await expectNoViolations(page);
  await page.locator('li button, tr button').first().click();
  await expect(page.getByRole('textbox', { name: 'Text' })).toBeVisible();
  await expectNoViolations(page);

  await open(page, '/workflows');
  await page.locator('input[type="file"]').setInputFiles({ name: 'flow-axe.yaml', mimeType: 'application/yaml', buffer: Buffer.from(FLOW) });
  await page.locator('tbody tr', { hasText: 'flow-axe' }).getByRole('button', { name: 'flow-axe' }).click();
  await page.getByRole('tab', { name: 'Blocks' }).click();
  await expectNoViolations(page);
  await page.getByRole('tab', { name: 'YAML' }).click();
  await expectNoViolations(page);
});
