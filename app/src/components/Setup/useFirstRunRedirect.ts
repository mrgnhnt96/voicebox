import { useQuery } from '@tanstack/react-query';
import { useNavigate, useRouterState } from '@tanstack/react-router';
import { useEffect } from 'react';
import { apiClient } from '@/lib/api/client';
import { useDictationReadiness } from '@/lib/hooks/useDictationReadiness';

// Module scope so the decision is made once per launch, not once per mount.
let decided = false;

/**
 * Sends a brand-new user to ``/setup`` once per launch: when dictation
 * can't record yet and there are no captures. Waits for the real readiness
 * and captures answers (not their loading states), so a slow server never
 * counts as "not ready". After the first decision it stays out of the way,
 * so leaving setup is never undone. Only redirects from the landing screen.
 */
export function useFirstRunRedirect() {
  const navigate = useNavigate();
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const readiness = useDictationReadiness();
  // Same key and page size as the Captures screen, so the two share a cache.
  const { data: captures } = useQuery({
    queryKey: ['captures'],
    queryFn: () => apiClient.listCaptures(200, 0),
  });

  const readinessLoaded = !readiness.isLoading && readiness.stt !== undefined;

  useEffect(() => {
    if (decided || !readinessLoaded || !captures) return;
    decided = true;
    if (readiness.canRecord || captures.items.length > 0) return;
    // Readiness can take ~30 s after launch; don't pull someone out of a
    // screen they've already opened in the meantime.
    if (pathname === '/' || pathname === '/captures') navigate({ to: '/setup' });
  }, [readinessLoaded, captures, readiness.canRecord, pathname, navigate]);
}
