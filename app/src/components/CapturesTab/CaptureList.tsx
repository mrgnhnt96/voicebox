import { Link } from '@tanstack/react-router';
import { Loader2, Search } from 'lucide-react';
import { useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { Kbd } from '@/components/ui/kbd';
import { StyleCalibrationPrompt } from '@/components/WritingStyle/StyleCalibrationPrompt';
import type { CaptureResponse } from '@/lib/api/types';
import { cn } from '@/lib/utils/cn';
import { AppIcon } from './AppIcon';
import {
  captureTag,
  deliveredText,
  formatDuration,
  formatRowTime,
  snippetParts,
} from './captureFormat';

function CaptureRow({
  capture,
  active,
  onSelect,
}: {
  capture: CaptureResponse;
  active: boolean;
  onSelect: () => void;
}) {
  const { t } = useTranslation();
  const tag = captureTag(capture);
  const text = deliveredText(capture).trim();
  const parts = text ? snippetParts(text, capture.refinement_review?.added ?? []) : [];
  return (
    <button
      type="button"
      data-capture-id={capture.id}
      aria-current={active ? 'true' : undefined}
      onClick={onSelect}
      className={cn(
        'w-full flex flex-col gap-2 p-3 rounded-lg text-left transition-colors',
        'focus-visible:outline-none focus-visible:bg-muted',
        active ? 'bg-muted' : 'hover:bg-muted/50',
      )}
    >
      <span className="text-[14px] leading-normal text-foreground line-clamp-2 [overflow-wrap:anywhere]">
        {text
          ? parts.map((part, i) =>
              part.changed ? (
                <mark
                  // biome-ignore lint/suspicious/noArrayIndexKey: parts never reorder
                  key={i}
                  className="rounded-[2px] px-0.5 bg-warning/10 text-warning border-b-[1.5px] border-dashed border-warning/70"
                >
                  {part.text}
                </mark>
              ) : (
                part.text
              ),
            )
          : t('captures.snippetEmpty')}
      </span>
      <span className="flex items-center gap-[7px] min-w-0 text-[11.5px] text-muted-foreground">
        <AppIcon bundleId={capture.app_bundle_id} />
        {capture.app_name && (
          <>
            <span className="min-w-0 truncate">{capture.app_name}</span>
            <span className="shrink-0 text-muted-foreground/50">·</span>
          </>
        )}
        <span className="shrink-0 whitespace-nowrap">
          {formatRowTime(capture.created_at, t('captures.list.yesterday'))}
        </span>
        <span className="shrink-0 text-muted-foreground/50">·</span>
        <span className="shrink-0 tabular-nums">{formatDuration(capture.duration_ms)}</span>
        <span className="flex-1" />
        {tag === 'review' && (
          <span className="shrink-0 flex items-center gap-1.5 font-semibold text-warning">
            <span className="size-1.5 rounded-full bg-warning" />
            {t('captures.tag.review')}
          </span>
        )}
        {tag === 'raw' && (
          <span className="shrink-0 flex items-center gap-1.5">
            <span className="size-1.5 rounded-full border-[1.5px] border-muted-foreground/70" />
            {t('captures.tag.raw')}
          </span>
        )}
      </span>
    </button>
  );
}

/**
 * The 440px capture list: search (⌘K hint), the not-set-up
 * banner, the style calibration prompt, and one row per capture.
 */
export function CaptureList({
  captures,
  visible,
  loading,
  selectedId,
  onSelect,
  search,
  onSearchChange,
  allReady,
}: {
  captures: CaptureResponse[];
  /** The captures left after search, in display order. */
  visible: CaptureResponse[];
  loading: boolean;
  selectedId: string | null;
  onSelect: (id: string) => void;
  search: string;
  onSearchChange: (value: string) => void;
  allReady: boolean;
}) {
  const { t } = useTranslation();
  const scrollRef = useRef<HTMLDivElement>(null);

  // Keep the selected row in view as the arrow keys move through the list.
  useEffect(() => {
    if (!selectedId) return;
    scrollRef.current
      ?.querySelector(`[data-capture-id="${CSS.escape(selectedId)}"]`)
      ?.scrollIntoView({ block: 'nearest' });
  }, [selectedId]);

  return (
    <section
      aria-label={t('captures.title')}
      className="w-[440px] shrink-0 flex flex-col border-r border-border"
    >
      <div className="p-4 border-b border-border">
        <label className="flex items-center gap-2.5 h-10 px-3 rounded-lg border border-input bg-popover focus-within:border-ring">
          <Search className="h-[15px] w-[15px] shrink-0 text-muted-foreground" />
          <input
            type="search"
            value={search}
            onChange={(e) => onSearchChange(e.target.value)}
            placeholder={t('captures.searchPlaceholder')}
            aria-label={t('captures.searchPlaceholder')}
            className="flex-1 min-w-0 bg-transparent text-[13px] outline-none placeholder:text-muted-foreground [&::-webkit-search-cancel-button]:hidden"
          />
          <Kbd>⌘K</Kbd>
        </label>
      </div>

      <div ref={scrollRef} className="flex-1 min-h-0 overflow-y-auto">
        {!allReady && (
          <div className="flex items-center justify-between gap-3 px-4 py-2.5 border-b border-border bg-warning/10 text-[13px]">
            <span>{t('captures.notReady.title')}</span>
            <Link
              to="/setup"
              className="shrink-0 text-accent hover:underline focus-visible:outline-none focus-visible:underline"
            >
              {t('captures.notReady.action')}
            </Link>
          </div>
        )}
        {/* The prompt brings its own mx-1 mb-3, which completes the 16px inset. */}
        <div className="px-3 pt-4 pb-1 border-b border-border empty:hidden">
          <StyleCalibrationPrompt hasCaptures={captures.length > 0} />
        </div>
        {loading ? (
          <div className="py-12 flex justify-center text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" aria-label={t('captures.empty.loading')} />
          </div>
        ) : visible.length === 0 ? (
          <p className="px-4 py-12 text-center text-[13px] text-muted-foreground">
            {search.trim()
              ? t('captures.empty.noMatches', { query: search })
              : captures.length
                ? t('captures.empty.noneInFilter')
                : t('captures.empty.none')}
          </p>
        ) : (
          <div className="flex flex-col gap-0.5 p-2">
            {visible.map((capture) => (
              <CaptureRow
                key={capture.id}
                capture={capture}
                active={capture.id === selectedId}
                onSelect={() => onSelect(capture.id)}
              />
            ))}
          </div>
        )}
      </div>
    </section>
  );
}
