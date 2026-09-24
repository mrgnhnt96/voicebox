import { Link } from '@tanstack/react-router';
import { Loader2, Search } from 'lucide-react';
import { useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { Kbd } from '@/components/ui/kbd';
import { StyleCalibrationPrompt } from '@/components/WritingStyle/StyleCalibrationPrompt';
import type { CaptureResponse } from '@/lib/api/types';
import { cn } from '@/lib/utils/cn';
import {
  type CaptureFilter,
  type CaptureTag,
  captureTag,
  deliveredText,
  formatDuration,
  formatRowTime,
} from './captureFormat';

const FILTERS: CaptureFilter[] = ['all', 'dictation', 'recording', 'file', 'review'];

const TAG_CLASS: Record<CaptureTag, string> = {
  refined: 'border border-accent/30 text-accent',
  review: 'bg-warning/15 text-warning',
  raw: 'border border-input text-muted-foreground',
};

function FilterChips({
  value,
  onChange,
  total,
  reviewCount,
}: {
  value: CaptureFilter;
  onChange: (filter: CaptureFilter) => void;
  total: number;
  reviewCount: number;
}) {
  const { t } = useTranslation();
  return (
    <fieldset
      aria-label={t('captures.filters.label')}
      className="m-0 min-w-0 border-0 p-0 flex flex-wrap gap-1.5"
    >
      {FILTERS.map((filter) => {
        const active = value === filter;
        const count = filter === 'all' ? total : filter === 'review' ? reviewCount : null;
        return (
          <button
            key={filter}
            type="button"
            aria-pressed={active}
            onClick={() => onChange(filter)}
            className={cn(
              'h-7 px-2.5 rounded-md border text-xs transition-colors',
              'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
              active
                ? 'border-input bg-secondary text-foreground'
                : 'border-border text-muted-foreground hover:text-foreground',
              filter === 'review' && !active && 'border-accent/30 text-accent hover:text-accent',
            )}
          >
            {t(`captures.filters.${filter}`)}
            {count != null && <span className="ml-1.5 tabular-nums">{count}</span>}
          </button>
        );
      })}
    </fieldset>
  );
}

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
  const snippet = deliveredText(capture).trim() || t('captures.snippetEmpty');
  return (
    <button
      type="button"
      data-capture-id={capture.id}
      aria-current={active ? 'true' : undefined}
      onClick={onSelect}
      className={cn(
        'w-full flex flex-col gap-1.5 px-4 py-3 text-left border-b border-border/70 transition-colors',
        'focus-visible:outline-none focus-visible:bg-muted',
        active ? 'bg-muted shadow-[inset_2px_0_0_hsl(var(--accent))]' : 'hover:bg-muted/50',
      )}
    >
      <span className="flex items-center gap-2.5 font-mono text-[11px] text-muted-foreground">
        <span className="w-16 shrink-0 truncate">
          {formatRowTime(capture.created_at, t('captures.list.yesterday'))}
        </span>
        <span className="w-[70px] shrink-0 uppercase">
          {t(`captures.source.${capture.source}`)}
        </span>
        <span className={cn('px-1.5 rounded-[3px] leading-4', TAG_CLASS[tag])}>
          {t(`captures.tag.${tag}`)}
        </span>
        <span className="flex-1" />
        <span className="tabular-nums">{formatDuration(capture.duration_ms)}</span>
      </span>
      <span className="text-[13.5px] leading-[1.45] text-foreground/85 truncate">{snippet}</span>
    </button>
  );
}

/**
 * The 440px capture list: search (⌘K hint), filter chips, the not-set-up
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
  filter,
  onFilterChange,
  allReady,
}: {
  captures: CaptureResponse[];
  /** The captures left after search and filter, in display order. */
  visible: CaptureResponse[];
  loading: boolean;
  selectedId: string | null;
  onSelect: (id: string) => void;
  search: string;
  onSearchChange: (value: string) => void;
  filter: CaptureFilter;
  onFilterChange: (filter: CaptureFilter) => void;
  allReady: boolean;
}) {
  const { t } = useTranslation();
  const scrollRef = useRef<HTMLDivElement>(null);
  const reviewCount = captures.filter((c) => c.refinement_review).length;

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
      <div className="flex flex-col gap-3 p-4 border-b border-border">
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
        <FilterChips
          value={filter}
          onChange={onFilterChange}
          total={captures.length}
          reviewCount={reviewCount}
        />
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
          visible.map((capture) => (
            <CaptureRow
              key={capture.id}
              capture={capture}
              active={capture.id === selectedId}
              onSelect={() => onSelect(capture.id)}
            />
          ))
        )}
      </div>
    </section>
  );
}
