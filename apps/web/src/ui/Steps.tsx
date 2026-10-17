import { Check, X } from 'lucide-react';
import type { ReactNode } from 'react';

// A list of steps with their state (Cover and exclude): done with a check, the current one with
// a ring, failed with a cross; and a progress bar (track --bg-fill, filled --accent).

export type StepState = 'done' | 'active' | 'todo' | 'failed';

export function Steps({ steps }: { steps: readonly { label: ReactNode; state: StepState }[] }) {
  return (
    <ol className="space-y-3">
      {steps.map((s, i) => (
        <li
          key={i}
          className="flex min-h-8 items-center gap-3"
          aria-current={s.state === 'active' ? 'step' : undefined}
        >
          <StepIcon state={s.state} />
          <span
            className={`text-body ${s.state === 'todo' ? 'text-label-3' : s.state === 'active' ? 'font-semibold text-accent-text' : 'text-label'}`}
          >
            {s.label}
          </span>
        </li>
      ))}
    </ol>
  );
}

function StepIcon({ state }: { state: StepState }) {
  if (state === 'done')
    return (
      <span
        className="grid size-7 place-items-center rounded-full bg-positive text-on-positive"
        aria-label="done"
      >
        <Check size={16} strokeWidth={2.25} />
      </span>
    );
  if (state === 'failed')
    return (
      <span
        className="grid size-7 place-items-center rounded-full bg-danger-soft text-danger"
        aria-label="failed"
      >
        <X size={16} strokeWidth={2.25} />
      </span>
    );
  if (state === 'active')
    return (
      <span
        className="size-7 animate-spin rounded-full border-2 border-accent-text border-t-transparent motion-reduce:animate-none"
        aria-label="in progress"
      />
    );
  return <span className="size-7 rounded-full border border-separator" aria-label="to do" />;
}

export function ProgressBar({ value, label }: { value: number; label: string }) {
  const pct = Math.max(0, Math.min(100, Math.round(value * 100)));
  return (
    <div
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={pct}
      className="h-1.5 overflow-hidden rounded-full bg-bg-fill"
    >
      <div
        className="h-full rounded-full bg-accent transition-[width] duration-500"
        style={{ width: `${pct}%` }}
      />
    </div>
  );
}
