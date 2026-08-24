import { createElement, Fragment } from 'react';

export function ReviewLiveRegions({
  polite,
  assertive,
}: {
  polite: string;
  assertive: string;
}) {
  return createElement(
    Fragment,
    null,
    createElement('div', { className: 'sr-only', 'aria-atomic': 'true', 'aria-live': 'polite' }, polite),
    createElement('div', { className: 'sr-only', 'aria-atomic': 'true', 'aria-live': 'assertive' }, assertive),
  );
}
