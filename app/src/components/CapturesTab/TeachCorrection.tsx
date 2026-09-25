import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Check } from 'lucide-react';
import { type ReactNode, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Kbd } from '@/components/ui/kbd';
import { useToast } from '@/components/ui/use-toast';
import { PERSONAL_EXAMPLES_KEY } from '@/components/WritingStyle/PersonalExamples';
import { apiClient } from '@/lib/api/client';
import type { CaptureFeedbackResponse, CaptureResponse } from '@/lib/api/types';
import { useWritingStyle, WRITING_STYLE_KEY } from '@/lib/hooks/useWritingStyle';
import { cn } from '@/lib/utils/cn';
import { type DiffHunk, diffWords } from './wordDiff';

export type TeachTarget = 'raw' | 'refined';

const MAX_HUNKS_SHOWN = 3;

/**
 * State for teaching one transcript of a capture: the draft of what the user
 * meant, the optional note, saving it as a correction, and undoing it.
 */
export function useTeachCorrection(
  capture: CaptureResponse,
  target: TeachTarget,
  original: string,
) {
  const { t } = useTranslation();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState<string | null>(null);
  const [notes, setNotes] = useState('');
  const [learned, setLearned] = useState<CaptureFeedbackResponse | null>(null);

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: ['capture-feedback', capture.id] });
    // Refined-output corrections also teach the writing style.
    queryClient.invalidateQueries({ queryKey: WRITING_STYLE_KEY });
    queryClient.invalidateQueries({ queryKey: PERSONAL_EXAMPLES_KEY });
  };

  const save = useMutation({
    mutationFn: (body: { expected_text: string; notes: string }) =>
      apiClient.reportCaptureOutput(capture.id, { snapshot: capture, target, ...body }),
    onSuccess: (report) => {
      setLearned(report);
      setDraft(null);
      setNotes('');
      invalidate();
    },
    onError: (error: Error) =>
      toast({
        title: t('captures.feedback.failed'),
        description: error.message,
        variant: 'destructive',
      }),
  });

  // A refined correction becomes one of the writing-style examples; undo
  // takes it back out. The saved report itself stays in the history.
  const undo = useMutation({
    mutationFn: (report: CaptureFeedbackResponse) =>
      apiClient.removePersonalExample(`correction:${report.id}`),
    onSuccess: () => {
      setLearned(null);
      invalidate();
    },
    onError: (error: Error) =>
      toast({
        title: t('captures.teach.undoFailed'),
        description: error.message,
        variant: 'destructive',
      }),
  });

  const changed = draft !== null && draft.trim() !== original.trim();

  return {
    target,
    original,
    draft,
    notes,
    changed,
    learned,
    saving: save.isPending,
    undoing: undo.isPending,
    canUndo: target === 'refined',
    /** Starts editing from the current text, so the user fixes it in place. */
    begin: () => setDraft((d) => d ?? original),
    setDraft,
    setNotes,
    cancel: () => {
      setDraft(null);
      setNotes('');
    },
    /** Drops an untouched draft when focus leaves, back to the plain text. */
    settle: () => {
      if (!changed && !notes) setDraft(null);
    },
    save: () => {
      if (changed && draft !== null && !save.isPending)
        save.mutate({ expected_text: draft, notes });
    },
    undo: () => learned && undo.mutate(learned),
  };
}

export type TeachState = ReturnType<typeof useTeachCorrection>;

/** "post grass → Postgres" for each place the text changed. */
export function HunkList({ hunks, className }: { hunks: DiffHunk[]; className?: string }) {
  const { t } = useTranslation();
  const shown = hunks.slice(0, MAX_HUNKS_SHOWN);
  return (
    <ul className={className}>
      {shown.map((hunk, i) => (
        // Hunks have no identity beyond their order in this diff.
        // biome-ignore lint/suspicious/noArrayIndexKey: order is the identity
        <li key={i} className="font-mono text-xs leading-relaxed">
          {hunk.removed && <span className="text-destructive line-through">{hunk.removed}</span>}
          {hunk.removed && hunk.added && <span className="text-muted-foreground"> → </span>}
          {hunk.added && <span className="text-success">{hunk.added}</span>}
        </li>
      ))}
      {hunks.length > shown.length && (
        <li className="font-mono text-xs text-muted-foreground">
          {t('captures.teach.moreChanges', { count: hunks.length - shown.length })}
        </li>
      )}
    </ul>
  );
}

function onTeachKeyDown(teach: TeachState) {
  return (event: React.KeyboardEvent) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      teach.cancel();
      (event.target as HTMLElement).blur();
    } else if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      teach.save();
    }
  };
}

/**
 * The transcript itself, editable in place: click the text and fix it. It
 * looks like the text it replaces and grows with it. ⏎ saves the fix, ⇧⏎
 * adds a line, esc cancels, and leaving an unchanged edit puts the text back.
 */
