import { useQuery } from '@tanstack/react-query';
import { apiClient } from '@/lib/api/client';

export const WRITING_STYLE_KEY = ['writing-style'] as const;

/** What Voicebox has learned about how the user punctuates. */
export function useWritingStyle() {
  return useQuery({
    queryKey: WRITING_STYLE_KEY,
    queryFn: () => apiClient.getWritingStyle(),
    staleTime: 60_000,
  });
}
