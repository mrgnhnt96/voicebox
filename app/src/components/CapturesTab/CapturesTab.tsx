import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate, useSearch } from '@tanstack/react-router';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { useEffect, useMemo, useRef, useState } from 'react';
import { apiClient } from '@/lib/api/client';
import type { CaptureListResponse, CaptureResponse } from '@/lib/api/types';
import { useCaptureRecordingSession } from '@/lib/hooks/useCaptureRecordingSession';
import { useDictationReadiness } from '@/lib/hooks/useDictationReadiness';
import { CaptureDetail } from './CaptureDetail';
import { CaptureDetailHeader } from './CaptureDetailHeader';
import { CaptureList } from './CaptureList';
import {
  type CaptureFilter,
  isInOverlay,
  isTypingTarget,
  matchesFilter,
  matchesSearch,
} from './captureFormat';
import { EmptyDetail } from './EmptyDetail';

/** The Captures screen: the capture list on the left, the selected capture on the right. */
export function CapturesTab() {
  const queryClient = useQueryClient();
  const navigate = useNavigate({ from: '/captures' });
  const { capture: linkedId } = useSearch({ from: '/captures' });
  const readiness = useDictationReadiness();

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState<CaptureFilter>('all');

  // In-app recording and import. Every Dictate/Stop/Import goes through this
  // session; the header renders its controls and the live HUD pill.
  const session = useCaptureRecordingSession({
    onCaptureCreated: (capture) => setSelectedId(capture.id),
  });

  const { data: capturesData, isLoading: capturesLoading } = useQuery({
    queryKey: ['captures'],
    queryFn: () => apiClient.listCaptures(200, 0),
  });
  const captures = capturesData?.items ?? [];

  const visible = useMemo(
    () => captures.filter((c) => matchesFilter(c, filter) && matchesSearch(c, search)),
    [captures, filter, search],
  );

  // Keep a selection. If the current selection disappears (e.g. deletion),
  // fall through to the first capture, then to null.
  useEffect(() => {
    if (!captures.length) {
      if (selectedId !== null) setSelectedId(null);
      return;
    }
    if (!selectedId || !captures.find((c) => c.id === selectedId)) {
      setSelectedId(captures[0].id);
    }
  }, [captures, selectedId]);

  // `?capture=<id>` (from the command palette) selects that capture once it
  // is in the list, clears whatever would hide it, then drops the parameter
  // so the same link works again.
  useEffect(() => {
    if (!linkedId || !captures.some((c) => c.id === linkedId)) return;
    setSelectedId(linkedId);
    setFilter('all');
    setSearch('');
    navigate({ search: {}, replace: true });
  }, [linkedId, captures, navigate]);

  // Live sync from sibling Tauri webviews (the floating dictate window).
  // ``capture:created`` carries the full row so we can seed the cache before
  // the refetch lands and focus the new capture in one shot — without the
  // seed, the selection-guard effect would snap back to ``captures[0]`` in
  // the race window between ``setSelectedId(new)`` and the refetched list
  // actually containing the new row.
  useEffect(() => {
    const unlistens: Promise<UnlistenFn>[] = [];
    unlistens.push(
      listen<{ capture: CaptureResponse }>('capture:created', (event) => {
        const capture = event.payload?.capture;
        if (capture) {
          queryClient.setQueryData<CaptureListResponse>(['captures'], (prev) => {
            if (!prev) return prev;
            if (prev.items.some((c) => c.id === capture.id)) return prev;
            return { ...prev, items: [capture, ...prev.items], total: prev.total + 1 };
          });
          setSelectedId(capture.id);
        }
        queryClient.invalidateQueries({ queryKey: ['captures'] });
      }),
    );
    unlistens.push(
      listen('capture:updated', () => {
        queryClient.invalidateQueries({ queryKey: ['captures'] });
      }),
    );
    return () => {
      for (const p of unlistens) p.then((fn) => fn()).catch(() => {});
    };
  }, [queryClient]);

  // ↑/↓ move through the visible list, from anywhere but a text field. The
  // search box is the exception, so the user can search and then arrow down.
  const navState = useRef({ visible, selectedId });
  navState.current = { visible, selectedId };
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
      if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey) return;
      const inSearch = event.target instanceof HTMLInputElement && event.target.type === 'search';
      if ((isTypingTarget(event.target) && !inSearch) || isInOverlay(event.target)) return;
      const { visible, selectedId } = navState.current;
      if (!visible.length) return;
      event.preventDefault();
      const index = visible.findIndex((c) => c.id === selectedId);
      const next =
        index === -1
          ? 0
          : Math.min(visible.length - 1, Math.max(0, index + (event.key === 'ArrowDown' ? 1 : -1)));
      setSelectedId(visible[next].id);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  const selected = captures.find((c) => c.id === selectedId) ?? null;

  return (
    <div className="h-full flex overflow-hidden">
      <CaptureList
        captures={captures}
        visible={visible}
        loading={capturesLoading}
        selectedId={selectedId}
        onSelect={setSelectedId}
        search={search}
        onSearchChange={setSearch}
        filter={filter}
        onFilterChange={setFilter}
        allReady={readiness.isLoading || readiness.allReady}
      />
      <div className="flex-1 min-w-0 flex flex-col">
        <CaptureDetailHeader capture={selected} session={session} canRecord={readiness.canRecord} />
        {selected ? (
          <CaptureDetail key={selected.id} capture={selected} session={session} />
        ) : (
          <EmptyDetail
            loading={capturesLoading}
            hasCaptures={captures.length > 0}
            canRecord={readiness.canRecord}
          />
        )}
      </div>
    </div>
  );
}
