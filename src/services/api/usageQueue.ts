import { apiClient } from './client';

export const usageQueueApi = {
  /** Pops up to `count` queued usage records. Destructive: each record is returned once. */
  pop: async (count: number): Promise<unknown[]> => {
    const data = await apiClient.get<unknown>('/observability/usage/queue', { params: { count } });
    return Array.isArray(data) ? data : [];
  },
};
