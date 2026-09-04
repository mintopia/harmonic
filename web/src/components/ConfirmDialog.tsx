import type { ReactNode } from 'react';
import { Modal } from './Modal';
import { btnAccept, btnDestructive, btnGhost, btnReview, panelTitle } from '../ui';

export type ConfirmTone = 'danger' | 'primary' | 'review';

const CONFIRM_TONE_CLASS: Record<ConfirmTone, string> = {
  danger: btnDestructive,
  primary: btnAccept,
  review: btnReview,
};

export function ConfirmDialog({
  label,
  title,
  children,
  confirmLabel,
  tone,
  onConfirm,
  onCancel,
}: {
  label: string;
  title: string;
  children?: ReactNode;
  confirmLabel: string;
  tone: ConfirmTone;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <Modal label={label} onClose={onCancel} className="max-w-md">
      <div className="p-5">
        <h2 className={`${panelTitle} mb-2 pr-6`}>{title}</h2>
        {children && <div className="text-muted">{children}</div>}
        <div className="mt-5 flex justify-end gap-2">
          <button type="button" className={`${btnGhost} px-3 py-1.5`} onClick={onCancel}>
            Cancel
          </button>
          <button type="button" className={CONFIRM_TONE_CLASS[tone]} onClick={onConfirm}>
            {confirmLabel}
          </button>
        </div>
      </div>
    </Modal>
  );
}
