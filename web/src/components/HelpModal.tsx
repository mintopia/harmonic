import { Modal } from './Modal';
import { panelTitle } from '../ui';

const STEPS = [
  { title: 'Create a task', body: 'Describe the work and point it at a repo on this machine.' },
  { title: 'Run it', body: 'Press Run now, or turn the auto-runner on to start ready tasks for you.' },
  { title: 'Watch it merge', body: "The agent's steps stream live; verified work merges on its own, and only an escalated ticket asks for you." },
];

export function HelpModal({ onClose }: { onClose: () => void }) {
  return (
    <Modal label="How Harmonic works" onClose={onClose} className="max-w-md">
      <div className="p-5">
        <h2 className={`${panelTitle} mb-4`}>How Harmonic works</h2>
        <ol className="flex flex-col gap-3.5 text-left">
          {STEPS.map((s, i) => (
            <li key={s.title} className="flex gap-3">
              <span className="mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full bg-raised text-label font-bold text-muted">
                {i + 1}
              </span>
              <span>
                <span className="font-semibold text-ink">{s.title}</span> <span className="text-muted">— {s.body}</span>
              </span>
            </li>
          ))}
        </ol>
      </div>
    </Modal>
  );
}
