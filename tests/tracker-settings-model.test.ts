import { describe, expect, it } from 'vitest';
import {
  REPOSITORY_KINDS,
  REPOSITORY_LABEL,
  RESOLVE_FAILURE_LABEL,
  applyTrackerSetting,
  applyTriageLabel,
  parseCodeRepositoryOverride,
  triageLabelSource,
  trackerStripRules,
} from '../web/src/tracker-settings-model.js';

describe('applyTrackerSetting', () => {
  it('merges a key into existing settings', () => {
    expect(applyTrackerSetting('jira', { site: 'a' }, 'project', 'P')).toEqual({ kind: 'jira', settings: { site: 'a', project: 'P' } });
  });

  it('removes a key set to undefined and keeps the others', () => {
    expect(applyTrackerSetting('jira', { site: 'a', project: 'P' }, 'project', undefined)).toEqual({ kind: 'jira', settings: { site: 'a' } });
  });

  it('omits settings entirely once the last key is removed', () => {
    expect(applyTrackerSetting('jira', { site: 'a' }, 'site', undefined)).toEqual({ kind: 'jira' });
  });

  it('starts from nothing and never mutates its input', () => {
    const current = { site: 'a' };
    expect(applyTrackerSetting('jira', undefined, 'site', 'b')).toEqual({ kind: 'jira', settings: { site: 'b' } });
    applyTrackerSetting('jira', current, 'site', undefined);
    expect(current).toEqual({ site: 'a' });
  });
});

describe('applyTriageLabel', () => {
  it('sets a role', () => {
    expect(applyTriageLabel(null, 'epic', 'big')).toEqual({ epic: 'big' });
  });

  it('drops a role cleared to an empty string', () => {
    expect(applyTriageLabel({ epic: 'big', readyForAgent: 'go' }, 'epic', '')).toEqual({ readyForAgent: 'go' });
  });

  it('collapses to null when no role remains', () => {
    expect(applyTriageLabel({ epic: 'big' }, 'epic', '')).toBeNull();
  });
});

describe('code repository kinds', () => {
  it('derives the kind list from the label table', () => {
    expect([...REPOSITORY_KINDS]).toEqual(Object.keys(REPOSITORY_LABEL));
  });

  it('narrows known kinds and maps anything else to automatic', () => {
    expect(parseCodeRepositoryOverride('gitlab')).toBe('gitlab');
    expect(parseCodeRepositoryOverride('')).toBeNull();
    expect(parseCodeRepositoryOverride('toString')).toBeNull();
  });
});

describe('RESOLVE_FAILURE_LABEL', () => {
  it('covers every failure code with a Tracker-capitalised label', () => {
    expect(Object.keys(RESOLVE_FAILURE_LABEL).sort()).toEqual(['misconfigured', 'no-declaration', 'unsupported']);
  });
});

describe('triageLabelSource', () => {
  it('prefers the Configured label, then the repo doc, then the default', () => {
    expect(triageLabelSource('epic', { epic: 'x' }, { epic: 'y' })).toBe('configured');
    expect(triageLabelSource('epic', null, { epic: 'y' })).toBe('repo-doc');
    expect(triageLabelSource('epic', { readyForAgent: 'x' }, {})).toBe('default');
    expect(triageLabelSource('epic', null, undefined)).toBe('default');
  });
});

describe('trackerStripRules', () => {
  const resolved = (source: 'configured' | 'detected' | 'code-repository') =>
    ({ ok: true, label: 'GitHub Issues', kind: 'github', source, code: null, reason: null }) as const;
  const inUse = (source: 'configured' | 'detected' | 'code-repository') =>
    trackerStripRules(resolved(source)).map((r) => (r.always ? r.caption : null));

  it('marks only the rung that resolved', () => {
    expect(inUse('configured')).toEqual(['1st · in use', null, null]);
    expect(inUse('detected')).toEqual([null, '2nd · in use', null]);
    expect(inUse('code-repository')).toEqual([null, null, '3rd · in use']);
  });

  it('names the resolved tracker on the used rung and marks none when unresolved', () => {
    expect(trackerStripRules(resolved('detected'))[1]?.note).toBe('GitHub Issues');
    expect(trackerStripRules(null).some((r) => r.always)).toBe(false);
    const failed = { ok: false, label: null, kind: null, source: null, code: 'no-declaration', reason: 'x' } as const;
    expect(trackerStripRules(failed).some((r) => r.always)).toBe(false);
  });
});
