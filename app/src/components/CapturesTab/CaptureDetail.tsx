import { apiClient } from '@/lib/api/client';
import type { CaptureResponse } from '@/lib/api/types';
import { CaptureActionBar } from './CaptureActionBar';
import type { CaptureSession } from './CaptureDetailHeader';
import { CaptureFeedback } from './CaptureFeedback';
import { CaptureInlinePlayer } from './CaptureInlinePlayer';
import { RefinementReviewNotice } from './RefinementReviewNotice';
import { TranscriptPanels } from './TranscriptPanels';

/**
 * The selected capture under the header: its audio, the RAW and REFINED
 * transcripts with the inline Teach flow, the saved corrections, and the
 * action bar. Mount it keyed by capture id so drafts reset between captures.
 */
export function CaptureDetail({
  capture,
  session,
}: {
  capture: CaptureResponse;
  session: CaptureSession;
}) {
  return (
    <>
      <div className="flex-1 min-h-0 overflow-y-auto">
        <div className="flex flex-col gap-5 px-6 pt-5 pb-6">
          <CaptureInlinePlayer
            audioUrl={apiClient.getCaptureAudioUrl(capture.id)}
            fallbackDurationMs={capture.duration_ms}
          />
          {capture.refinement_review && (
            <RefinementReviewNotice review={capture.refinement_review} />
          )}
          <TranscriptPanels capture={capture} />
          <CaptureFeedback capture={capture} />
        </div>
      </div>
      <CaptureActionBar
        capture={capture}
        isRefining={session.isRefining}
        onRefine={session.refine}
      />
    </>
  );
}
