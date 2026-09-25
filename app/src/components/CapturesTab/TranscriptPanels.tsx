import { CircleHelp, Copy } from 'lucide-react';
import { type ReactNode, useId, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { useToast } from '@/components/ui/use-toast';
import type { CaptureResponse } from '@/lib/api/types';
import { cn } from '@/lib/utils/cn';
import {
  EditableTranscript,
  LearnedNotice,
  TeachActions,
  type TeachTarget,
  useTeachCorrection,
} from './TeachCorrection';
import { countWords, type DiffSegment, diffWords } from './wordDiff';

type Mark = 'removed' | 'added' | 'corrected';

const MARK_CLASS: Record<Mark, string> = {
  removed: 'bg-destructive/15 text-destructive line-through',
  added: 'bg-accent/20 rounded-sm px-0.5',
  corrected: 'bg-success/15 rounded-sm px-0.5',
};

function Marked({ segments, mark }: { segments: DiffSegment[]; mark: Mark }) {
  return (
    <>
      {segments.map((segment, i) =>
        segment.changed ? (
          // Segments have no identity beyond their position in the text.
          // biome-ignore lint/suspicious/noArrayIndexKey: position is the identity
          <span key={i} className={MARK_CLASS[mark]}>
            {segment.text}
          </span>
        ) : (
          // biome-ignore lint/suspicious/noArrayIndexKey: position is the identity
          <span key={i}>{segment.text}</span>
        ),
      )}
    </>
  );
}

/**
 * One transcript panel. With `teach`, its text is editable in place: the
 * user fixes it where it is (or presses Alter), and after saving it shows
 * the corrected text with the learned confirmation. The ? beside Alter
 * explains what a correction does.
 */
function TranscriptPanel({
  tone,
  label,
  meta,
  action,
  capture,
  text,
  body,
  teach,
}: {
  tone: 'raw' | 'refined';
  label: string;
  meta: string;
  action?: ReactNode;
  capture: CaptureResponse;
  text: string;
  body: ReactNode;
  /** Which transcript the Teach field corrects; omitted for no field. */
  teach?: TeachTarget;
}) {
  const { t } = useTranslation();
  const teachState = useTeachCorrection(capture, teach ?? tone, text);
  const [explained, setExplained] = useState(false);
  const aboutId = useId();
  const learned = teach ? teachState.learned : null;
  const textClass =
    tone === 'raw'
      ? 'font-mono text-[13px] leading-[1.7] text-foreground/75'
      : 'text-base leading-[1.65] text-foreground';
  const corrected = useMemo(
    () => (learned ? diffWords(text, learned.expected_text).after : null),
    [learned, text],
  );

  return (
    <section
      aria-label={label}
      className={cn(
        'flex flex-col gap-2.5 rounded-lg border p-4 min-w-0',
        tone === 'refined' ? 'border-accent/20 bg-accent/[0.04]' : 'border-border bg-card',
      )}
    >
      <div className="flex items-center justify-between gap-2 font-mono text-[11px] text-muted-foreground uppercase">
        <span className={cn('truncate', tone === 'refined' && 'text-accent')}>
          {learned ? `${label} · ${t('captures.teach.corrected')}` : label}
        </span>
        <span className="flex items-center gap-1 shrink-0 normal-case">
          {teach && !learned && (
            <>
              <Button
                variant="ghost"
                size="sm"
                className="h-6 px-1.5 font-mono text-[11px] text-muted-foreground"
                disabled={teachState.draft !== null}
                onClick={teachState.begin}
              >
                {t('captures.teach.alter')}
              </Button>
              <Button
                variant="ghost"
                size="icon"
                className={cn('h-6 w-6 text-muted-foreground', explained && 'text-foreground')}
                aria-label={t('captures.feedback.about')}
                title={t('captures.feedback.about')}
                aria-expanded={explained}
                aria-controls={aboutId}
                onClick={() => setExplained((open) => !open)}
              >
                <CircleHelp className="size-3.5!" />
              </Button>
            </>
          )}
          {learned ? t('captures.teach.editedByYou') : meta}
          {action}
        </span>
      </div>
      {teach && explained && (
        <p id={aboutId} className="m-0 text-xs leading-relaxed text-muted-foreground">
          {t('captures.feedback.description')}
        </p>
      )}
      {teach && !learned ? (
        <EditableTranscript teach={teachState} className={textClass}>
          {body}
        </EditableTranscript>
      ) : (
        <p className={cn('m-0 whitespace-pre-wrap break-words', textClass)}>
          {corrected ? <Marked segments={corrected} mark="corrected" /> : body}
        </p>
      )}
      {teach && (
        <>
          <div className="flex-1" />
          {learned ? <LearnedNotice teach={teachState} /> : <TeachActions teach={teachState} />}
        </>
      )}
    </section>
  );
}

function CopyButton({ text, label }: { text: string; label: string }) {
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
    <Button variant="ghost" size="icon" className="h-6 w-6" onClick={copy} aria-label={label}>
      <Copy className="size-3!" />
    </Button>
  );
}

/**
 * RAW and REFINED side by side. The raw text strikes through the words
 * refinement dropped; the refined text highlights the words it put in.
 * Clicking the refined text corrects it, or the raw text when there is no
 * refinement. Fixing a misheard word there teaches it too, so the raw
 * panel has no correction of its own.
 */
export function TranscriptPanels({ capture }: { capture: CaptureResponse }) {
  const { t } = useTranslation();
  const raw = capture.transcript_raw || '';
  const refined = capture.transcript_refined || null;
  const diff = useMemo(() => (refined ? diffWords(raw, refined) : null), [raw, refined]);

  const rawLabel = [t('captures.transcript.raw'), capture.stt_model].filter(Boolean).join(' · ');
  const refinedLabel = [t('captures.transcript.refined'), capture.llm_model]
    .filter(Boolean)
    .join(' · ');

  return (
    <div className="grid grid-cols-2 gap-4 min-h-[280px]">
      <TranscriptPanel
        tone="raw"
        label={rawLabel}
        meta={t('captures.panel.words', { count: countWords(raw) })}
        action={<CopyButton text={raw} label={t('captures.panel.copyRaw')} />}
        capture={capture}
        text={raw}
        body={
          raw ? (
            diff ? (
              <Marked segments={diff.before} mark="removed" />
            ) : (
              raw
            )
          ) : (
            <span className="text-muted-foreground">{t('captures.snippetEmpty')}</span>
          )
        }
      />
      <TranscriptPanel
        tone="refined"
        label={refinedLabel}
        meta={refined ? t('captures.panel.words', { count: countWords(refined) }) : ''}
        capture={capture}
        text={refined ?? raw}
        body={
          diff ? (
            <Marked segments={diff.after} mark="added" />
          ) : (
            <span className="text-sm text-muted-foreground">{t('captures.panel.notRefined')}</span>
          )
        }
        teach={refined ? 'refined' : 'raw'}
      />
    </div>
  );
}
