import { useQuery } from '@tanstack/react-query';
import { apiClient } from '@/lib/api/client';

export function useServerHealth() {
  return useQuery({
    queryKey: ['server', 'health'],
    queryFn: () => apiClient.getHealth(),
    refetchInterval: 30000, // Check every 30 seconds
    retry: 1,
  });
}
