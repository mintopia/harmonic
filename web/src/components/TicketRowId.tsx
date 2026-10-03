import type { Task } from '../types';
import { TICKET_ROW_SEPARATOR, ticketRowParts } from '../id-format';

export function TicketRowId({ task }: { task: Pick<Task, 'id' | 'trackerRef' | 'url'> }) {
  const { ref, key } = ticketRowParts(task.id, task.trackerRef);
  if (ref === null) return <>{key}</>;
  return (
    <>
      {task.url ? (
        <a href={task.url} target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()} className="underline-offset-2 hover:underline">
          {ref}
        </a>
      ) : (
        ref
      )}
      {`${TICKET_ROW_SEPARATOR}${key}`}
    </>
  );
}
