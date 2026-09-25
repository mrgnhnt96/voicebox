import { ChevronRight, CircleHelp, Copy, Pencil } from 'lucide-react';
import { type ReactNode, useEffect, useId, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { useToast } from '@/components/ui/use-toast';
import { cn } from '@/lib/utils/cn';
import {
  EditableTranscript,
  LearnedNotice,
  TeachActions,
  type TeachState,
} from './TeachCorrection';
import {
  countWords,
  type DiffSegment,
  diffWords,
  type MergedSegment,
  summarizeChanges,
} from './wordDiff';

const MARK_CLASS: Record<MergedSegment['kind'] | 'corrected', string> = {
  same: '',
  removed: 'bg-destructive/15 text-destructive line-through rounded-sm',
  added: 'bg-accent/20 text-foreground rounded-sm px-0.5',
  corrected: 'bg-success/15 rounded-sm px-0.5',
};

function Marked({ segments, mark }: { segments: DiffSegment[]; mark: 'corrected' }) {
  return (
    <>
      {segments.map((segment, i) => (
        // Segments have no identity beyond their position in the text.
        // biome-ignore lint/suspicious/noArrayIndexKey: position is the identity
        <span key={i} className={segment.changed ? MARK_CLASS[mark] : undefined}>
          {segment.text}
        </span>
      ))}
    </>
  );
}

/** Short text is set large and long text smaller, so the card reads well either way. */
function textSize(words: number): string {
  if (words <= 6) return 'text-[26px] leading-[1.25]';
  if (words <= 25) return 'text-xl leading-[1.55]';
  return 'text-base leading-[1.6]';
}

function CopyButton({
  text,
  label,
  className,
}: {
  text: string;
  label: string;
  className?: string;
}) {
  const { t } = useTranslation();
  const { toast } = useToast();
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      toast({ title: t('captures.toast.transcriptCopied') });
    } catch {
      toast({ title: t('captures.toast.copyFailed'), variant: 'destructive' });
    }
  };
  return (
    <Button
      variant="ghost"
      size="icon"
      className={cn('h-7 w-7', className)}
      onClick={copy}
      aria-label={label}
      title={label}
    >
      <Copy className="size-3.5!" />
    </Button>
  );
}

/**
 * The text the capture delivered: the refined transcript, or the raw one
 * when there's no refinement. Clicking it (or Alter) edits it in place to
 * teach Voicebox; after saving, it shows the correction with its changes.
 */
export function TranscriptCard({ refined, teach }: { refined: boolean; teach: TeachState }) {
  const { t } = useTranslation();
  const [explained, setExplained] = useState(false);
  const aboutId = useId();
  // The explanation makes way for the edit, and stays closed after it.
  const editing = teach.draft !== null;
  useEffect(() => {
    if (editing) setExplained(false);
  }, [editing]);
  const { learned, original } = teach;
  const shown = learned?.expected_text ?? original;
  const corrected = useMemo(
    () => (learned ? diffWords(original, learned.expected_text).after : null),
    [learned, original],
  );
  const textClass = cn(textSize(countWords(shown)), 'font-medium text-foreground');
  const label = t(refined ? 'captures.transcript.refined' : 'captures.transcript.raw');

  return (
    <section
      aria-label={label}
      className="flex flex-1 min-h-[50%] overflow-y-auto flex-col gap-4 rounded-xl border border-accent/30 bg-accent/[0.045] px-5 pt-4 pb-6"
    >
      <div className="flex items-center gap-2">
        <span className="font-mono text-[11px] uppercase tracking-wider text-accent">{label}</span>
        {learned && (
          <span className="inline-flex h-[18px] items-center rounded-full bg-success/15 px-1.5 font-mono text-[10px] text-success">
            {t('captures.teach.correctedByYou')}
          </span>
        )}
        <span className="flex-1" />
        {!learned && !editing && (
          <>
            <Button
              variant="ghost"
              size="icon"
              className={cn('h-7 w-7 text-muted-foreground', explained && 'text-foreground')}
              aria-label={t('captures.feedback.about')}
              title={t('captures.feedback.about')}
              aria-expanded={explained}
              aria-controls={aboutId}
              onClick={() => setExplained((open) => !open)}
            >
              <CircleHelp className="size-3.5!" />
            </Button>
            <Button
              variant="outline"
              size="sm"
              className="h-7 gap-1.5 px-2.5 text-xs border-accent/45 bg-accent/10 text-accent hover:bg-accent/15 hover:text-accent"
              onClick={teach.begin}
            >
              <Pencil className="size-3!" />
              {t('captures.teach.alter')}
            </Button>
          </>
        )}
        <CopyButton text={shown} label={t('captures.panel.copy')} />
      </div>
      {explained && (
        <p id={aboutId} className="m-0 -mt-1 text-xs leading-relaxed text-muted-foreground">
          {t('captures.feedback.description')}
        </p>
      )}
      {learned ? (
        <p className={cn('m-0 whitespace-pre-wrap break-words', textClass)}>
          {corrected ? <Marked segments={corrected} mark="corrected" /> : shown}
        </p>
      ) : (
        <EditableTranscript teach={teach} className={textClass}>
          {shown || (
            <span className="text-base text-muted-foreground">{t('captures.snippetEmpty')}</span>
          )}
        </EditableTranscript>
      )}
      {learned ? <LearnedNotice teach={teach} /> : editing && <TeachActions teach={teach} />}
    </section>
  );
}

