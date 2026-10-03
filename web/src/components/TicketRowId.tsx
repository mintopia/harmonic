import type { Task } from '../types';
import { issueRef, taskKey } from '../id-format';

export function TicketRowId({ task }: { task: Pick<Task, 'id' | 'trackerRef' | 'url'> }) {
  if (task.trackerRef == null) return <>{taskKey(task.id)}</>;
  const ref = issueRef(task.trackerRef);
  return (
    <>
      {task.url ? (
        <a href={task.url} target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()} className="underline-offset-2 hover:underline">
          {ref}
        </a>
      ) : (
        ref
      )}
      {` · ${taskKey(task.id)}`}
    </>
  );
}
