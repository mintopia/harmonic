import { describe, expect, it } from 'vitest';
import {
  addPendingElicitation,
  removePendingElicitation,
  resolvePendingElicitationFromEvent,
  type PendingElicitations,
} from '../web/src/conversation-elicitations-model.js';
import type { ConversationEvent, ElicitationFormRequest } from '../web/src/types.js';

const request: ElicitationFormRequest = {
  message: 'Pick one',
  fields: [{ key: 'question_0', kind: 'select', optional: true, options: [{ value: 'a', label: 'A' }] }],
};

const evt = (type: ConversationEvent['type'], payload: unknown): Pick<ConversationEvent, 'type' | 'payload'> => ({ type, payload });

describe('addPendingElicitation / removePendingElicitation', () => {
  it('adds a question keyed by reqId', () => {
    const pending = addPendingElicitation({}, { conversationId: 1, reqId: 'elicit-1', request });
    expect(pending).toEqual({ 'elicit-1': { reqId: 'elicit-1', conversationId: 1, request } });
  });

  it('removes a question by reqId', () => {
    const pending: PendingElicitations = { 'elicit-1': { reqId: 'elicit-1', conversationId: 1, request } };
    expect(removePendingElicitation(pending, 'elicit-1')).toEqual({});
  });

  it('removing an unknown reqId returns the same reference', () => {
    const pending: PendingElicitations = {};
    expect(removePendingElicitation(pending, 'nope')).toBe(pending);
  });
});

describe('resolvePendingElicitationFromEvent', () => {
  it('clears the matching pending question when its resolution event merges', () => {
    const pending = addPendingElicitation({}, { conversationId: 1, reqId: 'elicit-1', request });
    const resolved = resolvePendingElicitationFromEvent(
      pending,
      evt('elicitation_request', { request, answer: { action: 'decline' }, reqId: 'elicit-1' }),
    );
    expect(resolved).toEqual({});
  });

  it('ignores unrelated event types', () => {
    const pending = addPendingElicitation({}, { conversationId: 1, reqId: 'elicit-1', request });
    expect(resolvePendingElicitationFromEvent(pending, evt('session_update', { reqId: 'elicit-1' }))).toBe(pending);
  });

  it('ignores a resolution event without a reqId', () => {
    const pending = addPendingElicitation({}, { conversationId: 1, reqId: 'elicit-1', request });
    expect(resolvePendingElicitationFromEvent(pending, evt('elicitation_request', {}))).toBe(pending);
  });
});
