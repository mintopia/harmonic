import type { AsyncDbHandle } from '../db/async.js';
import type { AppOptions } from './app-context.js';
import { SettingsStore } from './settings-store.js';
import { TaskService } from '../domain/tasks.js';
import { AttemptStore } from '../domain/attempts.js';
import { EpicMergeEventStore } from '../domain/epic-merge-events.js';
import { ConversationStore } from '../domain/conversations.js';
import { WorkspaceService } from '../domain/workspaces.js';
import { PermissionRuleStore } from '../domain/permission-rules.js';
import { SessionStore } from '../domain/sessions.js';
import { GuardrailEventStore } from '../domain/guardrail-events.js';
import { VerificationAttemptStore } from '../domain/verification-attempts.js';
import { logger } from '../logger.js';
import { ChannelService } from '../notifications/channels.js';
import { Notifier } from '../notifications/notifier.js';
import { AuthService } from './auth.js';
import { EventBus } from './bus.js';
import { fireAndForget } from '../error-handling.js';

export interface Stores {
  settingsStore: SettingsStore;
  workspaces: WorkspaceService;
  channels: ChannelService;
  notifier: Notifier;
  tasks: TaskService;
  attempts: AttemptStore;
  epicMergeEvents: EpicMergeEventStore;
  guardrailEvents: GuardrailEventStore;
  verificationAttempts: VerificationAttemptStore;
  conversations: ConversationStore;
  permissionRules: PermissionRuleStore;
  auth: AuthService;
  sessions: SessionStore;
}

export interface CreateStoresDeps {
  opts: Pick<AppOptions, 'dataDir' | 'configOverrides' | 'password'>;
  asyncDb: AsyncDbHandle;
  bus: EventBus;
}

export async function createStores({ opts, asyncDb, bus }: CreateStoresDeps): Promise<Stores> {
  const settingsStore = await SettingsStore.create(opts.dataDir, opts.configOverrides);
  const workspaces = new WorkspaceService(asyncDb, settingsStore);
  const channels = new ChannelService(asyncDb);
  const notifier = new Notifier(channels, logger.error);
  const tasks = new TaskService(
    asyncDb,
    () => settingsStore.getGlobal(),
    () => workspaces.list(),
    (task) => bus.emit('task_changed', task),
    (event, task) =>
      fireAndForget(() => notifier.notify(event, task), { op: 'notifier.notify', level: 'warn', context: { event, taskId: task.id } }),
    (id) => bus.emit('task_removed', { id }),
  );
  const attempts = new AttemptStore(asyncDb);
  const epicMergeEvents = new EpicMergeEventStore(asyncDb);
  const guardrailEvents = new GuardrailEventStore(asyncDb);
  const verificationAttempts = new VerificationAttemptStore(asyncDb);
  const conversations = new ConversationStore(asyncDb, (conversation) => bus.emit('conversation_changed', conversation));
  const permissionRules = new PermissionRuleStore(asyncDb);
  const auth = new AuthService(asyncDb);
  if (opts.password !== undefined) {
    if (opts.password === '') await auth.clearPassword();
    else await auth.setPassword(opts.password);
  }
  const sessions = new SessionStore(asyncDb);
  return {
    settingsStore,
    workspaces,
    channels,
    notifier,
    tasks,
    attempts,
    epicMergeEvents,
    guardrailEvents,
    verificationAttempts,
    conversations,
    permissionRules,
    auth,
    sessions,
  };
}
