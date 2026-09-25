import { useQuery } from '@tanstack/react-query';
import { apiClient } from '@/lib/api/client';
import type { CaptureResponse } from '@/lib/api/types';
import { CaptureInspector } from './CaptureInspector';
import { RefinementReviewNotice } from './RefinementReviewNotice';
import { useTeachCorrection } from './TeachCorrection';
import { ChangesDisclosure, HeardDisclosure, TranscriptCard } from './TranscriptCard';

/**
 * The selected capture under the header: the text it delivered, what
 * refinement changed and what was heard, and the inspector beside them.
 * The card corrects the refined text, or the raw text when there is no
 * refinement; fixing a misheard word there teaches it too. Mount it keyed
 * by capture id so drafts reset between captures.
 */
export function CaptureDetail({ capture }: { capture: CaptureResponse }) {
  const raw = capture.transcript_raw || '';
  const refined = capture.transcript_refined || null;
  const teach = useTeachCorrection(capture, refined ? 'refined' : 'raw', refined ?? raw);
  const reports = useQuery({
    queryKey: ['capture-feedback', capture.id],
    queryFn: () => apiClient.listCaptureFeedback(capture.id),
  });

  return (
    <div className="flex-1 min-h-0 flex">
      {/* The card gives up height to what's opened below it, down to half the
          pane; past that, the opened rows scroll instead. */}
      <div className="flex-1 min-w-0 flex flex-col gap-3 px-6 pt-6 pb-3">
        {capture.refinement_review && (
          <div className="shrink-0">
            <RefinementReviewNotice review={capture.refinement_review} />
          </div>
        )}
        <TranscriptCard refined={!!refined} teach={teach} />
        {refined && (
          <div className="min-h-0 overflow-y-auto flex flex-col px-1">
            <ChangesDisclosure raw={raw} refined={refined} />
            <HeardDisclosure raw={raw} />
          </div>
        )}
      </div>
      <CaptureInspector capture={capture} reports={reports} teach={teach} />
    </div>
  );
}
