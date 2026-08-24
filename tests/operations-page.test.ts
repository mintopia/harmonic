import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { OperationsPage } from '../web/src/components/OperationsPage.js';

describe('OperationsPage', () => {
  it('provides independent labelled slots for scheduled jobs and live spans', () => {
    const html = renderToStaticMarkup(
      createElement(OperationsPage, {
        scheduledJobs: createElement('p', null, 'scheduled-jobs-slot'),
        spanTree: createElement('p', null, 'span-tree-slot'),
      }),
    );

    expect(html).toContain('<h1');
    expect(html).toContain('>Operations</h1>');
    expect(html).toContain('aria-labelledby="scheduled-jobs-heading"');
    expect(html).toContain('scheduled-jobs-slot');
    expect(html).toContain('aria-labelledby="span-tree-heading"');
    expect(html).toContain('span-tree-slot');
  });
});
