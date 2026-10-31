import { readFile } from 'node:fs/promises';
import { expect, test, type Locator, type Page } from '@playwright/test';

const FLOW = `name: flow-e2e
description: imported
steps:
  - attempts:
      max: 1
      steps:
        - id: build
          run: npm test
`;

test('import, edit, save and export: the downloaded file equals the saved YAML', async ({ page }, testInfo) => {
  await page.goto('/');
  await page.locator('input[type="password"]').fill('verify-pass');
  await page.locator('button[type="submit"]').click();
  await page.waitForSelector('aside');
  await page.goto('/workflows');

  await page.locator('input[type="file"]').setInputFiles({ name: 'flow-e2e.yaml', mimeType: 'application/yaml', buffer: Buffer.from(FLOW) });
  const row = page.locator('tbody tr', { hasText: 'flow-e2e' });
  await expect(row).toBeVisible();
  await row.getByRole('button', { name: 'flow-e2e' }).click();

  const editor = page.getByRole('textbox', { name: 'Workflow YAML' });
  await expect(editor).toContainText('description: imported');
  await editor.click();
  await page.keyboard.press('ControlOrMeta+a');
  const edited = FLOW.replace('description: imported', 'description: edited in the browser');
  await page.keyboard.insertText(edited);

  await page.getByRole('button', { name: 'Save as v2' }).click();
  await expect(page.getByText('Saved flow-e2e as v2')).toBeVisible();

  const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Export', exact: true }).click()]);
  expect(download.suggestedFilename()).toBe('flow-e2e.yaml');
  const path = testInfo.outputPath('flow-e2e.yaml');
  await download.saveAs(path);
  const exported = await readFile(path, 'utf8');

  const saved = await page.evaluate(async () => (await (await fetch('/api/workflows/flow-e2e')).json()).text as string);
  expect(saved).toContain('description: edited in the browser');
  expect(exported).toBe(saved);
});

const GROUPED = `name: group-e2e
description: builder
steps:
  - attempts:
      max: 1
      steps:
        - id: build
          run: npm test
        - id: checks
          parallel:
            - id: lint
              run: npm run lint
`;

async function dragTo(page: Page, from: Locator, to: Locator) {
  const a = (await from.boundingBox())!;
  await page.mouse.move(a.x + a.width / 2, a.y + a.height / 2);
  await page.mouse.down();
  await page.mouse.move(a.x + a.width / 2 + 10, a.y + a.height / 2 + 10, { steps: 3 });
  await page.mouse.move(a.x + a.width / 2 + 20, a.y + a.height / 2 + 20, { steps: 3 });
  await expect(page.locator('[data-slot]').first()).toBeVisible();
  await page.waitForTimeout(300);
  const b = (await to.boundingBox())!;
  await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2, { steps: 10 });
  await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2 + 1, { steps: 2 });
  await page.mouse.up();
}

async function openWorkflow(page: Page, name: string, yaml: string) {
  await page.goto('/');
  await page.locator('input[type="password"]').fill('verify-pass');
  await page.locator('button[type="submit"]').click();
  await page.waitForSelector('aside');
  await page.goto('/workflows');
  await page.locator('input[type="file"]').setInputFiles({ name: `${name}.yaml`, mimeType: 'application/yaml', buffer: Buffer.from(yaml) });
  await page.locator('tbody tr', { hasText: name }).getByRole('button', { name }).click();
}

test('the block builder drags a step into a parallel group and saves it in the YAML', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1800 });
  await openWorkflow(page, 'group-e2e', GROUPED);

  const build = page.locator('[data-block="steps/0/attempts/steps/0"]');
  await dragTo(page, build.getByLabel('Drag to move'), page.locator('[data-slot$="\\"parallel\\"]|1"]'));

  await page.getByRole('button', { name: 'Save as v2' }).click();
  await expect(page.getByText('Saved group-e2e as v2')).toBeVisible();
  const saved = await page.evaluate(async () => (await (await fetch('/api/workflows/group-e2e')).json()).text as string);
  expect(saved).toMatch(/parallel:\n\s+- id: lint\n\s+run: npm run lint\n\s+- id: build\n\s+run: npm test/);
  expect(saved).not.toMatch(/- id: build[\s\S]*- id: checks/);
});

test('an invariant-breaking builder change shows the server error and cannot be saved', async ({ page }) => {
  await openWorkflow(page, 'bound-e2e', GROUPED.replace('group-e2e', 'bound-e2e'));
  await page.getByLabel('Attempts max').fill('');
  await expect(page.getByRole('alert').filter({ hasText: 'Not saved' }).first()).toContainText('attempts.max');
  await expect(page.getByRole('button', { name: /^Save/ })).toBeDisabled();
});

test('a bundled workflow shows the blocks but offers no editing', async ({ page }) => {
  await page.goto('/');
  await page.locator('input[type="password"]').fill('verify-pass');
  await page.locator('button[type="submit"]').click();
  await page.waitForSelector('aside');
  await page.goto('/workflows');
  await page.locator('tbody tr', { hasText: 'implement' }).first().getByRole('button').first().click();
  const builder = page.getByRole('region', { name: 'Workflow builder' });
  await expect(builder.locator('[data-block]').first()).toBeVisible();
  await expect(builder.locator('[data-palette]')).toHaveCount(0);
  await expect(builder.getByRole('button', { name: /^Remove/ })).toHaveCount(0);
  await expect(builder.getByLabel('Attempts max')).toBeDisabled();
  await builder.locator('[data-block="steps/0"]').getByRole('button', { name: /rebase/ }).click();
  await expect(builder.getByText('Step ID')).toBeVisible();
  expect(await builder.locator('input:not([disabled]), select:not([disabled])').count()).toBe(0);
});

test('the builder matches the #929 mockup layout', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1800 });
  await openWorkflow(page, 'shot-e2e', GROUPED.replace('group-e2e', 'shot-e2e'));
  await page.locator('[data-block="steps/0/attempts/steps/0"]').getByRole('button').first().click();
  const builder = page.getByRole('region', { name: 'Workflow builder' });
  await expect(builder.getByText('WORKFLOW ACTIONS', { exact: false })).toBeVisible();
  await expect(builder.getByText('In sync with YAML')).toBeVisible();
  await expect(builder.locator('[data-block]')).toHaveCount(4);
  await builder.screenshot({ path: 'docs/mockups/workflows/screenshots/929-impl.png' });
});
