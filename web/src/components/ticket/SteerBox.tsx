import { useRef, useState } from 'react';
import { api } from '../../api';
import { Icon } from '../Icon';
import { toastError } from '../../toast';
import type { PendingSteer } from './ChatTranscript';

function SteerBox({
  taskId,
  onPending,
  onFailed,
}: {
  taskId: number;
  onPending: (steer: PendingSteer) => void;
  onFailed: (id: number) => void;
}) {
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const nextSteerId = useRef(1);
  const send = async () => {
    const message = text.trim();
    if (!message || sending) return;
    const steer = { id: nextSteerId.current++, text: message, at: Date.now() };
    setSending(true);
    onPending(steer);
    try {
      await api.steerTask(taskId, message);
      setText('');
    } catch (err) {
      onFailed(steer.id);
      toastError(err);
    } finally {
      setSending(false);
    }
  };
  return (
    <div className="mt-3.5">
      <div className="flex items-center gap-2.5 rounded-md border border-edge bg-field py-2 pl-3.5 pr-2">
        <input
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              void send();
            }
          }}
          placeholder="Steer this attempt — send guidance to the live session…"
          aria-label="Steer this attempt"
          className="min-w-0 flex-1 bg-transparent text-ink outline-none placeholder:text-faint"
        />
        <button
          type="button"
          onClick={() => void send()}
          disabled={sending || text.trim().length === 0}
          aria-label="Send"
          className="grid size-8 shrink-0 place-items-center rounded-sm bg-accent text-on-accent transition-colors hover:opacity-90 disabled:opacity-50"
        >
          <Icon name="send" className="size-[15px]" />
        </button>
      </div>
      <div className="mt-2 text-[11.5px] text-faint">
        Session is warm — a message resumes this attempt and continues from here.
      </div>
    </div>
  );
}

export { SteerBox };
