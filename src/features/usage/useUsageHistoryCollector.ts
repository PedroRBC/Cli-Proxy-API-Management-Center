/**
 * Drains the server's usage queue into browser history while a panel tab is open.
 *
 * The queue keeps records for `redis-usage-queue-retention-seconds` (set to
 * 3600, its maximum), so a panel opened within that window catches up. A Web
 * Lock elects one tab per browser; popping is destructive, so two collectors
 * never see the same record.
 */

import { useEffect } from 'react';
import { usageQueueApi } from '@/services/api';
import { useAuthStore } from '@/stores';
import { addLiveRows, openHistoryDb, putQuotaSamples } from './historyDb';
import { aggregateQueueRecords, quotaSamplesFromRecord } from './model';

const POLL_MS = 60_000;
const BATCH = 500;
const MAX_BATCHES = 20;

export const HISTORY_UPDATED_EVENT = 'cliproxy-history-updated';

async function drain(serverKey: string) {
  const db = await openHistoryDb(serverKey);
  let total = 0;
  for (let i = 0; i < MAX_BATCHES; i += 1) {
    const records = await usageQueueApi.pop(BATCH);
    if (records.length === 0) break;
    // Persist each batch before popping the next so a failure loses at most one batch.
    await addLiveRows(db, aggregateQueueRecords(records));
    await putQuotaSamples(db, records.flatMap(quotaSamplesFromRecord));
    total += records.length;
    if (records.length < BATCH) break;
  }
  if (total > 0) window.dispatchEvent(new CustomEvent(HISTORY_UPDATED_EVENT));
}

export function useUsageHistoryCollector() {
  const connected = useAuthStore((state) => state.connectionStatus === 'connected');
  const apiBase = useAuthStore((state) => state.apiBase);

  useEffect(() => {
    if (!connected || !apiBase || typeof indexedDB === 'undefined') return;
    let cancelled = false;
    const tick = () => {
      if (cancelled) return;
      const run = () => drain(apiBase).catch(() => undefined);
      if (navigator.locks) {
        void navigator.locks.request(
          `cliproxy-usage-collector:${apiBase}`,
          { ifAvailable: true },
          (lock) => (lock ? run() : undefined)
        );
      } else {
        void run();
      }
    };
    tick();
    const timer = window.setInterval(tick, POLL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [apiBase, connected]);
}
