import { Check } from 'lucide-react';
import type * as React from 'react';
import { useTranslation } from 'react-i18next';
import { cn } from '@/lib/utils/cn';

export type StepState = 'done' | 'active' | 'todo';

interface SetupStepRowProps {
  number: number;
  title: string;
  /** One-line reason, shown while the step is collapsed and still to do. */
  why: string;
  state: StepState;
  /** Status word on the right of the active row ("downloading", "waiting"). */
  activeStatus?: string;
  /** The active step is already satisfied (the user came back to it). */
  satisfied?: boolean;
  onSelect: () => void;
  /** The expanded body, rendered only on the active row. */
  children?: React.ReactNode;
}

/** One step in the setup list: collapsed when done or to do, expanded when active. */
export function SetupStepRow({
  number,
  title,
  why,
  state,
  activeStatus,
  satisfied = false,
  onSelect,
  children,
}: SetupStepRowProps) {
  const { t } = useTranslation();

  if (state === 'active') {
    return (
      <section
        aria-current="step"
        className="flex flex-col gap-4 bg-card px-5 py-[18px] shadow-[inset_2px_0_0_hsl(var(--accent))]"
      >
        <div className="flex items-center gap-3.5">
          <StepMarker number={number} state={state} />
          <h2 className="flex-1 text-[15px] font-medium">{title}</h2>
          {satisfied ? (
            <span className="font-mono text-xs text-success">{t('setup.status.done')}</span>
          ) : activeStatus ? (
            <span className="font-mono text-xs text-accent">{activeStatus}</span>
          ) : null}
        </div>
        <div className="flex flex-col gap-3.5 pl-[38px]">{children}</div>
      </section>
    );
  }

  const done = state === 'done';
  return (
    <button
      type="button"
      onClick={onSelect}
      className="flex w-full items-center gap-3.5 px-5 py-4 text-left transition-colors hover:bg-muted/40 focus-visible:outline-none focus-visible:bg-muted/40 focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring"
    >
      <StepMarker number={number} state={state} />
      <span className="flex flex-1 flex-col gap-0.5">
        <span className={cn('text-[15px]', done && 'text-muted-foreground')}>{title}</span>
        {done ? null : <span className="text-xs text-muted-foreground">{why}</span>}
      </span>
      <span className={cn('font-mono text-xs', done ? 'text-success' : 'text-muted-foreground')}>
        {done ? t('setup.status.done') : t('setup.status.toDo')}
      </span>
    </button>
  );
}

function StepMarker({ number, state }: { number: number; state: StepState }) {
  if (state === 'done') {
    return (
      <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-success/15 text-success">
        <Check className="h-3 w-3" strokeWidth={3} aria-hidden />
      </span>
    );
  }
  return (
    <span
      className={cn(
        'flex h-6 w-6 shrink-0 items-center justify-center rounded-full border font-mono text-xs',
        state === 'active' ? 'border-accent text-accent' : 'border-input text-muted-foreground',
      )}
    >
      {number}
    </span>
  );
}
