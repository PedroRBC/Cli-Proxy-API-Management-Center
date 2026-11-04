import { apiClient } from './client';
import type { UsageRow } from '@/features/usage/model';

export const usageHistoryApi = {
  list: () => apiClient.get<{ rows: UsageRow[] }>('/observability/usage/history'),
  import: (data: unknown) => apiClient.put('/observability/usage/history', data),
};