export function EditableTranscript({
  teach,
  className,
  children,
}: {
  teach: TeachState;
  className: string;
  /** The text as shown when not editing, with its highlights. */
  children: ReactNode;
}) {
  const { t } = useTranslation();
  const field = useRef<HTMLTextAreaElement>(null);
  const editing = teach.draft !== null;

  // Grow with the text; field-sizing isn't in every WebKit this ships on.
  // biome-ignore lint/correctness/useExhaustiveDependencies: resize when the draft changes
  useLayoutEffect(() => {
    const element = field.current;
    if (!element) return;
    element.style.height = 'auto';
    element.style.height = `${element.scrollHeight}px`;
  }, [teach.draft]);

  const surface = 'm-0 -mx-1.5 -my-1 rounded-md px-1.5 py-1 whitespace-pre-wrap break-words';
  if (!editing) {
    return (
      <button
        type="button"
        title={t('captures.teach.editHint')}
        aria-label={t('captures.teach.editHint')}
        onClick={teach.begin}
        className={cn(
          surface,
          className,
          'block w-[calc(100%+0.75rem)] text-left cursor-text hover:bg-foreground/[0.04] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring',
        )}
      >
        {children}
      </button>
    );
  }
  return (
    <textarea
      ref={field}
      // biome-ignore lint/a11y/noAutofocus: opened by clicking the text, which the user expects to edit
      autoFocus
      onFocus={(event) => {
        const end = event.target.value.length;
        event.target.setSelectionRange(end, end);
      }}
      rows={1}
      value={teach.draft ?? ''}
      aria-label={t('captures.teach.editHint')}
      maxLength={100000}
      disabled={teach.saving}
      onBlur={teach.settle}
      onChange={(event) => teach.setDraft(event.target.value)}
      onKeyDown={onTeachKeyDown(teach)}
      className={cn(
        surface,
        className,
        'block w-[calc(100%+0.75rem)] resize-none overflow-hidden border-0 bg-foreground/[0.04] outline-none ring-1 ring-ring',
      )}
    />
  );
}

/**
 * Under an edited transcript: what changed, an optional note and Save. Shown
 * only once the text differs from what Voicebox wrote.
 */
export function TeachActions({ teach }: { teach: TeachState }) {
  const { t } = useTranslation();
  const notesId = useId();
  const hunks = useMemo(
    () =>
      teach.changed && teach.draft !== null ? diffWords(teach.original, teach.draft).hunks : [],
    [teach.changed, teach.draft, teach.original],
  );

  if (teach.draft === '') {
    return <p className="text-xs text-muted-foreground">{t('captures.feedback.emptyHint')}</p>;
  }
  if (!teach.changed) return null;
  return (
    <div className="flex flex-col gap-3.5">
      {hunks.length > 0 && <HunkList hunks={hunks} className="space-y-0.5" />}
      <div className="flex flex-col gap-1.5">
        <label htmlFor={notesId} className="text-xs text-muted-foreground">
          {t('captures.feedback.notes')}
        </label>
        <Input
          id={notesId}
          value={teach.notes}
          maxLength={5000}
          disabled={teach.saving}
          onChange={(event) => teach.setNotes(event.target.value)}
          onKeyDown={onTeachKeyDown(teach)}
          className="h-9 bg-background"
        />
      </div>
      <div className="flex justify-end gap-2">
        {/* Keeps the edit open while the pointer is down, so Cancel and Save
            aren't removed by the text losing focus first. */}
        <Button
          variant="outline"
          size="sm"
          disabled={teach.saving}
          onMouseDown={(event) => event.preventDefault()}
          onClick={teach.cancel}
        >
          {t('common.cancel')}
          <Kbd className="border-0 px-0">esc</Kbd>
        </Button>
        <Button
          size="sm"
          className="font-semibold"
          disabled={teach.saving}
          onMouseDown={(event) => event.preventDefault()}
          onClick={teach.save}
        >
          {t('captures.teach.save')}
          <Kbd className="border-0 px-0 text-accent-foreground">⏎</Kbd>
        </Button>
      </div>
    </div>
  );
}

/** The confirmation after a correction is saved, with the learning status and Undo. */
export function LearnedNotice({ teach }: { teach: TeachState }) {
  const { t } = useTranslation();
  const { data: style } = useWritingStyle();
  const learning = useQuery({
    queryKey: ['correction-learning'],
    queryFn: () => apiClient.correctionLearningStatus(),
    refetchInterval: (query) => (query.state.data?.model?.running ? 2000 : 60_000),
  });
  const report = teach.learned;
  const hunks = useMemo(
    () => (report ? diffWords(teach.original, report.expected_text).hunks : []),
    [report, teach.original],
  );
  if (!report) return null;
  const model = learning.data?.model;
  const examples = style?.example_count ?? 0;

  return (
    <div className="flex flex-col gap-3.5">
      <div
        aria-live="polite"
        className="flex flex-col gap-2.5 rounded-md border border-border bg-background p-3"
      >
        <div className="flex flex-wrap items-center gap-2 text-[13px]">
          <Check className="h-3.5 w-3.5 text-success" strokeWidth={3} />
          {t('captures.teach.learned')}
          {hunks[0] && <HunkList hunks={hunks.slice(0, 1)} className="text-muted-foreground" />}
        </div>
        <p className="text-xs leading-normal text-muted-foreground">
          {t('captures.feedback.saved')}
          {model?.running && ` ${t(`captures.feedback.learning.modelPhases.${model.phase}`)}`}
        </p>
        {model?.running && (
          <div className="h-[3px] overflow-hidden rounded-sm bg-border">
            <div className="h-full w-1/3 rounded-sm bg-accent animate-pulse" />
          </div>
        )}
      </div>
      <div className="flex items-center justify-between">
        <span className="font-mono text-[11px] text-muted-foreground">
          {examples > 0 && t('captures.teach.examplesLearned', { count: examples })}
        </span>
        {teach.canUndo && (
          <Button variant="outline" size="sm" disabled={teach.undoing} onClick={teach.undo}>
            {t('captures.teach.undo')}
          </Button>
        )}
      </div>
    </div>
  );
}
