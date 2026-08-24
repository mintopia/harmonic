import { createElement, type ReactNode } from 'react';
import { displayTitle, sectionTitle } from '../ui.js';

export interface OperationsPageProps {
  scheduledJobs?: ReactNode;
  spanTree?: ReactNode;
}

/**
 * Empty Operations host. Each section is deliberately independent so its
 * feature can arrive without coupling the shell to a telemetry read model.
 */
export function OperationsPage({ scheduledJobs, spanTree }: OperationsPageProps) {
  return createElement(
    'div',
    null,
    createElement('h1', { className: `${displayTitle} mb-5` }, 'Operations'),
    createElement(
      'div',
      { className: 'grid gap-4' },
      createElement(
        'section',
        { 'aria-labelledby': 'scheduled-jobs-heading' },
        createElement('h2', { id: 'scheduled-jobs-heading', className: sectionTitle }, 'Scheduled jobs'),
        scheduledJobs,
      ),
      createElement(
        'section',
        { 'aria-labelledby': 'span-tree-heading' },
        createElement('h2', { id: 'span-tree-heading', className: sectionTitle }, 'Live spans'),
        spanTree,
      ),
    ),
  );
}
