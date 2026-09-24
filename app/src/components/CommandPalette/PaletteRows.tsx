import { cn } from '@/lib/utils/cn';
import { formatAbsoluteDate } from '@/lib/utils/format';
import { type CaptureMatch, formatDuration, splitMatches } from './captureSearch';
import type { PaletteCommand } from './usePaletteCommands';

interface RowProps {
  id: string;
  selected: boolean;
  onHover: () => void;
  onChoose: () => void;
}

// Rows are options of the input's listbox: focus stays in the input, so
// they're out of the tab order and the pointer only moves the highlight.
const rowBase =
  'w-full rounded-lg px-3 text-left text-foreground transition-colors focus-visible:outline-none';
const rowSelected = 'bg-secondary shadow-[inset_2px_0_0_hsl(var(--accent))]';

/** A capture result: the transcript with matches marked, then mono meta. */
export function PaletteCaptureRow({
  id,
  match,
  query,
  selected,
  onHover,
  onChoose,
}: RowProps & { match: CaptureMatch; query: string }) {
  const { capture, snippet } = match;
  const meta = [
    formatAbsoluteDate(capture.created_at),
    capture.source,
    formatDuration(capture.duration_ms),
  ].filter(Boolean);

  return (
    <button
      type="button"
      id={id}
      role="option"
      aria-selected={selected}
      tabIndex={-1}
      onMouseMove={onHover}
      onClick={onChoose}
      className={cn(rowBase, 'flex flex-col gap-1 py-2.5', selected && rowSelected)}
    >
      <span className="line-clamp-2 text-sm">
        {splitMatches(snippet, query).map((part, i) =>
          part.hit ? (
            // biome-ignore lint/suspicious/noArrayIndexKey: parts are positional and never reorder
            <mark key={i} className="rounded-sm bg-accent/25 text-foreground">
              {part.text}
            </mark>
          ) : (
            // biome-ignore lint/suspicious/noArrayIndexKey: parts are positional and never reorder
            <span key={i}>{part.text}</span>
          ),
        )}
      </span>
      <span className="font-mono text-[11px] text-muted-foreground">{meta.join(' · ')}</span>
    </button>
  );
}

/** A command: label on the left, a short mono hint on the right. */
export function PaletteCommandRow({
  id,
  command,
  selected,
  onHover,
  onChoose,
}: RowProps & { command: PaletteCommand }) {
  return (
    <button
      type="button"
      id={id}
      role="option"
      aria-selected={selected}
      tabIndex={-1}
      onMouseMove={onHover}
      onClick={onChoose}
      className={cn(
        rowBase,
        'flex h-10 items-center gap-3 text-sm text-foreground/85',
        selected && rowSelected,
      )}
    >
      <span className="flex-1">{command.label}</span>
      <span className="font-mono text-[11px] text-muted-foreground">{command.hint}</span>
    </button>
  );
}
