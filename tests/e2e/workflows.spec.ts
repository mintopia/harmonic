import { readFile } from 'node:fs/promises';
import { expect, test } from '@playwright/test';

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
