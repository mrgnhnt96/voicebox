import { motion } from 'framer-motion';
import { useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { cn } from '@/lib/utils/cn';
import { barHeights, isClipping, LEVEL_FALL_MS, LEVEL_RISE_MS, levelFromDb } from './level';

/**
 * Pill state machine shared between the settings preview and the live
 * recording pill in the Captures tab.
 */
export type PillState = 'preparing' | 'recording' | 'transcribing' | 'refining' | 'rest' | 'error';

const PILL_LABEL_KEYS: Record<Exclude<PillState, 'error'>, string> = {
  preparing: 'captures.pill.preparing',
  recording: 'captures.pill.recording',
  transcribing: 'captures.pill.transcribing',
  refining: 'captures.pill.refining',
  rest: 'captures.pill.completed',
};

/** How long the "pasted" dot stays before the HUD fades out. */
const REST_FADE_S = 0.9;

const CAPSULE =
  'inline-flex h-6 min-w-16 items-center justify-center gap-[3px] rounded-full px-2.5 ' +
  'bg-black/90 ring-1 ring-white/10 shadow-lg shadow-black/40';

/**
 * The dictation HUD: a 64 × 24 capsule with no words. Shape and motion show
 * the stage; only an error shows text. While recording, the bars follow the
 * microphone's input level (`inputDb`) and lie flat when nothing is heard.
 */
export function CapturePill({
  state,
  inputDb,
  onStop,
  errorMessage,
  onDismiss,
  className,
}: {
  state: PillState;
  /** Latest input loudness in dBFS while recording; `null` before the first reading. */
  inputDb?: number | null;
  onStop?: () => void;
  errorMessage?: string | null;
  onDismiss?: () => void;
  className?: string;
}) {
  const { t } = useTranslation();

  if (state === 'error') {
    return (
      <ErrorPill
        message={errorMessage ?? t('captures.pill.errorFallback')}
        onDismiss={onDismiss}
        className={className}
      />
    );
  }

  const label = t(PILL_LABEL_KEYS[state]);
  const marks = <PillMarks state={state} inputDb={inputDb ?? null} />;

  if (state === 'recording' && onStop) {
    return (
      <button
        type="button"
        onClick={onStop}
        aria-label={t('captures.pill.stopAria')}
        className={cn(
          CAPSULE,
          'focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/60',
          className,
        )}
      >
        {marks}
      </button>
    );
  }

  return (
    <motion.div
      role="status"
      aria-label={label}
      className={cn(CAPSULE, className)}
      initial={false}
      animate={{ opacity: state === 'rest' ? 0 : 1 }}
      transition={
        state === 'rest'
          ? { duration: 0.3, delay: REST_FADE_S - 0.3, ease: 'easeIn' }
          : { duration: 0.15 }
      }
    >
      {marks}
    </motion.div>
  );
}

function PillMarks({ state, inputDb }: { state: PillState; inputDb: number | null }) {
  switch (state) {
    case 'preparing':
      return (
        <>
          {[0, 1, 2, 3, 4].map((i) => (
            <span key={i} className="h-[3px] w-[3px] rounded-full bg-white/25" />
          ))}
        </>
      );
    case 'recording':
      return <LevelBars db={inputDb} />;
    case 'transcribing':
      return <PulsingDots className="bg-white/70" />;
    case 'refining':
      return <PulsingDots className="bg-accent" />;
    default:
      return <span className="h-1 w-1 rounded-full bg-emerald-400" />;
  }
}

/** Five bars whose height is the input level, shaped around the center. */
function LevelBars({ db }: { db: number | null }) {
  const level = levelFromDb(db);
  const previous = useRef(level);
  const rising = level >= previous.current;
  useEffect(() => {
    previous.current = level;
  });
  const clipping = isClipping(db);
  return (
    <>
      {barHeights(level).map((height, i) => (
        <span
          // biome-ignore lint/suspicious/noArrayIndexKey: fixed set of five bars
          key={i}
          className={cn('w-[3px] rounded-full', clipping ? 'bg-orange-400' : 'bg-accent')}
          style={{
            height,
            transition: `height ${rising ? LEVEL_RISE_MS : LEVEL_FALL_MS}ms linear`,
          }}
        />
      ))}
    </>
  );
}

function PulsingDots({ className }: { className: string }) {
  return (
    <>
      {[0, 1, 2].map((i) => (
        <motion.span
          key={i}
          className={cn('h-1 w-1 rounded-full', className)}
          animate={{ opacity: [0.25, 1, 0.25] }}
          transition={{ duration: 1.2, repeat: Infinity, delay: i * 0.2, ease: 'easeInOut' }}
        />
      ))}
    </>
  );
}

function ErrorPill({
  message,
  onDismiss,
  className,
}: {
  message: string;
  onDismiss?: () => void;
  className?: string;
}) {
  const { t } = useTranslation();
  const handleClick = async () => {
    try {
      await navigator.clipboard.writeText(message);
    } catch {
      // Clipboard access can be denied in rare webview configs — ignore,
      // we still want the dismiss to land.
    }
    onDismiss?.();
  };

  return (
    <button
      type="button"
      onClick={handleClick}
      title={t('captures.pill.errorCopyTooltip')}
      className={cn(
        'inline-flex h-6 max-w-[380px] items-center gap-2 rounded-full px-2.5',
        'bg-black/90 ring-1 ring-red-400/40 shadow-lg shadow-black/40 hover:bg-black',
        'focus:outline-none focus-visible:ring-2 focus-visible:ring-red-400/60',
        className,
      )}
    >
      <span className="h-1 w-1 shrink-0 rounded-full bg-red-400" />
      <span className="truncate text-[11px] font-medium text-red-300">{message}</span>
    </button>
  );
}
