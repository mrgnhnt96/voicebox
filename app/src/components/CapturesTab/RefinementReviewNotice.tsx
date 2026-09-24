import { AlertTriangle } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { RefinementReview } from '@/lib/api/types';

/** Tells the user what to check when cleanup may have changed what they said. */
export function RefinementReviewNotice({ review }: { review: RefinementReview }) {
  const { t } = useTranslation();
  const rejected = review.outcome === 'reject';
  return (
    <div
      role="note"
      className="flex gap-2.5 rounded-lg border border-warning/30 bg-warning/10 p-3 text-[13px]"
    >
      <AlertTriangle className="h-4 w-4 shrink-0 text-warning mt-0.5" />
      <div className="space-y-1">
        <p className="font-medium">
          {rejected ? t('captures.review.rejectedTitle') : t('captures.review.title')}
        </p>
        {rejected && review.reasons.length > 0 && (
          <p className="text-muted-foreground">
            {review.reasons.map((reason) => t(`captures.review.reasons.${reason}`)).join(' ')}
          </p>
        )}
        {review.added.length > 0 && (
          <p className="text-muted-foreground">
            {t('captures.review.added', { words: review.added.join(', ') })}
          </p>
        )}
        {review.missing.length > 0 && (
          <p className="text-muted-foreground">
            {t('captures.review.missing', { words: review.missing.join(', ') })}
          </p>
        )}
        <p className="text-xs text-muted-foreground">{t('captures.review.hint')}</p>
      </div>
    </div>
  );
}
