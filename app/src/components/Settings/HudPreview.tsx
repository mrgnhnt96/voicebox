import { useEffect, useState } from 'react';
import { CapturePill, type PillState } from '@/components/CapturePill/CapturePill';
import { cn } from '@/lib/utils/cn';

const PILL_SEQUENCE: PillState[] = ['recording', 'transcribing', 'refining', 'rest'];
const PILL_DURATIONS: Partial<Record<PillState, number>> = {
  recording: 2600,
  transcribing: 1500,
  refining: 1500,
  rest: 900,
};

/**
 * The dictation HUD on a stand-in desktop, cycling through its states with a
 * sample voice so the user sees what appears while they hold the shortcut.
 */
export function HudPreview({ enabled }: { enabled: boolean }) {
  const [state, setState] = useState<PillState>('recording');
  const [tick, setTick] = useState(0);

  // Cycle recording → transcribing → refining → rest → …
  useEffect(() => {
    const t = window.setTimeout(() => {
      const next = PILL_SEQUENCE[(PILL_SEQUENCE.indexOf(state) + 1) % PILL_SEQUENCE.length];
      setState(next);
    }, PILL_DURATIONS[state] ?? 1000);
    return () => window.clearTimeout(t);
  }, [state]);

  // A sample voice for the level bars: syllables, then a short pause.
  useEffect(() => {
    if (state !== 'recording') return;
    setTick(0);
    const iv = window.setInterval(() => setTick((n) => n + 1), 50);
    return () => window.clearInterval(iv);
  }, [state]);

  const seconds = tick * 0.05;
  const sampleDb =
    seconds > 2
      ? -64
      : -40 + 30 * Math.abs(Math.sin(seconds * 7.3)) * (0.55 + 0.45 * Math.sin(seconds * 2.1));

  return (
    <div
      aria-hidden="true"
      className={cn(
        'flex h-12 w-[220px] items-end justify-center rounded-lg bg-secondary pb-2 transition-opacity',
        !enabled && 'opacity-50',
      )}
    >
      <CapturePill state={state} inputDb={sampleDb} />
    </div>
  );
}
