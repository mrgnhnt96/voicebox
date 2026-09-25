import { useQuery } from '@tanstack/react-query';
import { invoke } from '@tauri-apps/api/core';
import { cn } from '@/lib/utils/cn';

/**
 * The icon of the app a capture was dictated into, looked up by bundle id.
 * Renders nothing when the app isn't installed or the capture has no app.
 */
export function AppIcon({ bundleId, className }: { bundleId?: string | null; className?: string }) {
  const { data: src } = useQuery({
    queryKey: ['appIcon', bundleId],
    queryFn: () => invoke<string | null>('app_icon', { bundleId }),
    enabled: !!bundleId,
    // An app's icon doesn't change while Voicebox runs.
    staleTime: Number.POSITIVE_INFINITY,
    gcTime: Number.POSITIVE_INFINITY,
  });
  if (!src) return null;
  return <img src={src} alt="" aria-hidden className={cn('size-3.5 shrink-0', className)} />;
}
