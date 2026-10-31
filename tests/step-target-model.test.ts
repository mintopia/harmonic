import { describe, expect, it } from 'vitest';
import { checkpointView, podStateView, stepTarget, targetSourceLabel } from '../web/src/step-target-model.js';

const out = (checkpoint?: { branch: string; sha: string | null; forced: boolean; unchanged?: boolean }) => ({ outputs: { stdout: '', exitCode: 0, ...(checkpoint ? { checkpoint } : {}) } });

describe('step target model', () => {
  it('shows no chip without an execution, local without a checkpoint, the target with one', () => {
    expect(stepTarget(out(), null)).toBeNull();
    expect(stepTarget(out(), { target: 'k8s-prod' })).toEqual({ kind: 'local' });
    expect(stepTarget(out({ branch: 'b', sha: null, forced: false }), { target: 'k8s-prod' })).toEqual({ kind: 'k8s', name: 'k8s-prod' });
  });

  it('shortens the sha and flags no-change and forced checkpoints', () => {
    expect(checkpointView(out())).toBeNull();
    expect(checkpointView(out({ branch: 'b', sha: '7be03d1aa0', forced: false, unchanged: false }))).toMatchObject({ sha: '7be03d1', noChanges: false });
    expect(checkpointView(out({ branch: 'b', sha: null, forced: false, unchanged: true }))).toMatchObject({ sha: null, noChanges: true });
    expect(checkpointView(out({ branch: 'b', sha: 'a41c9e2ff', forced: true, unchanged: false }))).toMatchObject({ forced: true, noChanges: false });
  });

  it('maps pod states and sources', () => {
    expect(podStateView('pending').tone).toBe('working');
    expect(podStateView('deleted')).toEqual({ label: 'Pod deleted', tone: 'off' });
    expect(podStateView('lost').tone).toBe('lost');
    expect(targetSourceLabel('step')).toBe('from step ');
  });
});

describe('checkpoint file count', () => {
  it('carries the file count when the engine reports one', () => {
    const view = checkpointView({ outputs: { stdout: '', exitCode: 0, checkpoint: { branch: 'b', sha: '7be03d1aa0', forced: false, unchanged: false, files: 6 } } });
    expect(view).toMatchObject({ files: 6 });
    expect(checkpointView({ outputs: { stdout: '', exitCode: 0, checkpoint: { branch: 'b', sha: null, forced: false } } })).toMatchObject({ files: null });
  });
});
