import { adapterFor } from './harness/registry.js';
import { toolCallName, activityLine } from './usage.js';
import { parsePermissionRequest } from '../acp/permission-request.js';
import { toProgressEvents } from '../domain/guardrail-progress.js';
import type { ProgressEvent } from '../domain/stall-detector.js';
import { LIVE_RUN_LOG_EVENT_ID_OFFSET } from './live-events.js';
import { logger } from '../logger.js';
import type { AcpDriver, AcpInitializeResult } from '../acp/driver.js';
import type { TaskRow, AttemptRow } from '../db/schema.js';
import type { ActiveRun } from './active-runs.js';
import type { GuardrailSupervisor } from './guardrail-supervisor.js';
import type { RunnerEvents } from './runner.js';

/** State owned by one drive, released when that drive ends. */
export class TurnState {
  sessionInit: AcpInitializeResult | undefined;
  sessionRowId: number | undefined;
  toolCallFlushTimer: ReturnType<typeof setInterval> | undefined;

  constructor(
    readonly attemptAtStart: AttemptRow,
    readonly toolCalls: Map<string, number>,
    readonly progressEvents: ProgressEvent[],
  ) {}

  clearTimer(): void {
    if (this.toolCallFlushTimer) clearInterval(this.toolCallFlushTimer);
    this.toolCallFlushTimer = undefined;
  }
}

interface TurnListenerRuntime {
  active: ActiveRun;
  driver: AcpDriver;
  guardrails: GuardrailSupervisor;
}

/** ACP callbacks for a single drive. Runner owns the reconnect-visible maps. */
export class TurnListeners {
  private runtime: TurnListenerRuntime | undefined;
  stoppedShort: string | null = null;

  constructor(
    private readonly input: {
      task: TaskRow;
      run: AttemptRow;
      state: TurnState;
      autoDriven: boolean;
      events: RunnerEvents;
      record: (type: 'permission_request' | 'lifecycle', payload: unknown) => void;
      nextProgressSequence: () => number;
      outstandingAction: (event: ProgressEvent) => void;
      completeOutstandingAction: (event: ProgressEvent) => void;
    },
  ) {}

  setRuntime(runtime: TurnListenerRuntime): void {
    this.runtime = runtime;
  }

  onInitialize = (result: AcpInitializeResult): void => {
    this.input.state.sessionInit = result;
  };

  onSessionUpdate = (update: { sessionUpdate: string; [key: string]: unknown }, replay: boolean): void => {
    if (replay) return;
    const runtime = this.runtime;
    const { task, run, state } = this.input;
    const seq = this.input.nextProgressSequence();
    this.input.events.onAttemptLogEvent?.({
      id: LIVE_RUN_LOG_EVENT_ID_OFFSET + seq,
      attemptId: run.id,
      seq,
      ts: Date.now(),
      type: 'session_update',
      payload: update,
    });
    const progress = toProgressEvents([{ seq, type: 'session_update', payload: update }]);
    if (progress.length > 0) {
      const event = progress[0]!;
      if (event.kind === 'action') this.input.outstandingAction(event);
      else if (event.kind === 'result' || event.kind === 'error') this.input.completeOutstandingAction(event);
      state.progressEvents.push(event);
      if (state.progressEvents.length > 64) state.progressEvents.shift();
    }
    const line = activityLine(update);
    if (line && runtime) runtime.active.activity = line;
    if (update.sessionUpdate === 'tool_call') {
      const name = toolCallName(update, (payload) => adapterFor(task.harness).usage?.toolName(payload) ?? null);
      state.toolCalls.set(name, (state.toolCalls.get(name) ?? 0) + 1);
    }
    runtime?.guardrails.observeTool(update);
  };

  onRequest = async (method: string, params: unknown): Promise<unknown> => {
    if (method !== 'session/request_permission') return null;
    const request = parsePermissionRequest(params);
    if (!request) {
      logger.warn('acp: rejected malformed permission request', { attemptId: this.input.run.id });
      return { outcome: 'cancelled' };
    }
    const options = request.options;
    const grant = () => {
      const pick =
        options.find((option) => option.kind === 'allow_always') ??
        options.find((option) => option.kind === 'allow_once') ??
        options[0];
      const outcome = pick ? { outcome: 'selected', optionId: pick.optionId } : { outcome: 'cancelled' };
      this.input.record('permission_request', { request, outcome });
      return { outcome };
    };
    if (!this.input.autoDriven) return grant();
    this.stoppedShort = `permission request declined (no human on this turn): ${request.toolCall.title ?? 'permission request'}`;
    const outcome = { outcome: 'cancelled' };
    this.input.record('permission_request', { request, outcome });
    this.runtime?.driver.cancel();
    return { outcome };
  };
}
