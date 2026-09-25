import type { UseQueryResult } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import type { CaptureFeedbackResponse, CaptureResponse } from '@/lib/api/types';
import { CaptureDeleteButton } from './CaptureDeleteButton';
import { CorrectionLearning } from './CorrectionLearning';
import { formatDuration, formatTime, languageName, wordsPerMinute } from './captureFormat';
import type { TeachState } from './TeachCorrection';
import { countWords } from './wordDiff';

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-2.5">
      <h3 className="m-0 font-mono text-[11px] font-normal uppercase tracking-wider text-muted-foreground">
        {title}
      </h3>
      {children}
    </section>
  );
}

function Row({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="flex justify-between gap-2 text-[13px]">
      <span className="text-muted-foreground">{label}</span>
      <span className="min-w-0 truncate text-right text-foreground">{value}</span>
    </div>
  );
}

/**
 * This capture's corrections, newest first. The one the card is showing is
 * tagged, with Undo when it can be taken back.
 */
function Corrections({
  reports,
  teach,
}: {
  reports: UseQueryResult<CaptureFeedbackResponse[]>;
  teach: TeachState;
}) {
  const { t } = useTranslation();
  const items = reports.data ?? [];

  return (
    <Section
      title={
        items.length
          ? t('captures.inspector.correctionsCount', { count: items.length })
          : t('captures.inspector.corrections')
      }
    >
      {reports.isError && (
        <p role="alert" className="m-0 text-[13px] text-destructive">
          {t('captures.feedback.loadFailed')}
        </p>
      )}
      {!reports.isError && !reports.isLoading && !items.length && (
        <p className="m-0 text-[13px] leading-normal text-muted-foreground">
          {t('captures.inspector.noCorrections')}
        </p>
      )}
      {items.length > 0 && (
        <ul className="m-0 flex list-none flex-col p-0">
          {items.map((report) => {
            const showing = teach.learned?.id === report.id;
            return (
              <li
                key={report.id}
                className="flex flex-col gap-1 border-b border-border py-2.5 first:pt-0"
              >
                <div className="flex items-center gap-1.5">
                  <span className="font-mono text-[11px] text-muted-foreground">
                    {t(`captures.transcript.${report.target}`)} · {formatTime(report.created_at)}
                  </span>
                  {showing && (
                    <span className="inline-flex h-4 items-center rounded-full bg-success/15 px-1.5 font-mono text-[10px] text-success">
                      {t('captures.inspector.showing')}
                    </span>
                  )}
                  <span className="flex-1" />
                  {showing && teach.canUndo && (
                    <Button
                      variant="link"
                      size="sm"
                      className="h-5 px-1 text-xs text-muted-foreground"
                      disabled={teach.undoing}
                      onClick={teach.undo}
                    >
                      {t('captures.teach.undo')}
                    </Button>
                  )}
                </div>
                <p className="m-0 whitespace-pre-wrap break-words text-[13px] leading-normal">
                  {report.expected_text || '∅'}
                </p>
                {report.notes && (
                  <p className="m-0 whitespace-pre-wrap break-words text-xs leading-normal text-muted-foreground">
                    {report.notes}
                  </p>
                )}
              </li>
            );
          })}
        </ul>
      )}
      <CorrectionLearning reports={items} />
    </Section>
  );
}

/**
 * The capture's details beside its text: the recording, the models, and the
 * corrections. It scrolls on its own, with Delete pinned at the bottom.
 */
export function CaptureInspector({
  capture,
  reports,
  teach,
}: {
  capture: CaptureResponse;
  reports: UseQueryResult<CaptureFeedbackResponse[]>;
  teach: TeachState;
}) {
  const { t } = useTranslation();
  const rawWords = countWords(capture.transcript_raw);
  const refinedWords = capture.transcript_refined ? countWords(capture.transcript_refined) : null;
  const pace = wordsPerMinute(rawWords, capture.duration_ms);

  return (
    <aside className="w-[250px] shrink-0 flex flex-col border-l border-border bg-card">
      <div className="flex-1 min-h-0 overflow-y-auto flex flex-col gap-6 px-5 py-6">
        <Section title={t('captures.inspector.recording')}>
          <Row label={t('captures.inspector.length')} value={formatDuration(capture.duration_ms)} />
          {pace !== null && (
            <Row
              label={t('captures.inspector.pace')}
              value={t('captures.inspector.wpm', { count: pace })}
            />
          )}
          <Row
            label={t('captures.inspector.words')}
            value={refinedWords === null ? rawWords : `${rawWords} → ${refinedWords}`}
          />
          {capture.language && (
            <Row label={t('captures.inspector.language')} value={languageName(capture.language)} />
          )}
        </Section>
        {(capture.stt_model || capture.llm_model) && (
          <Section title={t('captures.inspector.models')}>
            {capture.stt_model && (
              <Row
                label={t('captures.inspector.speech')}
                value={t('captures.inspector.whisper', { model: capture.stt_model })}
              />
            )}
            {capture.llm_model && (
              <Row
                label={t('captures.inspector.refinement')}
                value={t('captures.inspector.qwen', { model: capture.llm_model })}
              />
            )}
          </Section>
        )}
        <Corrections reports={reports} teach={teach} />
      </div>
      <div className="shrink-0 border-t border-border px-5 py-3.5">
        <CaptureDeleteButton capture={capture} />
      </div>
    </aside>
  );
}
