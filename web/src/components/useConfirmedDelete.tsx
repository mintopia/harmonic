import { useState, type ReactNode } from 'react';
import { toastError } from '../toast';
import { ConfirmDialog } from './ConfirmDialog';

interface DialogCopy {
  label: string;
  title: string;
  confirmLabel: string;
  body: ReactNode;
}

export function useConfirmedDelete<T extends { id: number }>(
  remove: (id: number) => Promise<unknown>,
  onDone: (id: number) => unknown,
  copy: (target: T) => DialogCopy,
) {
  const [target, setTarget] = useState<T | null>(null);
  const text = target && copy(target);
  const dialog = target && text && (
    <ConfirmDialog
      label={text.label}
      title={text.title}
      confirmLabel={text.confirmLabel}
      tone="danger"
      onCancel={() => setTarget(null)}
      onConfirm={() => {
        const { id } = target;
        setTarget(null);
        remove(id).then(() => onDone(id)).catch(toastError);
      }}
    >
      {text.body}
    </ConfirmDialog>
  );
  return { ask: setTarget, dialog };
}