function Disclosure({
  title,
  open,
  onToggle,
  controls,
  action,
  className,
}: {
  title: string;
  open: boolean;
  onToggle: () => void;
  controls: string;
  action?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn('flex items-center gap-2', className)}>
      <button
        type="button"
        aria-expanded={open}
        aria-controls={controls}
        onClick={onToggle}
        className="flex h-7 flex-1 items-center gap-2 text-left text-[13px] text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring rounded-sm"
      >
        <ChevronRight
          className={cn(
            'size-3.5 shrink-0 text-muted-foreground transition-transform',
            open && 'rotate-90',
          )}
        />
        {title}
      </button>
      {action}
    </div>
  );
}

/**
 * What refinement changed, collapsed to a row of chips; opened, one run of
 * the raw text with the words taken out struck and the words put in marked.
 * With no changes it is just a line saying so.
 */
export function ChangesDisclosure({ raw, refined }: { raw: string; refined: string }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const panelId = useId();
  const diff = useMemo(() => diffWords(raw, refined), [raw, refined]);
  const summary = summarizeChanges(diff);
  const chips = (
    [
      ['removed', summary.removed],
      ['added', summary.added],
      ['reworded', summary.reworded],
      ['case', summary.case],
      ['punctuation', summary.punctuation],
    ] as const
  )
    .filter(([, count]) => count > 0)
    .map(([kind, count]) => t(`captures.changes.${kind}`, { count }));

  // Nothing to open when refinement left the text as it was.
  if (!chips.length) {
    return (
      <p className="m-0 flex h-7 items-center py-2.5 pl-[22px] text-[13px] text-muted-foreground box-content">
        {t('captures.changes.none')}
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-1.5 py-2.5">
      <Disclosure
        title={t('captures.changes.title')}
        open={open}
        onToggle={() => setOpen((o) => !o)}
        controls={panelId}
      />
      <div className="flex flex-wrap gap-1 pl-[22px]">
        {chips.map((chip) => (
          <span
            key={chip}
            className="inline-flex h-[18px] items-center rounded-full bg-accent/10 px-1.5 font-mono text-[10px] text-accent"
          >
            {chip}
          </span>
        ))}
      </div>
      {open && (
        <div
          id={panelId}
          className="ml-[22px] mt-1 rounded-lg border border-border bg-card px-3.5 py-3"
        >
          <p className="m-0 whitespace-pre-wrap break-words font-mono text-[13px] leading-[1.8] text-foreground/80">
            {diff.merged.map((segment, i) => (
              // Segments have no identity beyond their position in the text.
              // biome-ignore lint/suspicious/noArrayIndexKey: position is the identity
              <span key={i} className={MARK_CLASS[segment.kind] || undefined}>
                {segment.text}
              </span>
            ))}
          </p>
        </div>
      )}
    </div>
  );
}

/** The raw transcript, as Whisper heard it, collapsed under the changes. */
export function HeardDisclosure({ raw }: { raw: string }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const panelId = useId();

  return (
    <div className="flex flex-col gap-1.5 border-t border-border py-2.5">
      <Disclosure
        title={t('captures.transcript.heard')}
        open={open}
        onToggle={() => setOpen((o) => !o)}
        controls={panelId}
        action={
          raw && (
            <CopyButton
              text={raw}
              label={t('captures.panel.copyRaw')}
              className="text-muted-foreground"
            />
          )
        }
      />
      {open && (
        <p
          id={panelId}
          className="m-0 pl-[22px] whitespace-pre-wrap break-words font-mono text-[13px] leading-[1.7] text-foreground/70"
        >
          {raw || t('captures.snippetEmpty')}
        </p>
      )}
    </div>
  );
}
